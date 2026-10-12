"""Tests for the inference service. Run: .venv/Scripts/python -m pytest tests -v"""
import io
import pathlib
import sys

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pipeline  # noqa: E402
from service import app  # noqa: E402

SAMPLES = pathlib.Path(__file__).resolve().parents[1] / "samples"
client = TestClient(app)


def png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def solid(bgr, size=(300, 400)):
    return np.full((size[0], size[1], 3), bgr, dtype=np.uint8)


# ---- happy paths on the real sample photos used during the POC ------------------
def test_rusty_rebar_sample_is_flagged():
    data = (SAMPLES / "Rusted Rebar 2.jpg").read_bytes()
    r = pipeline.analyze_defects(data, backend="opencv_tiles")
    assert any(f["defect_type"] == "rusted_rebar" for f in r["findings"])
    assert r["backend"] == "opencv_tiles"
    assert 0 < r["coverage"] <= 1


def test_findings_are_sorted_and_well_formed():
    data = (SAMPLES / "Rusted Rebar.jfif").read_bytes()
    r = pipeline.analyze_defects(data, backend="opencv_tiles")
    scores = [f["score"] for f in r["findings"]]
    assert scores == sorted(scores, reverse=True)
    for f in r["findings"]:
        assert f["severity"] in ("Low", "Medium", "High", "Critical")
        x1, y1, x2, y2 = f["bbox"]
        assert x1 < x2 and y1 < y2


# ---- edge / failure cases -------------------------------------------------------
def test_clean_grey_wall_has_no_rust():
    grey = solid((150, 150, 150))
    r = pipeline.analyze_defects(png(grey), backend="opencv_tiles")
    assert not [f for f in r["findings"] if f["defect_type"] == "rusted_rebar"]


def test_pure_rust_colour_scores_critical():
    rust = solid((30, 80, 150))  # BGR orange-brown
    r = pipeline.analyze_defects(png(rust), backend="opencv_tiles")
    assert r["findings"][0]["defect_type"] == "rusted_rebar"
    assert r["findings"][0]["severity"] == "Critical"


def test_garbage_bytes_rejected():
    with pytest.raises(pipeline.ImageError):
        pipeline.decode_image(b"not an image at all")


def test_empty_bytes_rejected():
    with pytest.raises(pipeline.ImageError):
        pipeline.decode_image(b"")


def test_tiny_image_rejected():
    with pytest.raises(pipeline.ImageError):
        pipeline.decode_image(png(solid((1, 2, 3), size=(10, 10))))


def test_large_image_is_downscaled():
    big = solid((120, 120, 120), size=(3000, 4000))
    out = pipeline.decode_image(png(big))
    assert max(out.shape[:2]) == pipeline.MAX_SIDE_PX


def test_unknown_backend_rejected():
    with pytest.raises(ValueError):
        pipeline.analyze_defects(png(solid((1, 2, 3))), backend="nope")


# ---- activity -------------------------------------------------------------------
def test_identical_images_have_zero_change():
    img = png(cv2.imread(str(SAMPLES / "Rusted Rebar 2.jpg")))
    r = pipeline.activity_change(img, img)
    assert r["change_ratio"] == 0.0
    assert r["alignment_ok"] is True


def test_changed_scene_has_positive_change():
    rng = np.random.default_rng(0)
    a = (rng.random((240, 320, 3)) * 255).astype(np.uint8)
    b = a.copy()
    b[:, 160:] = 255 - b[:, 160:]  # half the frame changes
    r = pipeline.activity_change(png(a), png(b))
    assert r["change_ratio"] > 0.2


def test_brightness_shift_alone_is_not_activity():
    img = cv2.imread(str(SAMPLES / "Rusted Rebar 2.jpg"))
    brighter = cv2.convertScaleAbs(img, alpha=1.0, beta=40)
    r = pipeline.activity_change(png(img), png(brighter))
    assert r["change_ratio"] < 0.1


def test_different_view_flags_alignment():
    dark = solid((10, 10, 10))
    noisy = (np.random.default_rng(1).random((300, 400, 3)) * 255).astype(np.uint8)
    r = pipeline.activity_change(png(dark), png(noisy))
    assert r["alignment_ok"] is False


# ---- HTTP layer -----------------------------------------------------------------
def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_http_defects_ok():
    data = (SAMPLES / "Rusted Rebar 2.jpg").read_bytes()
    r = client.post("/v1/defects?backend=opencv_tiles", files={"image": ("a.jpg", data, "image/jpeg")})
    assert r.status_code == 200 and r.json()["findings"]


def test_http_defects_bad_image_422():
    r = client.post("/v1/defects", files={"image": ("a.jpg", b"xxxx", "image/jpeg")})
    assert r.status_code == 422


def test_http_defects_bad_params():
    data = png(solid((1, 2, 3)))
    assert client.post("/v1/defects?backend=zzz", files={"image": ("a.png", data, "image/png")}).status_code == 501  # unknown backend
    assert client.post("/v1/defects?backend=../x", files={"image": ("a.png", data, "image/png")}).status_code == 422  # malformed name
    assert client.post("/v1/defects?min_violation=Huge", files={"image": ("a.png", data, "image/png")}).status_code == 422


def test_http_yolo_unavailable_gives_501_not_500():
    if pipeline.yolo_available():
        pytest.skip("ultralytics installed")
    data = png(solid((1, 2, 3), size=(200, 200)))
    r = client.post("/v1/defects?backend=yolo_world", files={"image": ("a.png", data, "image/png")})
    assert r.status_code == 501


def test_http_activity():
    data = png(solid((100, 100, 100)))
    r = client.post("/v1/activity", files={"previous": ("a.png", data, "image/png"),
                                           "current": ("b.png", data, "image/png")})
    assert r.status_code == 200 and r.json()["change_ratio"] == 0.0
