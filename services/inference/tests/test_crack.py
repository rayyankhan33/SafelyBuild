"""Tests for crack detection (crack_model.py, crack_video.py and the /v1/defects crack backend).

Most tests use a stub classifier so they do not depend on the trained weights; the tests that
load the real model are skipped when models/crack_cnn.onnx is absent.
"""
import io
import json
import pathlib
import sys

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import crack_model  # noqa: E402
import crack_video  # noqa: E402
import pipeline  # noqa: E402
from service import app  # noqa: E402

SAMPLES = pathlib.Path(__file__).resolve().parents[1] / "samples" / "cracks"
client = TestClient(app)
needs_model = pytest.mark.skipif(not crack_model.is_available(), reason="models/crack_cnn.onnx not trained/installed")


def png(img):
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


class StubModel(crack_model.CrackModel):
    """Classifier replaced by a rule: a patch containing a very dark pixel 'has a crack'."""

    def __init__(self, threshold=0.5):  # noqa: super().__init__ would need a model file
        self.input_size, self.threshold, self.meta = 224, threshold, {}

    def predict_patches(self, patches):
        return np.array([0.95 if p.min() < 40 else 0.03 for p in patches], dtype=np.float32)


def wall_with_crack(h=720, w=1280, x=700, y0=100, y1=520):
    img = np.full((h, w, 3), 170, dtype=np.uint8)
    cv2.line(img, (x, y0), (x + 30, y1), (10, 10, 10), 4)
    return img


# --------------------------------------------------------------------- geometry / severity
def test_window_grid_covers_frame_with_edge_aligned_last_window():
    h, w, size = 720, 1280, 256
    wins = crack_model.window_grid(h, w, size, 0.5)
    covered = np.zeros((h, w), bool)
    for x, y in wins:
        assert 0 <= x <= w - size and 0 <= y <= h - size
        covered[y:y + size, x:x + size] = True
    assert covered.all()


def test_window_grid_small_frame_gives_single_window():
    assert crack_model.window_grid(200, 200, 256, 0.5) == [(0, 0)]


@pytest.mark.parametrize("score,expected", [
    (0.55, "Low"), (0.60, "Medium"), (0.79, "Medium"), (0.80, "High"), (0.99, "High"), (1.0, "High"),
])
def test_crack_severity_bands_and_never_critical(score, expected):
    assert crack_model.classify_crack_severity(score) == expected


# --------------------------------------------------------------------- scanning with a stub
def test_scan_localises_a_dark_line_and_ignores_clean_wall():
    model = StubModel()
    res = model.scan(wall_with_crack())
    assert len(res.regions) >= 1
    top = res.regions[0]
    x1, y1, x2, y2 = top.bbox
    assert x1 <= 730 and x2 >= 700 and y1 <= 300 <= y2  # box contains the drawn crack
    assert top.score > 0.5 and 0 < top.area_fraction < 0.5
    clean = model.scan(np.full((720, 1280, 3), 170, np.uint8))
    assert clean.regions == [] and clean.max_probability < 0.1


def test_scan_small_image_falls_back_to_windows_the_size_of_the_short_side():
    img = np.full((200, 220, 3), 170, np.uint8)
    cv2.line(img, (20, 20), (150, 180), (0, 0, 0), 3)
    res = StubModel().scan(img)  # smaller than the smallest configured window (256)
    assert res.scales == (200,)
    assert len(res.regions) == 1 and res.regions[0].bbox == (0, 0, 220, 200)


def test_higher_threshold_removes_weak_regions():
    class Weak(StubModel):
        def predict_patches(self, patches):
            return np.array([0.55 if p.min() < 40 else 0.0 for p in patches], dtype=np.float32)

    img = wall_with_crack()
    assert Weak().scan(img, threshold=0.5).regions
    assert Weak().scan(img, threshold=0.7).regions == []


# --------------------------------------------------------------------- CCTV temporal logic
def heat_with_spot(shape=(100, 200), box=(40, 20, 80, 60), value=0.9):
    h = np.zeros(shape, np.float32)
    x1, y1, x2, y2 = box
    h[y1:y2, x1:x2] = value
    return h


def test_one_off_detection_is_not_confirmed():
    t = crack_video.CrackTracker((100, 200), 0.5, confirm=3)
    for i in range(2):
        regions, events = t.update(heat_with_spot(), time_s=i)
        assert regions == [] and events == []
    regions, events = t.update(np.zeros((100, 200), np.float32), time_s=2)  # vanished: streak resets
    assert events == []
    regions, events = t.update(heat_with_spot(), time_s=3)
    assert events == []


def test_persistent_detection_is_reported_once():
    t = crack_video.CrackTracker((100, 200), 0.5, confirm=3)
    seen = []
    for i in range(6):
        regions, events = t.update(heat_with_spot(), time_s=i * 2.0, frame_index=i * 50)
        seen.extend(events)
    assert len(seen) == 1
    assert seen[0].time_s == 4.0 and seen[0].frame_index == 100
    assert seen[0].severity in ("Low", "Medium", "High")
    # a second, separate crack elsewhere is a new event
    for i in range(3):
        _, events = t.update(heat_with_spot(box=(120, 20, 170, 70)) + heat_with_spot(), time_s=20 + i)
        seen.extend(events)
    assert len(seen) == 2


