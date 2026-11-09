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
    ap.add_argument("--resume", action="store_true",
                    help="continue an interrupted run called --name from runs/<name>/weights/last.pt (all other settings come from that run)")
    ap.add_argument("--trained-on", default="synthetic yard scenes (synth/yard.py); NOT real photographs",
                    help="text stored in the metadata json: say what the training images really were")
    ap.add_argument("--no-install", action="store_true",
                    help="keep the result in runs/<name>/ and do NOT overwrite models/yard_seg.pt / yard_seg.json (use for candidates; install after measuring)")
    a = ap.parse_args()

    import torch
    torch.set_num_threads(2)
    from ultralytics import YOLO

    run_dir = HERE / "runs" / a.name
    last = run_dir / "weights" / "last.pt"
    t0 = time.time()
    if a.resume:
        # Ultralytics writes last.pt after every epoch (it holds the weights, optimizer and epoch counter), so an
        # interrupted run continues from the last finished epoch, not from the start.
        if not last.is_file():
            raise SystemExit(f"nothing to resume: {last} does not exist")
        YOLO(str(last)).train(resume=True)
    else:
        model = YOLO(a.base)
        model.train(
            data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, workers=a.workers, device="cpu", patience=a.patience,
            fraction=a.fraction, val=a.val, project=str(HERE / "runs"), name=a.name, exist_ok=True, pretrained=True, amp=False,
            # save_period=1 also keeps a numbered copy of every epoch (epoch1.pt, epoch2.pt ...): last.pt is rewritten each
            # epoch, so a kill at the wrong moment could damage it; the numbered files cannot be.
            save_period=1,
            flipud=0.5, fliplr=0.5, degrees=15, scale=0.3, mosaic=1.0, close_mosaic=3, plots=False, verbose=True,
        )
    best = run_dir / "weights" / "best.pt"
    if a.resume:
        # the settings of a resumed run are the ones stored in the checkpoint, not this command line's defaults
        args = torch.load(str(last), map_location="cpu", weights_only=False).get("train_args", {})
        a.epochs, a.imgsz, a.fraction = args.get("epochs", a.epochs), args.get("imgsz", a.imgsz), args.get("fraction", a.fraction)
    meta = {
        "name": "yard_seg", "base": "yolo11n-seg (COCO-pretrained, Ultralytics)", "classes": ["cement_bags", "sand_pile", "aggregate_pile", "brick_stack", "rebar_bundle"],
        "trained_on": a.trained_on, "epochs": a.epochs, "imgsz": a.imgsz, "train_fraction": a.fraction,
        "train_seconds": round(time.time() - t0), "weights_sha256": hashlib.sha256(best.read_bytes()).hexdigest(),
    }
    if a.no_install:
        (run_dir / "yard_seg.json").write_text(json.dumps(meta, indent=2))
        print(f"candidate kept in {best}; models/yard_seg.pt was not touched")
    else:
        out = HERE / "models/yard_seg.pt"
        shutil.copy(best, out)
        meta["weights_sha256"] = hashlib.sha256(out.read_bytes()).hexdigest()
        (HERE / "models/yard_seg.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
