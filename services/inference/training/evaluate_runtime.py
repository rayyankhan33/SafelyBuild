"""
evaluate_runtime.py - re-measure the crack model through the exact code path the service uses.

    python training/evaluate_runtime.py --data "<path>/SDNET2018" [--model models/crack_cnn.onnx] [--update-json]

training/train_cracks.py reports metrics from PyTorch. The service runs the exported ONNX file with
OpenCV and resizes with cv2.INTER_AREA, which differs slightly from torchvision's resize. This script
reports the numbers that matter in production: the same held-out test photographs (same seed, so
the same split), classified by crack_model.CrackModel.predict_patches. It also prints the metrics at
a few operating points so the threshold can be chosen for the use case (catch more cracks vs fewer
false alarms).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import cv2
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import crack_model  # noqa: E402
import sdnet  # noqa: E402
from train_cracks import confusion, metrics_at, roc_auc  # noqa: E402  (pure numpy helpers)


def threshold_for_specificity(y, p, target=0.95):
    """Smallest threshold whose specificity on (validation) data is at least `target`.

    Chosen for monitoring use: a camera sees mostly crack-free surface, so false alarms are what
    the engineers will notice. The rule is fixed in advance and uses validation photographs only;
    the test photographs are never used to pick it."""
    for t in np.linspace(0.05, 0.99, 95):
        tp, fp, tn, fn = confusion(y, p, t)
        if tn + fp and tn / (tn + fp) >= target:
            return float(t)
    return 0.99


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", default=str(crack_model.MODELS_DIR / "crack_cnn.onnx"))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--update-json", action="store_true", help="store the result as metrics_runtime in the model's json")
    args = ap.parse_args()

    model = crack_model.CrackModel(args.model)
    split = sdnet.split_by_photo(sdnet.index_sdnet(args.data), seed=args.seed)

    def probs(items):
        out = []
        for i in range(0, len(items), 64):
            out.append(model.predict_patches([cv2.imread(s.path, cv2.IMREAD_COLOR) for s in items[i:i + 64]]))
        return np.concatenate(out)

    yv = np.array([s.label for s in split["val"]]); pv = probs(split["val"])
    yt = np.array([s.label for s in split["test"]]); pt = probs(split["test"])
    thr = threshold_for_specificity(yv, pv, 0.95)
    result = {
        "note": "measured with OpenCV + cv2.INTER_AREA (the service's code path) on photographs never used for training",
        "threshold_rule": "smallest threshold with specificity >= 0.95 on the validation photographs",
        "threshold_from_validation": round(thr, 2),
        "val_auc": round(roc_auc(yv, pv), 4),
        "test_auc": round(roc_auc(yt, pt), 4),
        "test_at_validation_threshold": metrics_at(yt, pt, thr),
        "test_by_surface": {},
        "operating_points": {},
    }
    for surface in sdnet.SURFACES:
        idx = np.array([i for i, s in enumerate(split["test"]) if s.surface == surface])
        result["test_by_surface"][surface] = metrics_at(yt[idx], pt[idx], thr)
    for t in (0.3, 0.5, 0.7, 0.8, 0.9, 0.95):
        result["operating_points"][str(t)] = metrics_at(yt, pt, t)
    print(json.dumps(result, indent=2))
    if args.update_json:
        p = pathlib.Path(args.model).with_suffix(".json")
        meta = json.loads(p.read_text())
        meta["metrics_runtime"] = result
        meta["threshold"] = result["threshold_from_validation"]
        p.write_text(json.dumps(meta, indent=2))
        print(f"updated {p}")


if __name__ == "__main__":
    main()
