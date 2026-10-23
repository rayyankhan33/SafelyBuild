"""
train_yard.py - fine-tune a pretrained YOLO11 segmentation model on the yard dataset.

  python train_yard.py --data data/yard/yard.yaml --epochs 30 --imgsz 640

The result is copied to models/yard_seg.pt together with models/yard_seg.json (what it was trained on,
when, with which settings). Nothing here activates the model: the registry only uses it when you choose
it (docs/model-integration.md).

Fine-tuning, not training from scratch: the COCO-pretrained weights already know edges, textures and
blobs; only the five yard classes and the pile/stack shapes have to be learned.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data/yard/yard.yaml"))
    ap.add_argument("--base", default=str(HERE / "models/yolo11n-seg.pt"))
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--fraction", type=float, default=1.0, help="share of the training images to use (CPU-only machines)")
    ap.add_argument("--val", action="store_true", help="validate after every epoch (slow on CPU)")
    ap.add_argument("--name", default="yard_seg")
    a = ap.parse_args()

    import torch
    torch.set_num_threads(2)
    from ultralytics import YOLO

    t0 = time.time()
    model = YOLO(a.base)
    model.train(
        data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, workers=a.workers, device="cpu", patience=a.patience,
        fraction=a.fraction, val=a.val, project=str(HERE / "runs"), name=a.name, exist_ok=True, pretrained=True, amp=False,
        flipud=0.5, fliplr=0.5, degrees=15, scale=0.3, mosaic=1.0, close_mosaic=3, plots=False, verbose=True,
    )
    best = HERE / "runs" / a.name / "weights" / "best.pt"
    out = HERE / "models/yard_seg.pt"
    shutil.copy(best, out)
    meta = {
        "name": "yard_seg", "base": "yolo11n-seg (COCO-pretrained, Ultralytics)", "classes": ["cement_bags", "sand_pile", "aggregate_pile", "brick_stack", "rebar_bundle"],
        "trained_on": "synthetic yard scenes (synth/yard.py); NOT real photographs", "epochs": a.epochs, "imgsz": a.imgsz, "train_fraction": a.fraction,
        "train_seconds": round(time.time() - t0), "weights_sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
    }
    (HERE / "models/yard_seg.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
