"""
yolo_scene.py - Pretrained zero-shot backend (YOLO-World) for stage and stock estimation.

Uses a pretrained open-vocabulary detector prompted with text ("fresh concrete", "cement bag"...).
No training happened here. Its accuracy on real construction footage is UNMEASURED: results carry
`reliability: "unvalidated"`. Measure it on labelled site photos before trusting any number
(see docs/test-plan.md, section on accuracy).

The model weights are NOT bundled and are never downloaded automatically. Put the file at
services/inference/models/yolov8s-worldv2.pt (or set YOLO_WORLD_WEIGHTS). `available()` is False
until it exists, and the service falls back to the classical backend.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List

import numpy as np

import scene

WEIGHTS = Path(os.environ.get("YOLO_WORLD_WEIGHTS", Path(__file__).parent / "models" / "yolov8s-worldv2.pt"))
CONF = float(os.environ.get("YOLO_WORLD_CONF", "0.20"))

STAGE_PROMPTS = {
    "soil": ["excavation pit", "bare soil trench"],
    "steel": ["steel reinforcement bars", "rebar cage", "rebar mesh"],
    "formwork": ["plywood formwork", "timber shuttering"],
    "concrete": ["fresh poured concrete", "concrete slab", "concrete column"],
    "brick": ["brick wall"],
}
YARD_PROMPTS = {
    "bag": ["cement bag"],
    "sand": ["pile of sand"],
    "gravel": ["pile of gravel", "pile of crushed stone"],
    "brick": ["stack of bricks"],
    "steel": ["bundle of steel rebar"],
}
PILE_FILL = 0.6          # share of a pile's bounding box that is actually pile
HIDDEN_BAG_FACTOR = 3.0  # bags behind the visible face (assumption)

_model = None
_prompts_set: tuple = ()


def available() -> bool:
    """Cheap check (no heavy import): the package is installed and the weights file exists."""
    import importlib.util
    return importlib.util.find_spec("ultralytics") is not None and WEIGHTS.exists()


def _load(prompts: List[str]):
    global _model, _prompts_set
    if not WEIGHTS.exists():
        raise ImportError(f"YOLO-World weights not found at {WEIGHTS}")
    from ultralytics import YOLOWorld  # lazy: heavy import
    if _model is None:
        _model = YOLOWorld(str(WEIGHTS))
    if tuple(prompts) != _prompts_set:  # encoding the text prompts is slow: only redo it when they change
        _model.set_classes(prompts)
        _prompts_set = tuple(prompts)
    return _model


def _detect(img: np.ndarray, prompt_map: Dict[str, List[str]]) -> Dict[str, List[tuple]]:
    prompts = [p for ps in prompt_map.values() for p in ps]
    model = _load(prompts)
    res = model.predict(img, conf=CONF, verbose=False)[0]
    owner = {p: k for k, ps in prompt_map.items() for p in ps}
    out: Dict[str, List[tuple]] = {k: [] for k in prompt_map}
    for box, cls, conf in zip(res.boxes.xyxy.tolist(), res.boxes.cls.tolist(), res.boxes.conf.tolist()):
        out[owner[prompts[int(cls)]]].append((*box, conf))
    return out


def _coverage(boxes: List[tuple], shape) -> float:
    mask = np.zeros(shape[:2], np.uint8)
    for x1, y1, x2, y2, _ in boxes:
        mask[int(y1):int(y2), int(x1):int(x2)] = 1
    return float(mask.mean())


def analyze_stage(img: np.ndarray, element_type: str) -> dict:
    det = _detect(img, STAGE_PROMPTS)
    fr = {k: _coverage(v, img.shape) for k, v in det.items()}
    base = {"backend": "yolo_world", "reliability": "unvalidated", "evidence": {k: round(v, 4) for k, v in fr.items()}}
    if element_type == "masonry_wall":
        frac = min(1.0, fr["brick"] / scene.BRICK_FULL_WALL_FRACTION)
        return {**base, "stage": int(round(frac * 100)), "fraction": round(frac, 4)}
    plan = scene.STAGE_EVIDENCE.get(element_type)
    if plan is None:
        raise ValueError(f"unsupported element type '{element_type}'")
    for cls, stage in plan:
        if fr[cls] >= 0.03:
            fraction = round(min(1.0, fr[cls] / scene.CONCRETE_FULL_FRACTION), 4) if cls == "concrete" else None
            return {**base, "stage": stage, "fraction": fraction}
    return {**base, "stage": 0, "fraction": None}


def estimate_inventory(img: np.ndarray, scale_m_per_px: float) -> dict:
    if not scale_m_per_px > 0:
        raise ValueError("scale_m_per_px must be positive")
    det = _detect(img, YARD_PROMPTS)
    px_m2 = scale_m_per_px ** 2
    box_area = lambda boxes: sum((x2 - x1) * (y2 - y1) for x1, y1, x2, y2, _ in boxes)
    conf = lambda boxes: round(float(np.mean([b[4] for b in boxes])), 3) if boxes else 0.0
    items = []

    def add(code, qty, unit, boxes, method):
        items.append({"material_code": code, "quantity": round(qty, 3), "unit": unit, "area_px": int(box_area(boxes)),
                      "method": method, "confidence": conf(boxes)})

    add("SAND", scene.cone_volume_m3(box_area(det["sand"]) * PILE_FILL * px_m2, scene.REPOSE_DEG["SAND"]), "m3", det["sand"], "yolo-world box x fill, cone volume")
    add("AGGREGATE", scene.cone_volume_m3(box_area(det["gravel"]) * PILE_FILL * px_m2, scene.REPOSE_DEG["AGGREGATE"]), "m3", det["gravel"], "yolo-world box x fill, cone volume")
    add("CEMENT", len(det["bag"]) * HIDDEN_BAG_FACTOR, "bag", det["bag"], f"detected bags x {HIDDEN_BAG_FACTOR} hidden factor")
    add("BRICK", box_area(det["brick"]) * PILE_FILL * px_m2 * scene.BRICKS_PER_M2_FOOTPRINT, "nos", det["brick"], "yolo-world box x fill x bricks per m2")
    add("REBAR", box_area(det["steel"]) * PILE_FILL * px_m2 * scene.REBAR_KG_PER_M2_FOOTPRINT, "kg", det["steel"], "yolo-world box x fill x kg per m2")
    return {"backend": "yolo_world", "reliability": "unvalidated", "scale_m_per_px": scale_m_per_px, "items": items}
