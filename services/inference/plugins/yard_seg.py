"""
yard_seg - trained yard-camera material segmentation as an `inventory` backend (financial module).

A YOLO11-nano segmentation model fine-tuned in this repository (train_yard.py) finds cement-bag stacks,
sand and aggregate piles, brick stacks and rebar bundles in a yard-camera frame. Each instance mask is a
footprint; the footprint becomes a quantity with the same documented formulas as the classical method
(scene.py: cone volume for piles, bag face x layers, bricks and kg per m2 of footprint). Only the SEEING is
learned; the geometry assumptions are unchanged and still need calibrating on a real yard.

Weights: models/yard_seg.pt (+ yard_seg.json, yard_seg_eval.json). Trained on SYNTHETIC scenes only
(synth/yard.py), so reliability is "unvalidated" until it is measured on real photographs.

Try it without activating it:   POST /v1/inventory?backend=yard_seg
Activate it:                    BACKEND_INVENTORY=yard_seg   or   models/active.json {"inventory": "yard_seg"}
"""

import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

import registry

HERE = Path(__file__).resolve().parents[1]
WEIGHTS = HERE / "models" / "yard_seg.pt"
META = WEIGHTS.with_suffix(".json")
EVAL = HERE / "models" / "yard_seg_eval.json"
REAL_EVAL = HERE / "models" / "yard_seg_real_eval.json"      # written by evaluate_real.py
CONF = 0.25


def _imgsz() -> int:
    """Run at the size the model was trained at (recorded next to the weights)."""
    try:
        return int(json.loads(META.read_text()).get("imgsz", 640))
    except Exception:
        return 640


MIN_AREA_PX = 300          # ignore specks

CLASSES = ["cement_bags", "sand_pile", "aggregate_pile", "brick_stack", "rebar_bundle"]
CODE = {"cement_bags": "CEMENT", "sand_pile": "SAND", "aggregate_pile": "AGGREGATE", "brick_stack": "BRICK", "rebar_bundle": "REBAR"}
UNIT = {"CEMENT": "bag", "SAND": "m3", "AGGREGATE": "m3", "BRICK": "nos", "REBAR": "kg"}

_model = None


def _load():
    global _model
    if _model is None:
        from ultralytics import YOLO
        try:
            import yolo_scene
            yolo_scene._limit_threads()          # same CPU limit as the other model
        except Exception:
            pass
        _model = YOLO(str(WEIGHTS))
    return _model


def _quantity(cls: str, area_m2: float) -> float:
    import scene
    if cls in ("sand_pile", "aggregate_pile"):
        return scene.cone_volume_m3(area_m2, scene.REPOSE_DEG["SAND" if cls == "sand_pile" else "AGGREGATE"])
    if cls == "cement_bags":
        return area_m2 / scene.BAG_FACE_M2 * scene.BAG_LAYERS
    if cls == "brick_stack":
        return area_m2 * scene.BRICKS_PER_M2_FOOTPRINT
    return area_m2 * scene.REBAR_KG_PER_M2_FOOTPRINT


def inventory(img: np.ndarray, scale_m_per_px: float) -> dict:
    if not scale_m_per_px > 0:
        raise ValueError("scale_m_per_px must be positive")
    r = _load().predict(img, conf=CONF, imgsz=_imgsz(), device="cpu", verbose=False)[0]
    qty, area, conf = defaultdict(float), defaultdict(float), defaultdict(list)
    if r.masks is not None:
        for poly, c, s in zip(r.masks.xy, r.boxes.cls.tolist(), r.boxes.conf.tolist()):
            if len(poly) < 3:
                continue
            a = float(cv2.contourArea(np.asarray(poly, np.float32)))
            if a < MIN_AREA_PX:
                continue
            cls = CLASSES[int(c)]
            qty[CODE[cls]] += _quantity(cls, a * scale_m_per_px ** 2)
            area[CODE[cls]] += a
            conf[CODE[cls]].append(float(s))
    items = []
    for code in ("SAND", "AGGREGATE", "CEMENT", "BRICK", "REBAR"):      # same order and set as the classical backend
        items.append({"material_code": code, "quantity": round(qty.get(code, 0.0), 3), "unit": UNIT[code], "area_px": int(area.get(code, 0)),
                      "method": "instance mask footprint -> same geometry formula as scene.py",
                      "confidence": round(float(np.mean(conf[code])), 3) if conf.get(code) else 0.0})
    return {"backend": "yard_seg", "reliability": "unvalidated", "scale_m_per_px": scale_m_per_px, "items": items}


def _info() -> dict:
    meta = json.loads(META.read_text()) if META.is_file() else {}
    ev = json.loads(EVAL.read_text()) if EVAL.is_file() else {}
    real_eval = None
    if REAL_EVAL.is_file():
        raw = json.loads(REAL_EVAL.read_text())
        pile = raw.get("classes", {}).get("pile (sand + aggregate)", {})
        real_eval = {"datasets": list(raw.get("datasets", {})), "splits": raw.get("splits"), "weights_sha256": raw.get("weights_sha256"),
                     "pile_recall": pile.get("recall"), "pile_pooled_iou": pile.get("pooled_pixel_iou"), "classes": raw.get("classes")}
    return {
        "weights_sha256": registry.file_sha256(WEIGHTS),
        "base": meta.get("base"),
        "trained_on": meta.get("trained_on", "synthetic yard scenes (synth/yard.py)"),
        "metrics_synthetic": {k: v for k, v in ev.items() if k in ("test", "test_shift")} or None,
        "metrics_real_photos": real_eval or None,
        "known_issue": ("trained on synthetic scenes only" + (
            "; on real photographs of sand and gravel piles it found %s of them (evaluate_real.py): do not rely on it in the field"
            % ("{:.0%}".format(real_eval["pile_recall"])) if real_eval and real_eval.get("pile_recall") is not None
            else "; not yet measured on real yard photographs")),
    }


def _available() -> bool:
    import importlib.util
    return WEIGHTS.is_file() and importlib.util.find_spec("ultralytics") is not None


BACKEND = registry.Backend(
    name="yard_seg",
    version="0.1.0",                                    # bump on every retrain; stored with every result
    tasks={"inventory": inventory},
    available=_available,
    info=_info,
    reliability="unvalidated",
)
