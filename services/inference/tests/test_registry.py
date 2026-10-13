"""Tests for the pluggable backend registry (how a trained model is added)."""
import json
import os
import pathlib
import sys
import textwrap

import pytest
from fastapi.testclient import TestClient

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import demo_frames as df  # noqa: E402
import registry  # noqa: E402
from service import app  # noqa: E402

client = TestClient(app)
PLUGINS = ROOT / "plugins"
ACTIVE = ROOT / "models" / "active.json"

PLUGIN_SRC = textwrap.dedent('''
    import registry

    def stage(img, element_type):
        return {"stage": 3, "fraction": None, "evidence": {"from": "plugin"}, "backend": "unit_test_model", "reliability": "unvalidated"}

    BACKEND = registry.Backend(
        name="unit_test_model", version="9.9.9", tasks={"stage": stage},
        available=lambda: AVAILABLE, info=lambda: {"weights_sha256": "abc", "trained_on": "unit test"})
    AVAILABLE = True
''')


@pytest.fixture
def plugin():
    path = PLUGINS / "zz_unit_test_model.py"
    path.write_text(PLUGIN_SRC, encoding="utf-8")
    registry.reload()
    yield path
    path.unlink(missing_ok=True)
    for k in ("BACKEND_STAGE", "BACKEND_INVENTORY", "BACKEND_DEFECTS"):
        os.environ.pop(k, None)
    if ACTIVE.exists() and ACTIVE.read_text().startswith("{\"test"):
        ACTIVE.unlink()
    sys.modules.pop("plugins.zz_unit_test_model", None)
    registry.reload()


def png(img):
    return df.encode_png(img)


def stage_request(**params):
    q = "&".join(f"{k}={v}" for k, v in {"element_type": "slab", **params}.items())
    return client.post(f"/v1/stage?{q}", files={"image": ("f.png", png(df.render_zone("slab", 2)), "image/png")})


def test_defaults_and_model_stamp():
    registry.reload()
    r = stage_request()
    assert r.status_code == 200
    m = r.json()["model"]
    assert m["backend"] == "classical_color" and m["version"] == "1" and m["source"] == "builtin" and m["reliability"] == "demo"


def test_health_and_backends_list_everything():
    h = client.get("/health").json()
    assert h["active"] == {"defects": "opencv_tiles", "stage": "classical_color", "inventory": "classical_color"}
    names = {b["name"] for b in h["backends"]}
    assert {"opencv_tiles", "classical_color", "yolo_world"} <= names
    assert client.get("/v1/backends").json()["active"]["stage"] == "classical_color"


def test_plugin_is_loaded_but_not_activated_silently(plugin):
    names = {b["name"]: b for b in client.get("/v1/backends").json()["backends"]}
    assert names["unit_test_model"]["source"] == "plugin" and names["unit_test_model"]["tasks"] == ["stage"]
    assert stage_request().json()["model"]["backend"] == "classical_color"  # still the configured default


def test_plugin_can_be_tried_explicitly_without_activating(plugin):
    r = stage_request(backend="unit_test_model")
    assert r.status_code == 200
    body = r.json()
    assert body["stage"] == 3 and body["model"]["version"] == "9.9.9" and body["model"]["weights_sha256"] == "abc"


def test_activation_by_environment(plugin):
    os.environ["BACKEND_STAGE"] = "unit_test_model"
    assert stage_request().json()["model"]["backend"] == "unit_test_model"


def test_activation_by_active_json(plugin):
    ACTIVE.parent.mkdir(exist_ok=True)
    ACTIVE.write_text(json.dumps({"test": 1, "stage": "unit_test_model"}), encoding="utf-8")
    assert stage_request().json()["model"]["backend"] == "unit_test_model"


def test_plugin_that_does_not_serve_a_task_is_refused(plugin):
    r = client.post("/v1/inventory?scale_m_per_px=0.1&backend=unit_test_model", files={"image": ("f.png", png(df.render_yard({}, 0.1)), "image/png")})
    assert r.status_code == 501 and "does not serve" in r.json()["detail"]


def test_unavailable_plugin_is_refused_not_crashed(plugin):
    import importlib
    mod = importlib.import_module("plugins.zz_unit_test_model")
    mod.AVAILABLE = False
    r = stage_request(backend="unit_test_model")
    assert r.status_code == 501 and "not available" in r.json()["detail"]


def test_unknown_backend_name():
    r = stage_request(backend="nope")
    assert r.status_code == 501 and "no backend named" in r.json()["detail"]


def test_backend_name_is_validated():
    assert stage_request(backend="../../etc").status_code == 422


def test_broken_plugin_fails_loudly():
    path = PLUGINS / "zz_broken.py"
    path.write_text("X = 1\n", encoding="utf-8")
    try:
        with pytest.raises(RuntimeError, match="must define BACKEND"):
            registry.reload()
    finally:
        path.unlink(missing_ok=True)
        sys.modules.pop("plugins.zz_broken", None)
        registry.reload()


def test_backend_with_unknown_task_is_rejected():
    with pytest.raises(ValueError, match="unknown tasks"):
        registry.register(registry.Backend("x", "1", {"segmentation": lambda *a: {}}))


def test_template_is_not_loaded():
    assert "my_model" not in {b["name"] for b in registry.describe()["backends"]}


def test_defects_result_is_stamped_too():
    img = png(df.render_zone("slab", 0))
    r = client.post("/v1/defects", files={"image": ("f.png", img, "image/png")})
    assert r.status_code == 200 and r.json()["model"]["backend"] == "opencv_tiles"


@pytest.mark.skipif(os.environ.get("RUN_YOLO_TESTS") != "1", reason="slow: loads about 380 MB of model files; set RUN_YOLO_TESTS=1")
def test_yolo_world_runs_when_installed_and_is_stamped_unvalidated():
    import yolo_scene
    if not yolo_scene.available():
        pytest.skip("YOLO-World weights or ultralytics not installed")
    r = stage_request(backend="yolo_world")
    assert r.status_code == 200
    m = r.json()["model"]
    assert m["backend"] == "yolo_world" and m["reliability"] == "unvalidated" and m["weights_sha256"]
    # being available must not make it the active backend
    assert client.get("/v1/backends").json()["active"]["stage"] == "classical_color"