# --------------------------------------------------------------------- service integration
def test_pipeline_crack_backend_returns_crack_findings(monkeypatch):
    monkeypatch.setattr(crack_model, "get_model", lambda: StubModel())
    r = pipeline.analyze_defects(png(wall_with_crack()), backend="crack_cnn")
    assert r["backend"] == "crack_cnn"
    f = r["findings"][0]
    assert f["defect_type"] == "concrete_crack" and f["backend"] == "crack_cnn"
    assert 0.5 < f["score"] <= 1 and f["severity"] in ("Medium", "High")
    assert f["is_violation"] is True
    x1, y1, x2, y2 = f["bbox"]
    assert x1 < x2 and y1 < y2
    assert 0 < r["coverage"] <= 1


def test_auto_backend_adds_crack_cnn_only_when_model_is_installed(monkeypatch):
    monkeypatch.setattr(crack_model, "get_model", lambda: StubModel())
    monkeypatch.setattr(crack_model, "is_available", lambda: True)
    r = pipeline.analyze_defects(png(wall_with_crack()), backend="auto")
    assert r["backend"].endswith("+crack_cnn")
    assert any(f["defect_type"] == "concrete_crack" for f in r["findings"])
    monkeypatch.setattr(crack_model, "is_available", lambda: False)
    r = pipeline.analyze_defects(png(wall_with_crack()), backend="auto")
    assert "crack_cnn" not in r["backend"]


def test_http_crack_backend_and_health(monkeypatch):
    monkeypatch.setattr(crack_model, "get_model", lambda: StubModel())
    r = client.post("/v1/defects?backend=crack_cnn", files={"image": ("a.png", png(wall_with_crack()), "image/png")})
    assert r.status_code == 200 and r.json()["findings"][0]["defect_type"] == "concrete_crack"
    assert "crack_model_available" in client.get("/health").json()


def test_auto_backend_can_be_switched_off_with_env(monkeypatch):
    monkeypatch.setattr(crack_model, "get_model", lambda: StubModel())
    monkeypatch.setattr(crack_model, "is_available", lambda: True)
    monkeypatch.setenv("CRACK_DETECTION", "off")
    r = pipeline.analyze_defects(png(wall_with_crack()), backend="auto")
    assert "crack_cnn" not in r["backend"]
    # an explicit request still works
    assert pipeline.analyze_defects(png(wall_with_crack()), backend="crack_cnn")["findings"]


def test_crack_backend_without_model_file_is_501(monkeypatch, tmp_path):
    monkeypatch.setenv("CRACK_MODEL_PATH", str(tmp_path / "missing.onnx"))
    monkeypatch.setattr(crack_model, "_cached", None)
    r = client.post("/v1/defects?backend=crack_cnn", files={"image": ("a.png", png(wall_with_crack()), "image/png")})
    assert r.status_code == 501 and "crack model not found" in r.json()["detail"]
    monkeypatch.setattr(crack_model, "_cached", None)


def test_auto_backend_still_works_without_model_file(monkeypatch, tmp_path):
    monkeypatch.setenv("CRACK_MODEL_PATH", str(tmp_path / "missing.onnx"))
    r = client.post("/v1/defects", files={"image": ("a.png", png(wall_with_crack()), "image/png")})
    assert r.status_code == 200 and "crack_cnn" not in r.json()["backend"]


# --------------------------------------------------------------------- real trained model
@needs_model
def test_real_model_loads_and_outputs_probabilities():
    m = crack_model.get_model()
    assert 0.05 <= m.threshold <= 0.95 and m.input_size >= 64
    p = m.predict_patches([np.full((256, 256, 3), 128, np.uint8), np.zeros((300, 200, 3), np.uint8)])
    assert p.shape == (2,) and ((0 <= p) & (p <= 1)).all()


@needs_model
def test_real_model_separates_sample_sdnet_patches():
    """Samples are random held-out test patches (not cherry-picked): see samples/cracks/README.md."""
    m = crack_model.get_model()
    crack = [cv2.imread(str(p)) for p in sorted(SAMPLES.glob("cracked_*.jpg"))]
    clean = [cv2.imread(str(p)) for p in sorted(SAMPLES.glob("clean_*.jpg"))]
    assert crack and clean
    pc, pn = m.predict_patches(crack), m.predict_patches(clean)
    assert pc.mean() > pn.mean() + 0.3, (pc, pn)


@needs_model
def test_real_model_flags_cracked_patch_through_the_service():
    f = sorted(SAMPLES.glob("cracked_*.jpg"))[0]
    r = client.post("/v1/defects?backend=crack_cnn", files={"image": (f.name, f.read_bytes(), "image/jpeg")})
    assert r.status_code == 200
    assert r.json()["image_size"] == [256, 256]
