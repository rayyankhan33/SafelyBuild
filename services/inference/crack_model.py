"""
crack_model.py - concrete crack detection for site photos and CCTV frames.

The network (models/crack_cnn.onnx, trained by training/train_cracks.py on SDNET2018) classifies a
square patch as "contains a crack" or not. To find cracks in a full frame the frame is scanned with
overlapping square windows at several sizes; every window is classified, the window probabilities
are averaged per pixel into a heat map, and connected areas above the decision threshold become
crack regions (bounding box + score + severity).

Runs on OpenCV only (cv2.dnn reads the ONNX file); PyTorch is needed for training, not here.

Honest limits (measured numbers in docs/crack-model.md):
  * The network was trained only on close-up photographs (SDNET2018). A CCTV camera sees cracks much
    smaller in pixels, so only wide cracks, or a camera zoomed on the structure, are detectable.
  * On photographs unlike SDNET (stained, spalled or heavily textured concrete) it raises many false
    alarms. Fine-tune it with your own labelled site crops (training/train_cracks.py --site-data).
  * Severity reflects model confidence only, NOT crack width; width measurement needs calibrated
    imagery (Sprint 2).
"""

from __future__ import annotations

import json
import os
import pathlib
import threading
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

MODELS_DIR = pathlib.Path(__file__).resolve().parent / "models"
DEFECT_TYPE = "concrete_crack"
DEFAULT_SCALES = (256, 384, 512)   # window sizes in pixels of the analysed frame
DEFAULT_OVERLAP = 0.5
MAX_WINDOWS = 400                  # safety valve for very large frames / tiny strides
BATCH = 32


class ModelNotAvailable(ImportError):
    """The crack model file is missing or cannot be loaded (service maps this to HTTP 501)."""


@dataclass
class CrackRegion:
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    score: float                     # highest per-pixel probability inside the region
    mean_prob: float
    area_fraction: float             # share of the frame covered by the region
    severity: str = "Low"


@dataclass
class ScanResult:
    regions: List[CrackRegion]
    heat: np.ndarray                 # float32 HxW, per-pixel mean crack probability
    windows: int
    threshold: float
    scales: Tuple[int, ...]

    @property
    def max_probability(self) -> float:
        return float(self.heat.max()) if self.heat.size else 0.0


def classify_crack_severity(score: float) -> str:
    """
    Provisional severity from model confidence only (not crack width).
      score < 0.60            Low       (reported, not a violation at the default Medium threshold)
      0.60 <= score < 0.80    Medium
      score >= 0.80           High
    "Critical" is deliberately never returned: the model has no width measurement and its measured
    precision (docs/crack-model.md) does not justify the strongest alarm. Revisit once crack width
    can be measured from calibrated imagery.
    """
    if score >= 0.80:
        return "High"
    if score >= 0.60:
        return "Medium"
    return "Low"


def window_grid(h: int, w: int, size: int, overlap: float) -> List[Tuple[int, int]]:
    """Top-left corners of square windows that cover the whole frame, last row/column edge-aligned."""
    stride = max(16, int(size * (1.0 - overlap)))

    def axis(n: int) -> List[int]:
        if n <= size:
            return [0]
        pos = list(range(0, n - size + 1, stride))
        if pos[-1] != n - size:
            pos.append(n - size)
        return pos

    return [(x, y) for y in axis(h) for x in axis(w)]


