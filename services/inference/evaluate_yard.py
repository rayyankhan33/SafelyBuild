"""
evaluate_yard.py - measure the yard model against exact ground truth, next to the classical baseline.

  python evaluate_yard.py --data data/yard --weights models/yard_seg.pt

For every test frame the true quantity of each material is known (the frame was built from it). We report,
per material and per split:
  * presence precision / recall   (is the material there at all?)
  * median absolute % error       (when it is there, how far off is the quantity?)
  * mean signed % error           (bias: does it systematically over- or under-count?)
and the same for the classical colour method (scene.estimate_inventory), which is today's baseline.
Splits: `test` (same look as training) and `test_shift` (colours and haze never seen in training).

Because the truth comes from the same geometry formulas as the estimator (scene.py), this measures how
well the model SEES the pile or stack. It does not measure whether the formulas match real piles: that
needs real, measured yards.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

import scene
from synth import yard

PRESENT_MIN_AREA_PX = 1000
HERE = Path(__file__).parent


def model_quantities(model, img, scale, conf=0.25, imgsz=None):
    """{material_code: quantity} from instance masks, each instance converted with the scene.py formula."""
    from plugins import yard_seg
    r = model.predict(img, conf=conf, imgsz=imgsz or yard_seg._imgsz(), device="cpu", verbose=False)[0]
    out = defaultdict(float)
    area_px = defaultdict(float)
    if r.masks is None:
        return {}, {}
    for poly, c in zip(r.masks.xy, r.boxes.cls.tolist()):
        if len(poly) < 3:
            continue
        cls = yard.CLASSES[int(c)]
        a = float(cv2.contourArea(np.asarray(poly, np.float32)))
        out[yard.CODE[cls]] += yard.quantity_from_area(cls, a * scale ** 2)
        area_px[yard.CODE[cls]] += a
    return dict(out), dict(area_px)


def classical_quantities(img, scale):
    res = scene.estimate_inventory(img, scale)
    return {i["material_code"]: i["quantity"] for i in res["items"]}, {i["material_code"]: i["area_px"] for i in res["items"]}


def summarise(rows):
    """rows: [(truth_qty|None, pred_qty|None)] for one material."""
    tp = sum(1 for t, p in rows if t and p)
    fn = sum(1 for t, p in rows if t and not p)
    fp = sum(1 for t, p in rows if not t and p)
    errs = [(p - t) / t * 100 for t, p in rows if t and p]
    return {
        "frames_with_material": tp + fn, "recall": round(tp / (tp + fn), 3) if tp + fn else None,
        "precision": round(tp / (tp + fp), 3) if tp + fp else None,
        "median_abs_pct_error": round(float(np.median(np.abs(errs))), 1) if errs else None,
        "mean_signed_pct_error": round(float(np.mean(errs)), 1) if errs else None,
    }


def evaluate(data: Path, weights: Path, splits=("test", "test_shift"), limit=None, log=print):
    from ultralytics import YOLO
    model = YOLO(str(weights))
    report = {}
    for split in splits:
        metas = sorted((data / "meta" / split).glob("*.json"))[:limit]
        per = {"model": defaultdict(list), "classical": defaultdict(list)}
        for mp in metas:
            meta = json.loads(mp.read_text())
            img = cv2.imread(str(data / "images" / split / f"{mp.stem}.jpg"))
            truth = defaultdict(float)
            for it in meta["items"]:
                # truth = the formula applied to the area that was actually drawn (older dataset files stored the requested one)
                cls = next(c for c, code in yard.CODE.items() if code == it["material_code"])
                truth[it["material_code"]] += yard.quantity_from_area(cls, it["area_px"] * meta["scale_m_per_px"] ** 2)
            mq, ma = model_quantities(model, img, meta["scale_m_per_px"])
            cq, ca = classical_quantities(img, meta["scale_m_per_px"])
            for code in yard.CODE.values():
                t = truth.get(code)
                per["model"][code].append((t, mq.get(code) if ma.get(code, 0) >= PRESENT_MIN_AREA_PX else None))
                per["classical"][code].append((t, cq.get(code) if ca.get(code, 0) >= PRESENT_MIN_AREA_PX else None))
        report[split] = {k: {code: summarise(rows) for code, rows in v.items()} for k, v in per.items()}
        report[split]["frames"] = len(metas)
        log(f"\n== {split} ({len(metas)} frames) ==")
        log(f'{"material":10} | {"model":^44} | {"classical colour":^44}')
        log(f'{"":10} | {"recall":>6} {"prec":>6} {"med|err|%":>9} {"bias%":>7}      | {"recall":>6} {"prec":>6} {"med|err|%":>9} {"bias%":>7}')
        for code in yard.CODE.values():
            m, c = report[split]["model"][code], report[split]["classical"][code]
            f = lambda s: f'{s["recall"] if s["recall"] is not None else "-":>6} {s["precision"] if s["precision"] is not None else "-":>6} {s["median_abs_pct_error"] if s["median_abs_pct_error"] is not None else "-":>9} {s["mean_signed_pct_error"] if s["mean_signed_pct_error"] is not None else "-":>7}'
            log(f"{code:10} | {f(m)}      | {f(c)}")
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data/yard"))
    ap.add_argument("--weights", default=str(HERE / "models/yard_seg.pt"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=str(HERE / "models/yard_seg_eval.json"))
    a = ap.parse_args()
    rep = evaluate(Path(a.data), Path(a.weights), limit=a.limit)
    Path(a.out).write_text(json.dumps(rep, indent=2))
    print("\nwritten", a.out)
