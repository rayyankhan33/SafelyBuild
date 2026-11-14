"""
train_defects.py - fine-tune a pretrained YOLO11 *detection* model on the CODEBRIM platform dataset.

  python training/train_defects.py --data data/codebrim_platform/data.yaml --epochs 25 --imgsz 640

Classes (see build_codebrim_yolo.py): concrete_crack, rusted_rebar, spalling. The dataset's own `test`
split is never used for training or for choosing a checkpoint; evaluate it afterwards (evaluate_defects.py).

Built for a slow CPU that may be interrupted:
  - a numbered snapshot of every epoch (epoch1.pt, epoch2.pt ...) plus last.pt, in runs/<name>/weights;
  - `--resume` continues an interrupted run from the last finished epoch with its original settings;
  - nothing is installed: the result stays in runs/<name>/ (best.pt chosen on the validation split) together
    with defects_det.json, which says what it was trained on. Copy it into models/ yourself after measuring.

Start weights: models/yolo11n.pt (COCO-pretrained detector, Ultralytics).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data/codebrim_platform/data.yaml"))
    ap.add_argument("--base", default=str(HERE / "models/yolo11n.pt"))
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument("--fraction", type=float, default=1.0, help="share of the training images to use (smoke tests)")
    ap.add_argument("--name", default="defects_det")
    ap.add_argument("--resume", action="store_true", help="continue the interrupted run called --name from runs/<name>/weights/last.pt")
    ap.add_argument("--trained-on", default="CODEBRIM (Mundt et al., CC BY 4.0) bridge photographs, platform scheme: crack -> concrete_crack; "
                    "corrosion_stain + exposed_bars -> rusted_rebar (ASSUMPTION, engineer to confirm); spallation -> spalling; efflorescence unlabelled; "
                    "dataset's own train split only, val split picks the checkpoint, test split untouched")
    a = ap.parse_args()

    import torch
    torch.set_num_threads(2)
    from ultralytics import YOLO

    run_dir = HERE / "runs" / a.name
    last = run_dir / "weights" / "last.pt"
    t0 = time.time()
    if a.resume:
        if not last.is_file():
            raise SystemExit(f"nothing to resume: {last} does not exist")
        YOLO(str(last)).train(resume=True)
    else:
        if not Path(a.base).is_file():
            raise SystemExit(f"start weights not found: {a.base}")
        YOLO(a.base).train(
            data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, workers=a.workers, device="cpu", patience=a.patience,
            fraction=a.fraction, val=True, project=str(HERE / "runs"), name=a.name, exist_ok=True, pretrained=True, amp=False,
            save_period=1,                                   # numbered snapshot of every epoch (last.pt is rewritten each epoch)
            flipud=0.0, fliplr=0.5, degrees=0.0, scale=0.3, mosaic=1.0, close_mosaic=3, plots=False, verbose=True,
        )
    best = run_dir / "weights" / "best.pt"
    args = {}
    if a.resume:
        args = torch.load(str(last), map_location="cpu", weights_only=False).get("train_args", {})
    meta = {
        "name": "defects_det", "base": "yolo11n (COCO-pretrained detector, Ultralytics)", "classes": ["concrete_crack", "rusted_rebar", "spalling"],
        "trained_on": a.trained_on, "epochs": args.get("epochs", a.epochs), "imgsz": args.get("imgsz", a.imgsz), "batch": args.get("batch", a.batch),
        "train_seconds_this_session": round(time.time() - t0), "weights_sha256": hashlib.sha256(best.read_bytes()).hexdigest(),
        "note": "candidate only: not installed, not measured on the test split until evaluate_defects.py has been run",
    }
    (run_dir / "defects_det.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
