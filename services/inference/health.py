"""
health.py - is this camera still looking at its scene? (tamper and fault screening)

A camera that is covered, defocused or turned away keeps sending frames, and those frames would still be
analysed as if they were evidence. These checks look at the frame itself and at the camera's recent frames:

  covered      the frame is almost uniform or black/white-out         (lens covered, lights out, sensor failure)
  blurred      much less fine detail than the camera's recent frames  (defocused or smeared lens)
  redirected   the edge structure no longer matches ANY recent frame  (camera knocked or turned to a different view)

All thresholds below are UNCALIBRATED starting values chosen on synthetic frames. A single flagged frame
means little (a worker in front of the lens, a lighting change); the API acts only on repeated flags.
Real-site calibration is a sprint-2 task that needs real footage.
"""

from __future__ import annotations

from typing import List, Optional

import cv2
import numpy as np

WIDTH = 320                    # analysis width in pixels
COVER_STD = 3.0                # grey-level standard deviation below this = uniform (a lens cap gives about 1-2; a plain wall about 5)
COVER_REF_STD = 8.0            # the camera's recent frames must have at least this much contrast for a flat frame to count as covered
COVER_MEAN_LOW = 12.0          # near black
COVER_MEAN_HIGH = 248.0        # near white
BLUR_RATIO = 0.25              # sharpness below this fraction of the recent median = blurred
BLUR_MIN_REF_SHARPNESS = 20.0  # only judge blur when the reference frames were actually sharp
MIN_STRUCTURE = 1.0            # mean gradient magnitude below this = too little structure to compare views
SAME_VIEW_MIN = 0.20           # best edge correlation with a recent frame below this = a different view


def _grey(img: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = g.shape[:2]
    return cv2.resize(g, (WIDTH, max(1, int(h * WIDTH / w))), interpolation=cv2.INTER_AREA)


def _sharpness(g: np.ndarray) -> float:
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def _grad(g: np.ndarray) -> np.ndarray:
    """Soft gradient-magnitude map: tolerant to small shifts and to lighting, so only real structural change lowers the correlation."""
    sm = cv2.GaussianBlur(g.astype(np.float32), (0, 0), 1.5)
    mag = cv2.magnitude(cv2.Sobel(sm, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(sm, cv2.CV_32F, 0, 1, ksize=3))
    return cv2.GaussianBlur(mag, (0, 0), 3.0)


def _structure(g: np.ndarray) -> float:
    """How much structure the frame has (mean gradient magnitude); flat frames cannot be compared."""
    return float(_grad(g).mean())


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 1e-9 else 0.0


def frame_health(img: np.ndarray, refs: Optional[List[np.ndarray]] = None) -> dict:
    """
    img   the new frame (BGR)
    refs  up to a few earlier frames of the SAME camera (BGR), newest first. May be empty.
    Returns {"metrics": {...}, "flags": [...]} with flags drawn from covered | blurred | redirected.
    """
    g = _grey(img)
    mean, std = float(g.mean()), float(g.std())
    sharp = _sharpness(g)
    metrics = {"mean": round(mean, 1), "std": round(std, 1), "sharpness": round(sharp, 1), "refs": 0}
    flags: List[str] = []

    refs = refs or []
    rg = [_grey(r) for r in refs]
    metrics["refs"] = len(rg)
    # Black or white-out frames are always a fault. A merely UNIFORM frame is only suspicious if this camera used to see
    # a scene with detail: an empty, flat plot is uniform too, and must not be mistaken for a covered lens.
    previously_detailed = bool(rg) and float(np.median([x.std() for x in rg])) >= COVER_REF_STD
    if mean < COVER_MEAN_LOW or mean > COVER_MEAN_HIGH or (std < COVER_STD and previously_detailed):
        flags.append("covered")

    if rg and "covered" not in flags:
        ref_sharp = float(np.median([_sharpness(x) for x in rg]))
        metrics["ref_sharpness"] = round(ref_sharp, 1)
        if previously_detailed and ref_sharp >= BLUR_MIN_REF_SHARPNESS and sharp < BLUR_RATIO * ref_sharp:
            flags.append("blurred")
        elif _structure(g) >= MIN_STRUCTURE:
            e = _grad(g)
            sims = [_ncc(e, cv2.resize(_grad(x), (e.shape[1], e.shape[0]))) for x in rg if _structure(x) >= MIN_STRUCTURE]
            if sims:
                metrics["best_view_match"] = round(max(sims), 3)
                if max(sims) < SAME_VIEW_MIN:
                    flags.append("redirected")
    return {"metrics": metrics, "flags": flags}
