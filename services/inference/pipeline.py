"""
pipeline.py - Image analysis used by the FastAPI inference service.

Three analyses are exposed:

  * analyze_defects  - rusted rebar / honeycombed concrete (real, OpenCV heuristics
                       from the POC; optional YOLO-World localisation when installed)
  * activity_change  - how much a scene changed between two photos (real, OpenCV)
  * propose_materials- material counts from a photo (NOT implemented in Sprint 1;
                       see MaterialProvider)

Nothing here touches a database. The Node API owns persistence.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, asdict
from typing import List, Optional, Tuple

import cv2
import numpy as np

from heuristics import compute_honeycomb_score, compute_rust_score
from severity import classify_severity, is_violation

# A tile/ROI is reported as a defect only if its score reaches this value.
# Same constant the POC used (REPORT_THRESHOLD in poc_streamlit_app.py).
REPORT_THRESHOLD = 0.10
# Images larger than this (longest side, px) are downscaled before analysis so the
# heuristics (tuned on ~1000px images) behave consistently and requests stay fast.
MAX_SIDE_PX = 1280
TILE_GRID = 3  # 3x3 tiles for the OpenCV backend
MIN_IMAGE_SIDE_PX = 64


class ImageError(ValueError):
    """Raised when bytes cannot be decoded into a usable image."""


@dataclass
class DefectFinding:
    defect_type: str  # "rusted_rebar" | "honeycombed_concrete"
    score: float  # 0..1 from heuristics
    severity: str  # Low | Medium | High | Critical
    is_violation: bool
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2 in the analysed image
    confidence: Optional[float]  # detector confidence; None for the tile backend
    backend: str

    def to_dict(self) -> dict:
        d = asdict(self)
        d["bbox"] = list(self.bbox)
        return d


def decode_image(data: bytes) -> np.ndarray:
    """Decode bytes to a BGR image, downscaling if very large. Raises ImageError."""
    if not data:
        raise ImageError("empty file")
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ImageError("file is not a decodable image")
    h, w = img.shape[:2]
    if min(h, w) < MIN_IMAGE_SIDE_PX:
        raise ImageError(f"image too small ({w}x{h}); minimum side is {MIN_IMAGE_SIDE_PX}px")
    longest = max(h, w)
    if longest > MAX_SIDE_PX:
        scale = MAX_SIDE_PX / longest
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


# --------------------------------------------------------------------------- defects
def _score_roi(roi: np.ndarray) -> List[Tuple[str, float]]:
    """Run both heuristics on an ROI and return (defect_type, score) at/above threshold."""
    out = []
    rust = compute_rust_score(roi)
    honey = compute_honeycomb_score(roi)
    if rust >= REPORT_THRESHOLD:
        out.append(("rusted_rebar", rust))
    if honey >= REPORT_THRESHOLD:
        out.append(("honeycombed_concrete", honey))
    return out


def _tile_findings(img: np.ndarray, min_violation: str) -> List[DefectFinding]:
    h, w = img.shape[:2]
    findings: List[DefectFinding] = []
    for r in range(TILE_GRID):
        for c in range(TILE_GRID):
            y1, y2 = r * h // TILE_GRID, (r + 1) * h // TILE_GRID
            x1, x2 = c * w // TILE_GRID, (c + 1) * w // TILE_GRID
            roi = img[y1:y2, x1:x2]
            for dtype, score in _score_roi(roi):
                sev = classify_severity(score)
                findings.append(
                    DefectFinding(dtype, round(score, 4), sev, is_violation(sev, min_violation),
                                  (x1, y1, x2, y2), None, "opencv_tiles")
                )
    return findings


def _yolo_findings(img: np.ndarray, min_violation: str, conf: float) -> List[DefectFinding]:
    """YOLO-World localisation (POC detector). Imported lazily: needs ultralytics + torch."""
    from detector import detect_regions  # noqa: heavy import, optional dependency

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "frame.jpg")
        cv2.imwrite(path, img)
        detections = detect_regions(path, confidence_threshold=conf)
    findings: List[DefectFinding] = []
    for det in detections:
        if det.roi_image is None:
            continue
        for dtype, score in _score_roi(det.roi_image):
            sev = classify_severity(score)
            findings.append(
                DefectFinding(dtype, round(score, 4), sev, is_violation(sev, min_violation),
                              tuple(int(v) for v in det.bbox), round(float(det.confidence), 4), "yolo_world")
            )
    return findings


def yolo_available() -> bool:
    try:
        import ultralytics  # noqa: F401
        return True
    except Exception:
        return False


def analyze_defects(data: bytes, backend: str = "auto", min_violation: str = "Medium",
                    conf: float = 0.15) -> dict:
    """Return findings for one image. backend: auto | opencv_tiles | yolo_world."""
    img = decode_image(data)
    used = backend
    if backend == "auto":
        used = "yolo_world" if yolo_available() else "opencv_tiles"
    if used == "yolo_world":
        findings = _yolo_findings(img, min_violation, conf)
    elif used == "opencv_tiles":
        findings = _tile_findings(img, min_violation)
    else:
        raise ValueError(f"unknown backend '{backend}'")
    findings.sort(key=lambda f: f.score, reverse=True)
    h, w = img.shape[:2]
    return {
        "backend": used,
        "image_size": [w, h],
        "findings": [f.to_dict() for f in findings],
        # fraction of the frame covered by reported boxes (union approximated by tile mask)
        "coverage": _coverage(findings, w, h),
    }


def _coverage(findings: List[DefectFinding], w: int, h: int) -> float:
    if not findings:
        return 0.0
    mask = np.zeros((h, w), dtype=np.uint8)
    for f in findings:
        x1, y1, x2, y2 = f.bbox
        mask[y1:y2, x1:x2] = 1
    return round(float(mask.mean()), 4)


# ------------------------------------------------------------------ activity / change
def activity_change(prev_bytes: bytes, curr_bytes: bytes) -> dict:
    """
    Fraction of pixels that changed meaningfully between two photos of the same view.

    This is an *activity signal*, not a progress measurement: it goes up when work
    happens (new formwork, poured concrete, moved materials) but also with lighting
    or camera-angle changes. `alignment_ok` guards the worst case (different view).
    """
    a = decode_image(prev_bytes)
    b = decode_image(curr_bytes)
    size = (320, 240)
    ga = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(a, size), cv2.COLOR_BGR2GRAY), (5, 5), 0)
    gb = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(b, size), cv2.COLOR_BGR2GRAY), (5, 5), 0)
    # normalise brightness so a sunny vs cloudy day does not register as work
    ga = cv2.normalize(ga, None, 0, 255, cv2.NORM_MINMAX)
    gb = cv2.normalize(gb, None, 0, 255, cv2.NORM_MINMAX)
    diff = cv2.absdiff(ga, gb)
    _, mask = cv2.threshold(diff, 40, 255, cv2.THRESH_BINARY)
    change_ratio = float(mask.mean() / 255.0)
    # Histogram correlation of the two scenes: low => probably not the same viewpoint.
    ha = cv2.calcHist([ga], [0], None, [32], [0, 256])
    hb = cv2.calcHist([gb], [0], None, [32], [0, 256])
    cv2.normalize(ha, ha)
    cv2.normalize(hb, hb)
    similarity = float(cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL))
    return {
        "change_ratio": round(change_ratio, 4),
        "scene_similarity": round(similarity, 4),
        "alignment_ok": similarity >= 0.5,
    }


# ----------------------------------------------------------------------- materials
class MaterialProvider:
    """
    Sprint 1 limitation (disclosed in docs/tool-disclosure.md and the UI):
    there is no trained model that counts cement bags, sand piles or rebar bundles.

      * mode "none"      (default) -> returns no proposals; engineers enter quantities.
      * mode "simulated" (demo)    -> returns clearly flagged simulated proposals so the
                                      confirm/correct workflow can be demonstrated.
    """

    def __init__(self, mode: str = "none"):
        if mode not in ("none", "simulated"):
            raise ValueError("MATERIAL_PROVIDER must be 'none' or 'simulated'")
        self.mode = mode

    def propose(self, data: bytes) -> dict:
        decode_image(data)  # still validate the upload
        if self.mode == "none":
            return {"mode": "none", "simulated": False, "proposals": [],
                    "note": "No material-counting model in Sprint 1; enter quantities manually."}
        digest = int.from_bytes(data[:8].ljust(8, b"\0"), "big")
        proposals = [
            {"material_code": "CEMENT", "quantity": 20 + digest % 30, "unit": "bag", "confidence": 0.5},
            {"material_code": "SAND", "quantity": round(1.0 + (digest >> 8) % 40 / 10, 1), "unit": "m3", "confidence": 0.4},
        ]
        return {"mode": "simulated", "simulated": True, "proposals": proposals,
                "note": "SIMULATED values for UI demonstration only."}
