"""Tests for classical stage and inventory analysis.

They use SYNTHETIC frames (demo_frames.py): they prove the method recovers a known simulated state,
not that it works on real footage (see scene.py docstring)."""
import pathlib
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import demo_frames as df  # noqa: E402
import scene  # noqa: E402


# ---- stage detection
@pytest.mark.parametrize("etype,stages", [("footing", [0, 1, 2, 3, 4]), ("column", [0, 1, 2, 3]), ("beam", [0, 1, 2, 3]), ("slab", [0, 1, 2, 3])])
def test_each_stage_is_recovered(etype, stages):
    for stage in stages:
        for seed in range(3):  # different lighting and noise
            img = df.render_zone(etype, stage, seed=seed)
            r = scene.analyze_stage(img, etype)
            assert r["stage"] == stage, f"{etype} stage {stage} seed {seed} read as {r['stage']} {r['evidence']}"
            assert r["backend"] == "classical_color" and r["reliability"] == "demo"


@pytest.mark.parametrize("etype,last", [("footing", 4), ("column", 3), ("beam", 3), ("slab", 3)])
@pytest.mark.parametrize("coverage", [0.4, 0.6, 0.8, 1.0])
def test_pour_coverage_is_recovered(etype, last, coverage):
    r = scene.analyze_stage(df.render_zone(etype, last, coverage, seed=5), etype)
    assert r["stage"] == last
    assert abs(r["fraction"] - coverage) < 0.04, r


def test_a_barely_started_pour_reads_as_the_previous_stage():
    r = scene.analyze_stage(df.render_zone("slab", 3, 0.15, seed=2), "slab")
    assert r["stage"] == 2 and r["fraction"] is None


@pytest.mark.parametrize("f", [0.0, 0.25, 0.5, 0.8, 1.0])
def test_masonry_fraction_is_recovered(f):
    r = scene.analyze_stage(df.render_zone("masonry_wall", fraction=f, seed=1), "masonry_wall")
    assert abs(r["fraction"] - f) < 0.03


def test_empty_ground_is_stage_zero():
    assert scene.analyze_stage(df.render_zone("slab", 0), "slab")["stage"] == 0


def test_unsupported_element_type():
    with pytest.raises(ValueError):
        scene.analyze_stage(df.render_zone("slab", 1), "bridge")


# ---- inventory
def _rel_err(a, b):
    return abs(a - b) / b


@pytest.mark.parametrize("code,qty", [("SAND", 40.0), ("SAND", 120.0), ("AGGREGATE", 60.0), ("CEMENT", 600.0), ("BRICK", 15000.0), ("REBAR", 3000.0)])
def test_inventory_round_trip_within_tolerance(code, qty):
    errs = []
    for seed in range(3):
        img = df.render_yard({code: qty}, 0.1, seed=seed)
        items = {i["material_code"]: i for i in scene.estimate_inventory(img, 0.1)["items"]}
        errs.append(_rel_err(items[code]["quantity"], qty))
    assert max(errs) < 0.08, f"{code} {qty}: errors {errs}"


def test_all_materials_together_do_not_interfere():
    stock = {"SAND": 80.0, "AGGREGATE": 50.0, "CEMENT": 500.0, "BRICK": 12000.0, "REBAR": 2400.0}
    items = {i["material_code"]: i for i in scene.estimate_inventory(df.render_yard(stock, 0.1, seed=4), 0.1)["items"]}
    for code, qty in stock.items():
        assert _rel_err(items[code]["quantity"], qty) < 0.08, (code, items[code]["quantity"])


def test_empty_yard_reads_zero():
    items = scene.estimate_inventory(df.render_yard({}, 0.1), 0.1)["items"]
    assert all(i["quantity"] == 0 for i in items)


def test_smaller_pile_reads_smaller():
    a = {i["material_code"]: i["quantity"] for i in scene.estimate_inventory(df.render_yard({"SAND": 100.0}, 0.1, 1), 0.1)["items"]}
    b = {i["material_code"]: i["quantity"] for i in scene.estimate_inventory(df.render_yard({"SAND": 60.0}, 0.1, 1), 0.1)["items"]}
    assert b["SAND"] < a["SAND"]


def test_scale_must_be_positive():
    with pytest.raises(ValueError):
        scene.estimate_inventory(df.render_yard({}, 0.1), 0)


def test_cone_volume_formula():
    # a 6 m radius pile at 34 degrees: V = (1/3) pi r^2 h, h = r tan(theta)
    r = 6.0
    expected = (1 / 3) * np.pi * r * r * (r * np.tan(np.radians(34)))
    assert scene.cone_volume_m3(np.pi * r * r, 34) == pytest.approx(expected, rel=1e-6)


def test_oversized_stock_is_rejected_by_generator():
    with pytest.raises(ValueError):
        df.render_yard({"SAND": 5000.0}, 0.1)


# ---- HTTP endpoints (classical backend; demo frames enabled)
import os  # noqa: E402

os.environ["ENABLE_DEMO_FRAMES"] = "1"
os.environ.pop("BACKEND_STAGE", None)
from fastapi.testclient import TestClient  # noqa: E402
from service import app  # noqa: E402

client = TestClient(app)


def _png(img):
    return df.encode_png(img)


def test_http_stage_roundtrip():
    r = client.post("/v1/stage?element_type=column", files={"image": ("f.png", _png(df.render_zone("column", 2, seed=2)), "image/png")})
    assert r.status_code == 200 and r.json()["stage"] == 2


def test_http_stage_bad_element_type():
    r = client.post("/v1/stage?element_type=bridge", files={"image": ("f.png", _png(df.render_zone("slab", 1)), "image/png")})
    assert r.status_code == 422


def test_http_stage_garbage_image():
    r = client.post("/v1/stage?element_type=slab", files={"image": ("f.png", b"nope", "image/png")})
    assert r.status_code == 422


def test_http_inventory_roundtrip_and_validation():
    img = _png(df.render_yard({"SAND": 70.0}, 0.1, 3))
    r = client.post("/v1/inventory?scale_m_per_px=0.1", files={"image": ("f.png", img, "image/png")})
    sand = next(i for i in r.json()["items"] if i["material_code"] == "SAND")
    assert abs(sand["quantity"] - 70) / 70 < 0.08
    assert client.post("/v1/inventory?scale_m_per_px=0", files={"image": ("f.png", img, "image/png")}).status_code == 422
    assert client.post("/v1/inventory", files={"image": ("f.png", img, "image/png")}).status_code == 422  # scale is required


def test_http_demo_frame_endpoint():
    r = client.post("/v1/demo/frame", data={"kind": "zone", "params": '{"element_type":"slab","stage":3}', "seed": 1})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert client.post("/v1/demo/frame", data={"kind": "zone", "params": "{}"}).status_code == 422


def test_yolo_backend_unavailable_without_weights():
    import yolo_scene
    if yolo_scene.WEIGHTS.exists():
        pytest.skip("weights present")
    assert yolo_scene.available() is False
    r = client.post("/v1/stage?element_type=slab&backend=yolo_world", files={"image": ("f.png", _png(df.render_zone("slab", 1)), "image/png")})
    assert r.status_code in (501, 500)
