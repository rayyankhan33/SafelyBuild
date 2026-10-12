"""
eval_codebrim.py - out-of-domain sanity check of the crack model on CODEBRIM (never trained on).

    python training/eval_codebrim.py --data "<path>/Datasets/CODEBRIM.coco"

CODEBRIM (bridge inspection photographs, Roboflow export, CC BY 4.0) has COCO boxes for cracks and
for look-alike defects (efflorescence, corrosion stain, spalling). Only the images that are
actually present on disk are used. An image counts as "has crack" if it has a "2 Crack" box.
The model is run exactly as the service runs it (image downscaled to 1280 px, multi-scale
windows) and the image-level decision is "any crack region found".

This is a small, image-level check, not a benchmark: with ~18 images the numbers have wide
error bars. Its purpose is to show whether the model fires on look-alikes and whether it finds
cracks in full-size photographs, which SDNET patches alone cannot show.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import crack_model  # noqa: E402
import pipeline  # noqa: E402


def load(root: str):
    rows = []
    for split in ("train", "valid", "test"):
        ann = pathlib.Path(root) / split / "_annotations.coco.json"
        if not ann.is_file():
            continue
        d = json.loads(ann.read_text())
        cats = {c["id"]: c["name"] for c in d["categories"]}
        present = set(os.listdir(pathlib.Path(root) / split))
        by_img = {}
        for a in d["annotations"]:
            by_img.setdefault(a["image_id"], set()).add(cats[a["category_id"]])
        for im in d["images"]:
            if im["file_name"] in present:
                kinds = by_img.get(im["id"], set())
                rows.append({"path": str(pathlib.Path(root) / split / im["file_name"]),
                             "has_crack": "2 Crack" in kinds,
                             "lookalikes": sorted(k[2:] for k in kinds if "Crack" not in k and k != "Background")})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--json", help="write results here")
    args = ap.parse_args()

    model = crack_model.get_model()
    thr = model.threshold if args.threshold is None else args.threshold
    rows = load(args.data)
    if not rows:
        raise SystemExit("no CODEBRIM images found")
    tp = fp = tn = fn = 0
    out = []
    for r in rows:
        img = pipeline.decode_image(pathlib.Path(r["path"]).read_bytes())
        res = model.scan(img, threshold=thr)
        found = bool(res.regions)
        r.update(max_probability=round(res.max_probability, 3), regions=len(res.regions),
                 coverage=round(sum(x.area_fraction for x in res.regions), 3), flagged=found)
        r["path"] = pathlib.Path(r["path"]).name[:18]
        tp += found and r["has_crack"]; fn += (not found) and r["has_crack"]
        fp += found and not r["has_crack"]; tn += (not found) and not r["has_crack"]
        out.append(r)
        print(f"{r['path']:20} crack_gt={str(r['has_crack']):5} flagged={str(found):5} max_p={r['max_probability']:.3f} "
              f"regions={r['regions']} coverage={r['coverage']:.2f} lookalikes={r['lookalikes']}")
    summary = {"images": len(rows), "threshold": thr, "tp": int(tp), "fp": int(fp), "tn": int(tn), "fn": int(fn),
               "recall": round(tp / max(1, tp + fn), 3), "specificity": round(tn / max(1, tn + fp), 3)}
    print(json.dumps(summary))
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps({"summary": summary, "images": out}, indent=2))


if __name__ == "__main__":
    main()
