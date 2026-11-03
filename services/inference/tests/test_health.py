"""Camera tamper and fault screening (TC-INF-HEALTH). Thresholds are uncalibrated; these tests pin the behaviour on synthetic frames."""

import pathlib
import sys

import cv2
import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import demo_frames  # noqa: E402
import health  # noqa: E402
from service import app  # noqa: E402
from synth import yard  # noqa: E402

client = TestClient(app)


def _scene(seed=5000, classes=("sand_pile", "cement_bags", "brick_stack")):
    return yard.render_scene(seed, False, list(classes))[0]


def _relit(img, seed):
    rng = np.random.default_rng(seed)
    return np.clip(img.astype(np.float32) * rng.uniform(0.8, 1.15) + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)


def test_same_view_with_lighting_change_is_healthy():
    base = _scene()
    refs = [_relit(base, i) for i in range(4)]
    r = health.frame_health(_relit(base, 99), refs)
    assert r["flags"] == [] and r["metrics"]["best_view_match"] > 0.9


def test_black_or_white_out_frames_are_covered_even_without_references():
    for img in (np.zeros((240, 320, 3), np.uint8), np.full((240, 320, 3), 255, np.uint8)):
        assert "covered" in health.frame_health(img)["flags"]


def test_a_uniform_frame_is_covered_only_if_the_camera_used_to_see_detail():
    grey = np.full((240, 320, 3), 120, np.uint8)
    refs = [_relit(_scene(), i) for i in range(3)]
    assert "covered" in health.frame_health(grey, refs)["flags"]                  # was a busy yard, now a flat grey cloth
    assert health.frame_health(grey, [])["flags"] == []                           # nothing to compare with: not claimed
    flat_refs = [np.clip(grey + np.random.default_rng(i).normal(0, 2, grey.shape), 0, 255).astype(np.uint8) for i in range(3)]
    assert health.frame_health(grey, flat_refs)["flags"] == []                    # an empty flat plot stays empty: not a fault


def test_blur_is_flagged_only_against_sharp_references():
    base = _scene()
    refs = [_relit(base, i) for i in range(3)]
    assert "blurred" in health.frame_health(cv2.GaussianBlur(base, (0, 0), 9), refs)["flags"]
    assert health.frame_health(cv2.GaussianBlur(base, (0, 0), 9), [])["flags"] == []          # nothing to compare with
    blurry_refs = [cv2.GaussianBlur(r, (0, 0), 9) for r in refs]
    assert "blurred" not in health.frame_health(cv2.GaussianBlur(base, (0, 0), 9), blurry_refs)["flags"]


def test_a_different_view_is_flagged_as_redirected():
    refs = [_relit(_scene(), i) for i in range(4)]
    other = _scene(9001, ("sand_pile", "rebar_bundle"))
    r = health.frame_health(other, refs)
    assert "redirected" in r["flags"] and r["metrics"]["best_view_match"] < health.SAME_VIEW_MIN


def test_legitimate_change_of_content_in_the_same_view_is_not_redirected():
    zone = [demo_frames.render_zone("slab", st, None, seed=i) for i, st in enumerate([1, 1, 2, 2, 3])]
    for i in range(1, 5):
        assert "redirected" not in health.frame_health(zone[i], zone[max(0, i - 4):i][::-1])["flags"]
    stock = [demo_frames.render_yard({"SAND": s, "CEMENT": c, "AGGREGATE": 30, "BRICK": 6000, "REBAR": 2000}, 0.1, seed=i)
             for i, (s, c) in enumerate([(40, 800), (30, 700), (20, 500), (12, 300)])]
    for i in range(1, 4):
        assert health.frame_health(stock[i], stock[:i][::-1])["flags"] == []


def test_featureless_frames_cannot_be_compared_so_redirection_is_not_claimed():
    flat = np.full((240, 320, 3), 100, np.uint8)
    noisy = np.clip(flat + np.random.default_rng(0).normal(0, 4, flat.shape), 0, 255).astype(np.uint8)
    assert "redirected" not in health.frame_health(noisy, [flat])["flags"]


def _png(img):
    return cv2.imencode(".png", img)[1].tobytes()


def test_http_endpoint_returns_metrics_and_flags():
    base = _scene()
    files = [("image", ("a.png", _png(cv2.GaussianBlur(base, (0, 0), 9)), "image/png"))] + \
            [("refs", (f"r{i}.png", _png(_relit(base, i)), "image/png")) for i in range(3)]
    r = client.post("/v1/health", files=files)
    assert r.status_code == 200, r.text
    assert "blurred" in r.json()["flags"] and r.json()["metrics"]["refs"] == 3


def test_http_endpoint_works_without_references_and_rejects_garbage():
    r = client.post("/v1/health", files={"image": ("a.png", _png(np.zeros((120, 160, 3), np.uint8)), "image/png")})
    assert r.status_code == 200 and r.json()["flags"] == ["covered"]  # black frame
    assert client.post("/v1/health", files={"image": ("a.png", b"not an image", "image/png")}).status_code == 422
