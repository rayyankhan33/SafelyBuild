"""
scene.py - Classical (OpenCV) analysis of fixed-camera frames.

  analyze_stage      which construction stage is visible in a zone-camera frame
  estimate_inventory how much of each material is visible in a yard-camera frame

These are explainable colour/geometry methods. They are RELIABLE ONLY ON CALIBRATED, CONTROLLED
VIEWS (they are validated on synthetic scenes in tests/test_scene.py) and are expected to be much
less accurate on real, cluttered sites. The pretrained-model backend (yolo_scene.py) is the intended
path for real footage; accuracy on real photos has NOT been measured yet and is reported as such.

Every result carries `backend` and `reliability` so downstream code and the UI never overstate it.
"""

from __future__ import annotations

import math
from typing import Dict, List

import cv2
import numpy as np

# ------------------------------------------------------------------ colour classes (HSV, OpenCV scale H 0-179)
def _mask(hsv: np.ndarray, lo, hi) -> np.ndarray:
    return cv2.inRange(hsv, np.array(lo, dtype=np.uint8), np.array(hi, dtype=np.uint8))


def _clean(mask: np.ndarray, k: int = 3) -> np.ndarray:
    kernel = np.ones((k, k), np.uint8)
    return cv2.morphologyEx(cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel), cv2.MORPH_CLOSE, kernel)


CLASSES = {
    "soil": ((8, 90, 60), (16, 200, 170)),        # brown earth
    "formwork": ((17, 60, 175), (24, 160, 255)),  # plywood tan
    "sand": ((25, 60, 175), (34, 170, 255)),      # yellow sand
    "concrete": ((0, 0, 110), (179, 35, 190)),    # grey, unsaturated
    "gravel": ((0, 0, 55), (179, 60, 109)),       # darker grey (sensor noise raises saturation on dark pixels)
    "bag": ((0, 0, 215), (179, 25, 255)),         # near white
    "brick": ((0, 120, 90), (7, 255, 200)),       # red-brown
    "steel": ((0, 0, 0), (179, 255, 54)),         # very dark
}


def _fractions(img: np.ndarray) -> Dict[str, float]:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    total = img.shape[0] * img.shape[1]
    return {name: float(np.count_nonzero(_clean(_mask(hsv, lo, hi)))) / total for name, (lo, hi) in CLASSES.items()}


# ------------------------------------------------------------------ construction stage (zone cameras)
# Evidence that must be visible for each stage, highest stage first.
STAGE_EVIDENCE = {
    "footing": [("concrete", 4), ("formwork", 3), ("steel", 2), ("soil", 1)],
    "column": [("concrete", 3), ("formwork", 2), ("steel", 1)],
    "beam": [("concrete", 3), ("steel", 2), ("formwork", 1)],
    "slab": [("concrete", 3), ("steel", 2), ("formwork", 1)],
}
# minimum fraction of the frame an evidence class must cover to count (thin rebar lines cover little)
EVIDENCE_MIN = {"concrete": 0.08, "formwork": 0.03, "steel": 0.006, "soil": 0.08}
BRICK_FULL_WALL_FRACTION = 0.5  # fraction of the frame a finished wall fills in the calibrated view
CONCRETE_FULL_FRACTION = 0.25   # fraction of the frame a fully poured element fills in the calibrated view


def analyze_stage(img: np.ndarray, element_type: str) -> dict:
    fr = _fractions(img)
    base = {"backend": "classical_color", "reliability": "demo", "evidence": {k: round(v, 4) for k, v in fr.items()}}
    if element_type == "masonry_wall":
        frac = min(1.0, fr["brick"] / BRICK_FULL_WALL_FRACTION)
        return {**base, "stage": int(round(frac * 100)), "fraction": round(frac, 4)}
    plan = STAGE_EVIDENCE.get(element_type)
    if plan is None:
        raise ValueError(f"unsupported element type '{element_type}'")
    for cls, stage in plan:
        if fr[cls] >= EVIDENCE_MIN[cls]:
            # concrete is the last stage and is continuous: report how much of the element is covered (pour progress)
            fraction = round(min(1.0, fr[cls] / CONCRETE_FULL_FRACTION), 4) if cls == "concrete" else None
            return {**base, "stage": stage, "fraction": fraction}
    return {**base, "stage": 0, "fraction": None}


# ------------------------------------------------------------------ material stock (yard cameras)
# Geometry assumptions (documented, calibrate per site). Piles are modelled as cones.
REPOSE_DEG = {"SAND": 34.0, "AGGREGATE": 38.0}   # angle of repose
BAG_FACE_M2 = 0.15            # visible face of a 50 kg bag (0.5 m x 0.3 m)
BAG_LAYERS = 8                # bags stacked per visible face
BRICKS_PER_M2_FOOTPRINT = 600 # packed stack about 1.2 m high
REBAR_KG_PER_M2_FOOTPRINT = 600
MIN_BLOB_PX = 150             # ignore specks


def cone_volume_m3(area_m2: float, repose_deg: float) -> float:
    """Volume of a conical pile from its ground footprint: V = A^1.5 * tan(theta) / (3 * sqrt(pi))."""
    return (area_m2 ** 1.5) * math.tan(math.radians(repose_deg)) / (3.0 * math.sqrt(math.pi))


def _area_px(mask: np.ndarray) -> int:
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    return int(sum(s[cv2.CC_STAT_AREA] for s in stats[1:] if s[cv2.CC_STAT_AREA] >= MIN_BLOB_PX))


def estimate_inventory(img: np.ndarray, scale_m_per_px: float) -> dict:
    if not scale_m_per_px > 0:
        raise ValueError("scale_m_per_px must be positive")
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    px_m2 = scale_m_per_px ** 2
    areas = {name: _area_px(_clean(_mask(hsv, *CLASSES[name]), 5)) for name in ("sand", "gravel", "bag", "brick", "steel")}
    items: List[dict] = []

    def add(code, qty, unit, area_px, method):
        items.append({"material_code": code, "quantity": round(qty, 3), "unit": unit, "area_px": area_px, "method": method, "confidence": 0.5})

    add("SAND", cone_volume_m3(areas["sand"] * px_m2, REPOSE_DEG["SAND"]), "m3", areas["sand"], "cone volume from pile footprint")
    add("AGGREGATE", cone_volume_m3(areas["gravel"] * px_m2, REPOSE_DEG["AGGREGATE"]), "m3", areas["gravel"], "cone volume from pile footprint")
    add("CEMENT", areas["bag"] * px_m2 / BAG_FACE_M2 * BAG_LAYERS, "bag", areas["bag"], f"footprint / bag face x {BAG_LAYERS} layers")
    add("BRICK", areas["brick"] * px_m2 * BRICKS_PER_M2_FOOTPRINT, "nos", areas["brick"], f"footprint x {BRICKS_PER_M2_FOOTPRINT} per m2")
    add("REBAR", areas["steel"] * px_m2 * REBAR_KG_PER_M2_FOOTPRINT, "kg", areas["steel"], f"footprint x {REBAR_KG_PER_M2_FOOTPRINT} kg per m2")
    return {"backend": "classical_color", "reliability": "demo", "scale_m_per_px": scale_m_per_px, "items": items}
