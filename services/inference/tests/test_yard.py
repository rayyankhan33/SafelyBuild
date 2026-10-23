"""Tests for the synthetic yard generator, the yard_seg plugin and the evaluation maths (financial module, vision half)."""

import pathlib
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import evaluate_yard  # noqa: E402
import registry  # noqa: E402
import scene  # noqa: E402
from plugins import yard_seg  # noqa: E402
from service import app  # noqa: E402
from synth import yard  # noqa: E402

client = TestClient(app)


# ---------------------------------------------------------------- geometry: quantity <-> footprint
@pytest.mark.parametrize("cls,qty", [("sand_pile", 12.0), ("aggregate_pile", 30.0), ("cement_bags", 800.0), ("brick_stack", 9000.0), ("rebar_bundle", 4000.0)])
def test_quantity_and_footprint_are_inverse(cls, qty):
    assert yard.quantity_from_area(cls, yard.footprint_m2(cls, qty)) == pytest.approx(qty, rel=1e-6)


def test_generator_uses_the_same_formulas_as_the_classical_estimator():
    a = 20.0  # m2
    assert yard.quantity_from_area("sand_pile", a) == pytest.approx(scene.cone_volume_m3(a, scene.REPOSE_DEG["SAND"]))
    assert yard.quantity_from_area("cement_bags", a) == pytest.approx(a / scene.BAG_FACE_M2 * scene.BAG_LAYERS)


# ---------------------------------------------------------------- the generator
def test_scene_is_deterministic_per_seed():
    a, sa, ia = yard.render_scene(5)
    b, sb, ib = yard.render_scene(5)
    assert sa == sb and np.array_equal(a, b) and [i["quantity"] for i in ia] == [i["quantity"] for i in ib]
    c, _, _ = yard.render_scene(6)
    assert not np.array_equal(a, c)


def test_ground_truth_matches_the_drawn_footprint():
    """True quantity must equal the formula applied to the mask area the model is supposed to find."""
    checked = 0
    for seed in range(8):
        img, scale, items = yard.render_scene(seed)
        assert img.shape == (yard.H, yard.W, 3)
        for it in items:
            est = yard.quantity_from_area(it["class"], it["area_px"] * scale ** 2)
            assert est == pytest.approx(it["quantity"], rel=0.03), it["class"]
            assert all(0 <= x <= yard.W and 0 <= y <= yard.H for x, y in it["polygon"])
            checked += 1
    assert checked >= 5


def test_forced_classes_are_all_rendered():
    _, _, items = yard.render_scene(3, classes=["cement_bags", "brick_stack", "rebar_bundle", "sand_pile", "aggregate_pile"])
    assert {i["class"] for i in items} <= set(yard.CLASSES) and len(items) >= 3


def test_shifted_palette_differs_from_training_palette():
    rng = np.random.default_rng(0)
    p, q = yard.make_palette(rng, False), yard.make_palette(np.random.default_rng(0), True)
    assert p.ground != q.ground and p.gravel != q.gravel


def test_dataset_writer_makes_yolo_segmentation_files(tmp_path):
    cfg = yard.write_dataset(tmp_path, n_train=2, n_val=1, n_test=1, n_shift=1, workers=1, log=lambda *_: None)
    assert cfg.exists() and "sand_pile" in cfg.read_text()
    labels = list((tmp_path / "labels" / "train").glob("*.txt"))
    assert len(labels) == 2 and (tmp_path / "meta" / "test_shift").exists()
    for f in labels:
        for line in f.read_text().splitlines():
            parts = line.split()
            assert int(parts[0]) < len(yard.CLASSES) and len(parts) >= 7 and all(0 <= float(v) <= 1 for v in parts[1:])


# ---------------------------------------------------------------- evaluation maths
def test_summarise_reports_recall_precision_and_bias():
    rows = [(100.0, 110.0), (100.0, 90.0), (50.0, None), (None, 5.0), (None, None)]
    s = evaluate_yard.summarise(rows)
    assert s["frames_with_material"] == 3
    assert s["recall"] == pytest.approx(2 / 3, abs=0.001) and s["precision"] == pytest.approx(2 / 3, abs=0.001)
    assert s["median_abs_pct_error"] == 10.0 and s["mean_signed_pct_error"] == 0.0


# ---------------------------------------------------------------- plugin and registry
class _FakeResult:
    def __init__(self, polys, classes, confs):
        class M:
            xy = polys
        class B:
            cls = type("T", (), {"tolist": lambda s: classes})()
            conf = type("T", (), {"tolist": lambda s: confs})()
        self.masks, self.boxes = M(), B()


class _FakeModel:
    def __init__(self, result):
        self.result = result

    def predict(self, *a, **k):
        return [self.result]


def test_plugin_is_registered_but_not_active_by_default():
    info = client.get("/v1/backends").json()
    assert "yard_seg" in {b["name"] for b in info["backends"]}
    assert info["active"]["inventory"] == "classical_color"        # a plugin is never activated silently


def test_plugin_turns_masks_into_quantities_with_the_scene_formulas(monkeypatch):
    # a 100 x 100 px sand pile and a 40 x 20 px cement stack at 0.05 m/px
    sand = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], np.float32)
    bags = np.array([[0, 0], [40, 0], [40, 20], [0, 20]], np.float32)
    monkeypatch.setattr(yard_seg, "_load", lambda: _FakeModel(_FakeResult([sand, bags], [1, 0], [0.9, 0.8])))
    r = yard_seg.inventory(np.zeros((100, 100, 3), np.uint8), 0.05)
    by = {i["material_code"]: i for i in r["items"]}
    assert set(by) == {"SAND", "AGGREGATE", "CEMENT", "BRICK", "REBAR"} and r["backend"] == "yard_seg"
    assert by["SAND"]["quantity"] == pytest.approx(scene.cone_volume_m3(10000 * 0.05 ** 2, 34.0), abs=0.001)
    assert by["CEMENT"]["quantity"] == pytest.approx(800 * 0.05 ** 2 / 0.15 * 8, abs=0.001)
    assert by["AGGREGATE"]["quantity"] == 0 and by["AGGREGATE"]["confidence"] == 0.0
    assert by["SAND"]["confidence"] == pytest.approx(0.9)


def test_plugin_ignores_specks_and_requires_a_scale(monkeypatch):
    speck = np.array([[0, 0], [5, 0], [5, 5], [0, 5]], np.float32)
    monkeypatch.setattr(yard_seg, "_load", lambda: _FakeModel(_FakeResult([speck], [1], [0.99])))
    r = yard_seg.inventory(np.zeros((50, 50, 3), np.uint8), 0.05)
    assert all(i["quantity"] == 0 for i in r["items"])
    with pytest.raises(ValueError):
        yard_seg.inventory(np.zeros((50, 50, 3), np.uint8), 0)


def test_plugin_without_weights_is_501_and_default_is_unaffected(monkeypatch, tmp_path):
    monkeypatch.setattr(yard_seg, "WEIGHTS", tmp_path / "missing.pt")
    import cv2
    data = cv2.imencode(".png", np.full((120, 160, 3), 120, np.uint8))[1].tobytes()
    r = client.post("/v1/inventory?backend=yard_seg&scale_m_per_px=0.05", files={"image": ("a.png", data, "image/png")})
    assert r.status_code == 501 and "not available" in r.json()["detail"]
    d = client.post("/v1/inventory?scale_m_per_px=0.05", files={"image": ("a.png", data, "image/png")})
    assert d.status_code == 200 and d.json()["backend"] == "classical_color"
