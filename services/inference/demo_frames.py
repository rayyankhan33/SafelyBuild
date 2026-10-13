"""
demo_frames.py - SYNTHETIC camera frames for demonstrations and tests.

There are no real site photos for the demo project, so the demo generates drawn scenes whose
content follows the true (simulated) state of the site: which construction stage a zone is at,
how much material is in the yard. Those frames then go through the same ingest, analysis, roll-up
and forecasting code as real camera frames.

These are NOT real images. Results on them show that the pipeline works end to end and that the
classical methods recover the simulated truth; they say nothing about accuracy on real footage.
The service exposes this generator only when ENABLE_DEMO_FRAMES=1.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Dict, Optional

import cv2
import numpy as np

import scene

ZONE_SIZE = (640, 480)   # width, height
YARD_SIZE = (1280, 720)
ROI = (160, 120, 480, 360)  # element region in zone frames (x1, y1, x2, y2)


def _bgr(h: int, s: int, v: int):
    return tuple(int(c) for c in cv2.cvtColor(np.uint8([[[h, s, v]]]), cv2.COLOR_HSV2BGR)[0, 0])


COLORS = {
    "ground": _bgr(60, 100, 110),
    "soil": _bgr(12, 140, 120),
    "formwork": _bgr(20, 110, 215),
    "sand": _bgr(29, 115, 225),
    "concrete": _bgr(0, 10, 150),
    "gravel": _bgr(0, 10, 85),
    "bag": _bgr(0, 6, 240),
    "brick": _bgr(3, 170, 150),
    "steel": _bgr(0, 0, 30),
}

# evidence drawn for each stage (cumulative, concrete covers what is below it)
ZONE_EVIDENCE = {
    "footing": {1: ["soil"], 2: ["soil", "steel"], 3: ["soil", "steel", "formwork"], 4: ["concrete", "formwork"]},
    "column": {1: ["steel"], 2: ["steel", "formwork"], 3: ["concrete", "formwork"]},
    "beam": {1: ["formwork"], 2: ["formwork", "steel"], 3: ["concrete", "formwork"]},
    "slab": {1: ["formwork"], 2: ["formwork", "steel"], 3: ["concrete", "formwork"]},
}


def _finish(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    img = img.astype(np.float32) * rng.uniform(0.94, 1.06)           # lighting changes between frames
    img += rng.normal(0, 3.0, img.shape)                             # sensor noise
    return np.clip(img, 0, 255).astype(np.uint8)


def render_zone(element_type: str, stage: int = 0, fraction: Optional[float] = None, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    w, h = ZONE_SIZE
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = COLORS["ground"]
    x1, y1, x2, y2 = ROI
    if element_type == "masonry_wall":
        f = max(0.0, min(1.0, fraction or 0.0))
        wx1, wy1, wx2, wy2 = 80, 80, 560, 400
        top = int(wy2 - (wy2 - wy1) * f)
        if f > 0:
            img[top:wy2, wx1:wx2] = COLORS["brick"]
        return _finish(img, rng)
    stages = ZONE_EVIDENCE[element_type]
    last = max(stages)
    if stage == last:
        # concrete is being poured: draw what is underneath, then concrete over the poured share (bottom up)
        ev = [e for e in stages[last - 1] if e != "formwork"]
        coverage = 1.0 if fraction is None else max(0.0, min(1.0, fraction))
        pour_top = int(y2 - (y2 - y1) * coverage)
    else:
        ev = stages.get(stage, [])
        coverage, pour_top = 0.0, y2
    if "soil" in ev:
        img[y1:y2, x1:x2] = COLORS["soil"]
    if "steel" in ev:
        for x in range(x1 + 6, x2, 24):
            cv2.line(img, (x, y1), (x, y2), COLORS["steel"], 3)
        for y in range(y1 + 6, y2, 24):
            cv2.line(img, (x1, y), (x2, y), COLORS["steel"], 3)
    if stage == last and coverage > 0:
        img[pour_top:y2, x1:x2] = COLORS["concrete"]
    if stage == last or "formwork" in ev:
        cv2.rectangle(img, (x1 - 14, y1 - 14), (x2 + 14, y2 + 14), COLORS["formwork"], 14)
    return _finish(img, rng)


# ------------------------------------------------------------------ yard
def _area_for(code: str, qty: float) -> float:
    """Footprint (m2) that makes the classical estimator read `qty` (inverse of scene.estimate_inventory)."""
    if qty <= 0:
        return 0.0
    if code in ("SAND", "AGGREGATE"):
        t = math.tan(math.radians(scene.REPOSE_DEG[code]))
        return (qty * 3.0 * math.sqrt(math.pi) / t) ** (2.0 / 3.0)
    if code == "CEMENT":
        return qty / scene.BAG_LAYERS * scene.BAG_FACE_M2
    if code == "BRICK":
        return qty / scene.BRICKS_PER_M2_FOOTPRINT
    if code == "REBAR":
        return qty / scene.REBAR_KG_PER_M2_FOOTPRINT
    raise ValueError(code)


SLOTS = {  # (x, y, w, h) of the area each material may use in the yard frame
    "CEMENT": (620, 40, 600, 200),
    "BRICK": (620, 280, 600, 200),
    "REBAR": (620, 520, 600, 150),
    "SAND": (40, 60, 280, 280),
    "AGGREGATE": (330, 60, 280, 280),
}
CIRCLE_CENTER = {"SAND": (180, 200), "AGGREGATE": (470, 200)}
LAYER = {"CEMENT": "bag", "BRICK": "brick", "REBAR": "steel", "SAND": "sand", "AGGREGATE": "gravel"}


def _draw_blocks(img, slot, area_px, color):
    """Draw `area_px` pixels as a grid of equal rectangles inside slot, never overlapping."""
    if area_px < 1:
        return
    sx, sy, sw, sh = slot
    n = max(1, int(math.ceil(area_px / 2500)))
    per = area_px / n
    bw = int(max(8, math.sqrt(per * 1.6)))
    bh = int(max(6, per / bw))
    gap = 6
    cols = max(1, (sw + gap) // (bw + gap))
    drawn = 0
    for i in range(n):
        cx = sx + (i % cols) * (bw + gap)
        cy = sy + (i // cols) * (bh + gap)
        if cy + bh > sy + sh:
            break
        cv2.rectangle(img, (cx, cy), (cx + bw - 1, cy + bh - 1), color, -1)
        drawn += 1
    if drawn < n:
        raise ValueError("stock too large for the yard slot; use a smaller scale or fewer units")


def render_yard(stock: Dict[str, float], scale_m_per_px: float, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    w, h = YARD_SIZE
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = COLORS["ground"]
    px_per_m2 = 1.0 / (scale_m_per_px ** 2)
    for code, qty in stock.items():
        area_px = _area_for(code, float(qty)) * px_per_m2
        color = COLORS[LAYER[code]]
        if code in CIRCLE_CENTER:
            r = int(round(math.sqrt(area_px / math.pi)))
            if r > 135:
                raise ValueError(f"{code} pile too large for the frame")
            if r >= 1:
                cv2.circle(img, CIRCLE_CENTER[code], r, color, -1)
        else:
            _draw_blocks(img, SLOTS[code], area_px, color)
    return _finish(img, rng)


SAMPLES_DIR = Path(__file__).parent / "samples"


def render_sample(filename: str, seed: int = 0) -> np.ndarray:
    """A REAL sample photo (from samples/) with small brightness/noise changes so repeated frames differ."""
    allowed = {p.name for p in SAMPLES_DIR.iterdir() if p.is_file()}
    if filename not in allowed:
        raise ValueError(f"unknown sample '{filename}'")
    img = cv2.imdecode(np.fromfile(str(SAMPLES_DIR / filename), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("sample could not be decoded")
    return _finish(img, np.random.default_rng(seed))


def encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("could not encode frame")
    return buf.tobytes()
