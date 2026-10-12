"""
evaluate.py - measure a backend on LABELLED images.

    python evaluate.py --task stage     --backend classical_color --data path/to/set
    python evaluate.py --task inventory --backend my_model        --data path/to/set --out result.json
    python evaluate.py --task defects   --backend my_model        --data path/to/set

`--data` is a folder containing the images and a labels.json (formats below). Works on any
registered backend (built-in or plugin), activated or not, so a new model can be measured and
compared BEFORE it is switched on. Numbers printed here are the only honest basis for flipping a
backend's `reliability` to "validated".

labels.json
  stage      [{"file": "a.png", "element_type": "slab", "stage": 2}, {"file": "w.png", "element_type": "masonry_wall", "fraction": 0.6}]
  inventory  [{"file": "y.png", "scale_m_per_px": 0.1, "stock": {"SAND": 80.0, "CEMENT": 600}}]
  defects    [{"file": "d.jpg", "boxes": [{"defect_type": "rusted_rebar", "bbox": [x1, y1, x2, y2]}]}]   (empty list = clean image)
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

import pipeline
import registry


def _load(path: Path):
    img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot read image {path}")
    return img


def eval_stage(fn, labels, root: Path) -> dict:
    exact = near = n = 0
    confusion = Counter()
    frac_err = []
    for item in labels:
        out = fn(_load(root / item["file"]), item["element_type"])
        if item["element_type"] == "masonry_wall":
            frac_err.append(abs(float(out["fraction"]) - float(item["fraction"])))
            continue
        n += 1
        got, want = int(out["stage"]), int(item["stage"])
        confusion[(want, got)] += 1
        exact += got == want
        near += abs(got - want) <= 1
    res = {"task": "stage", "ordinal_images": n}
    if n:
        res.update(accuracy=round(exact / n, 4), within_one_stage=round(near / n, 4),
                   confusion={f"true{w}->pred{g}": c for (w, g), c in sorted(confusion.items())})
    if frac_err:
        res["masonry_fraction_mae"] = round(float(np.mean(frac_err)), 4)
        res["masonry_images"] = len(frac_err)
    return res


def eval_inventory(fn, labels, root: Path) -> dict:
    errs = defaultdict(list)
    for item in labels:
        out = fn(_load(root / item["file"]), float(item["scale_m_per_px"]))
        got = {i["material_code"]: float(i["quantity"]) for i in out["items"]}
        for code, want in item["stock"].items():
            if want > 0:
                errs[code].append((got.get(code, 0.0) - want) / want)
    per = {c: {"n": len(e), "mape": round(float(np.mean(np.abs(e))), 4), "bias": round(float(np.mean(e)), 4)} for c, e in errs.items()}
    return {"task": "inventory", "per_material": per,
            "overall_mape": round(float(np.mean([abs(x) for e in errs.values() for x in e])), 4) if errs else None}


def _iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def eval_defects(fn, labels, root: Path, iou_thr: float = 0.3) -> dict:
    tp = fp = fn_ = 0
    img_ok = 0
    for item in labels:
        data = (root / item["file"]).read_bytes()
        found = fn(data, "Medium", 0.15)["findings"]
        found = [f for f in found if f.get("is_violation", True)]
        truth = list(item["boxes"])
        matched = set()
        for f in found:
            hit = next((i for i, t in enumerate(truth) if i not in matched and t["defect_type"] == f["defect_type"] and _iou(f["bbox"], t["bbox"]) >= iou_thr), None)
            if hit is None:
                fp += 1
            else:
                matched.add(hit); tp += 1
        fn_ += len(truth) - len(matched)
        img_ok += (len(found) > 0) == (len(truth) > 0)
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn_) if tp + fn_ else 0.0
    return {"task": "defects", "iou_threshold": iou_thr, "images": len(labels), "precision": round(p, 4), "recall": round(r, 4),
            "f1": round(2 * p * r / (p + r), 4) if p + r else 0.0, "image_level_accuracy": round(img_ok / len(labels), 4) if labels else None}


def run(task: str, backend: str, data_dir: str) -> dict:
    root = Path(data_dir)
    labels = json.loads((root / "labels.json").read_text(encoding="utf-8"))
    fn, model = registry.resolve(task, backend)
    result = {"stage": eval_stage, "inventory": eval_inventory, "defects": eval_defects}[task](fn, labels, root)
    return {"model": model, "images_evaluated": len(labels), **result}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task", required=True, choices=registry.TASKS)
    ap.add_argument("--backend", default="auto")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    try:
        res = run(a.task, a.backend, a.data)
    except (registry.BackendUnavailable, FileNotFoundError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    text = json.dumps(res, indent=2)
    print(text)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