class CrackModel:
    def __init__(self, onnx_path: os.PathLike, meta_path: Optional[os.PathLike] = None):
        onnx_path = pathlib.Path(onnx_path)
        if not onnx_path.is_file():
            raise ModelNotAvailable(f"crack model not found at {onnx_path} (train it: services/inference/training/train_cracks.py)")
        meta_path = pathlib.Path(meta_path) if meta_path else onnx_path.with_suffix(".json")
        self.meta = json.loads(meta_path.read_text()) if meta_path.is_file() else {}
        self.input_size = int(self.meta.get("input", {}).get("size", 224))
        self.threshold = float(self.meta.get("threshold", 0.5))
        try:
            self._net = cv2.dnn.readNetFromONNX(str(onnx_path))
        except cv2.error as e:  # pragma: no cover - corrupt file
            raise ModelNotAvailable(f"cannot load {onnx_path}: {e}") from e
        self._lock = threading.Lock()  # cv2.dnn nets are not thread-safe

    # ------------------------------------------------------------------ patches
    def predict_patches(self, patches: Sequence[np.ndarray]) -> np.ndarray:
        """BGR uint8 patches of any size -> crack probabilities, shape (N,)."""
        s = self.input_size
        out: List[np.ndarray] = []
        with self._lock:
            for i in range(0, len(patches), BATCH):
                chunk = [cv2.resize(p, (s, s), interpolation=cv2.INTER_AREA) for p in patches[i:i + BATCH]]
                blob = cv2.dnn.blobFromImages(chunk, scalefactor=1 / 255.0, size=(s, s), swapRB=True)
                self._net.setInput(blob)
                out.append(np.asarray(self._net.forward(), dtype=np.float32).reshape(-1))
        return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)

    # ------------------------------------------------------------------ frames
    def scan(self, img_bgr: np.ndarray, scales: Sequence[int] = DEFAULT_SCALES, overlap: float = DEFAULT_OVERLAP,
             threshold: Optional[float] = None) -> ScanResult:
        thr = self.threshold if threshold is None else float(threshold)
        h, w = img_bgr.shape[:2]
        sizes = sorted({int(s) for s in scales if int(s) <= min(h, w)})
        if not sizes:  # frame smaller than the smallest window: classify the whole frame as one window
            sizes = [min(h, w)]

        boxes: List[Tuple[int, int, int]] = []
        for size in sizes:
            boxes.extend((x, y, size) for x, y in window_grid(h, w, size, overlap))
        if len(boxes) > MAX_WINDOWS:  # thin out by coarser overlap rather than refuse
            boxes = []
            for size in sizes:
                boxes.extend((x, y, size) for x, y in window_grid(h, w, size, 0.0))
            boxes = boxes[:MAX_WINDOWS]

        probs = self.predict_patches([img_bgr[y:y + s, x:x + s] for x, y, s in boxes])

        total = np.zeros((h, w), dtype=np.float32)
        count = np.zeros((h, w), dtype=np.float32)
        for (x, y, s), p in zip(boxes, probs):
            total[y:y + s, x:x + s] += p
            count[y:y + s, x:x + s] += 1.0
        heat = total / np.maximum(count, 1.0)

        regions = self._regions(heat, thr, h * w)
        return ScanResult(regions, heat, len(boxes), thr, tuple(sizes))

    @staticmethod
    def _regions(heat: np.ndarray, thr: float, frame_area: int) -> List[CrackRegion]:
        mask = (heat >= thr).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        regions: List[CrackRegion] = []
        for i in range(1, n):
            x, y, bw, bh, area = (int(v) for v in stats[i])
            sel = labels[y:y + bh, x:x + bw] == i
            vals = heat[y:y + bh, x:x + bw][sel]
            score, mean = float(vals.max()), float(vals.mean())
            frac = area / frame_area
            regions.append(CrackRegion((x, y, x + bw, y + bh), round(score, 4), round(mean, 4), round(frac, 4),
                                       classify_crack_severity(score)))
        regions.sort(key=lambda r: r.score, reverse=True)
        return regions


# ---------------------------------------------------------------------------- shared instance
_lock = threading.Lock()
_cached: Optional[CrackModel] = None


def model_path() -> pathlib.Path:
    return pathlib.Path(os.environ.get("CRACK_MODEL_PATH", MODELS_DIR / "crack_cnn.onnx"))


def is_available() -> bool:
    return model_path().is_file()


def auto_enabled() -> bool:
    """Whether backend "auto" also runs the crack model. Set CRACK_DETECTION=off to switch it off
    (the explicit crack_cnn backend still works)."""
    return os.environ.get("CRACK_DETECTION", "on").strip().lower() not in ("off", "0", "false", "no")


def get_model() -> CrackModel:
    """Load once and share. Raises ModelNotAvailable if the file is missing."""
    global _cached
    with _lock:
        if _cached is None:
            _cached = CrackModel(model_path())
        return _cached
