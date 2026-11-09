"""
evaluate_real.py - score the yard model on REAL photographs that carry hand-drawn outlines.

  python evaluate_real.py --data data/yard_real/piles data/yard_real/site --weights models/yard_seg.pt

`evaluate_yard.py` scores the model on synthetic scenes where the true quantity is known. Real photographs have no
known quantity, only outlines, so this script measures how well the model SEES each footprint, which is the part the
model contributes (the footprint area feeds the geometry formulas in scene.py).

Per class and for the group `pile` (sand + aggregate merged, because the site photographs lump both under one label):
  * image-level recall / precision   (is the material found at all?)
  * pooled pixel IoU                 (overlap of predicted and true footprint over all frames)
  * median per-frame IoU             (frames where the material is present; a miss counts as 0)
  * median absolute footprint-area error % and the median pred/true area ratio (over- or under-measuring)

Honesty rules built in
  * A class is scored on a dataset only if that dataset LABELS it (read from its stats.json mapping). An unlabelled bag
    stack in a piles photograph is not a false alarm.
  * Only the split given by --splits is read (default `test`). Never evaluate on a split the model was trained on.
  * Real frames from other websites are not your camera: this is a recognition check, not a quantity check.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Callable, Dict, List, Sequence

import cv2
import numpy as np

HERE = Path(__file__).parent
CLASSES = ["cement_bags", "sand_pile", "aggregate_pile", "brick_stack", "rebar_bundle"]
PILE = ("sand_pile", "aggregate_pile")
PRESENT_MIN_FRACTION = 0.002            # a class counts as "found" when its predicted footprint is at least 0.2 % of the frame

Predictor = Callable[[np.ndarray], Dict[int, np.ndarray]]     # image -> {class index: boolean mask of the union of its instances}


def gt_masks(label_file: Path, height: int, width: int) -> Dict[int, np.ndarray]:
    """YOLO-seg label lines -> {class index: union mask}. Box lines (4 numbers) are ignored: they are not footprints."""
    out: Dict[int, np.ndarray] = {}
    if not label_file.exists():
        return out
    for line in label_file.read_text().splitlines():
        p = line.split()
        if len(p) < 7 or len(p) % 2 == 0:
            continue
        pts = (np.array(p[1:], float).reshape(-1, 2) * [width, height]).round().astype(np.int32)
        m = out.setdefault(int(p[0]), np.zeros((height, width), np.uint8))
        cv2.fillPoly(m, [pts], 1)
    return {k: v.astype(bool) for k, v in out.items()}


def labelled_classes(data_dir: Path) -> set:
    """Yard classes this built dataset actually labels (the values of the mapping in stats.json)."""
    st = json.loads((data_dir / "stats.json").read_text())
    return {c for c in st["mapping"].values() if c in CLASSES}


def make_predictor(weights: Path, conf: float = 0.25) -> Predictor:
    from ultralytics import YOLO
    from plugins import yard_seg
    model = YOLO(str(weights))
    imgsz = yard_seg._imgsz()

    def predict(img: np.ndarray) -> Dict[int, np.ndarray]:
        h, w = img.shape[:2]
        r = model.predict(img, conf=conf, imgsz=imgsz, device="cpu", verbose=False)[0]
        out: Dict[int, np.ndarray] = {}
        if r.masks is None:
            return out
        for poly, c in zip(r.masks.xy, r.boxes.cls.tolist()):
            if len(poly) < 3:
                continue
            m = out.setdefault(int(c), np.zeros((h, w), np.uint8))
            cv2.fillPoly(m, [np.round(np.asarray(poly)).astype(np.int32)], 1)
        return {k: v.astype(bool) for k, v in out.items()}
    return predict


class Tally:
    def __init__(self):
        self.frames = self.gt_present = self.tp = self.fp = self.fn = 0
        self.px_tp = self.px_fp = self.px_fn = 0
        self.ious: List[float] = []
        self.area_err: List[float] = []
        self.area_ratio: List[float] = []

    def add(self, gt: np.ndarray, pred: np.ndarray):
        self.frames += 1
        h, w = gt.shape
        g, p = int(gt.sum()), int(pred.sum())
        gt_here = g > 0
        pred_here = p >= PRESENT_MIN_FRACTION * h * w
        inter = int(np.logical_and(gt, pred).sum())
        self.px_tp += inter
        self.px_fp += p - inter
        self.px_fn += g - inter
        if gt_here:
            self.gt_present += 1
            union = g + p - inter
            self.ious.append(inter / union if union else 0.0)
            if pred_here:
                self.tp += 1
                self.area_err.append(abs(p - g) / g * 100)
                self.area_ratio.append(p / g)
            else:
                self.fn += 1
        elif pred_here:
            self.fp += 1

    def summary(self) -> dict:
        r = lambda x, n=3: None if x is None else round(float(x), n)
        union = self.px_tp + self.px_fp + self.px_fn
        return {
            "frames_scored": self.frames, "frames_with_material": self.gt_present,
            "recall": r(self.tp / self.gt_present) if self.gt_present else None,
            "precision": r(self.tp / (self.tp + self.fp)) if self.tp + self.fp else None,
            "pooled_pixel_iou": r(self.px_tp / union) if union else None,
            "median_frame_iou": r(np.median(self.ious)) if self.ious else None,
            "median_abs_area_error_pct": r(np.median(self.area_err), 1) if self.area_err else None,
            "median_pred_over_true_area": r(np.median(self.area_ratio)) if self.area_ratio else None,
        }


def evaluate(dirs: Sequence[Path], predict: Predictor, splits=("test",), limit=None, log=print) -> dict:
    tallies: Dict[str, Tally] = defaultdict(Tally)
    per_dir = {}
    for d in dirs:
        labelled = labelled_classes(d)
        n = 0
        for split in splits:
            for ip in sorted((d / "images" / split).glob("*.jpg"))[:limit]:
                img = cv2.imread(str(ip))
                if img is None:
                    continue
                h, w = img.shape[:2]
                gt = gt_masks(d / "labels" / split / f"{ip.stem}.txt", h, w)
                pred = predict(img)
                empty = np.zeros((h, w), bool)
                for ci, cls in enumerate(CLASSES):
                    if cls in labelled:
                        tallies[cls].add(gt.get(ci, empty), pred.get(ci, empty))
                if labelled & set(PILE):
                    g = empty.copy()
                    for cls in PILE:
                        if cls in labelled:
                            g |= gt.get(CLASSES.index(cls), empty)
                    pr = empty.copy()
                    for cls in PILE:
                        pr |= pred.get(CLASSES.index(cls), empty)
                    tallies["pile (sand + aggregate)"].add(g, pr)
                n += 1
        per_dir[d.name] = {"frames": n, "classes_labelled": sorted(labelled)}
    report = {"splits": list(splits), "datasets": per_dir,
              "classes": {k: v.summary() for k, v in tallies.items()}}
    log(f"\nreal-photo evaluation, splits {list(splits)}, datasets {list(per_dir)}")
    log(f'{"class":24} {"frames":>6} {"recall":>7} {"prec":>6} {"pooledIoU":>9} {"medIoU":>7} {"med|area err|%":>14} {"pred/true":>9}')
    for k, s in report["classes"].items():
        v = lambda x: "-" if x is None else x
        log(f'{k:24} {s["frames_with_material"]:>6} {v(s["recall"]):>7} {v(s["precision"]):>6} {v(s["pooled_pixel_iou"]):>9} '
            f'{v(s["median_frame_iou"]):>7} {v(s["median_abs_area_error_pct"]):>14} {v(s["median_pred_over_true_area"]):>9}')
    unscored = [c for c in CLASSES if c not in tallies]
    if unscored:
        log(f"no real labelled frames for: {', '.join(unscored)}")
        report["classes_without_real_frames"] = unscored
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", nargs="+", required=True, help="built dataset folders (images/<split>, labels/<split>, stats.json)")
    ap.add_argument("--weights", default=str(HERE / "models/yard_seg.pt"))
    ap.add_argument("--splits", nargs="+", default=["test"])
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=str(HERE / "models/yard_seg_real_eval.json"))
    a = ap.parse_args()
    import registry
    rep = evaluate([Path(d) for d in a.data], make_predictor(Path(a.weights), a.conf), tuple(a.splits), a.limit)
    rep["weights"] = str(Path(a.weights).name)
    rep["weights_sha256"] = registry.file_sha256(Path(a.weights))
    rep["conf"] = a.conf
    Path(a.out).write_text(json.dumps(rep, indent=2))
    print("\nwritten", a.out)
