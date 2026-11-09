"""
build_codebrim_yolo.py - turn the CODEBRIM COCO export into a YOLO detection dataset for the defects model.

CODEBRIM (Mundt et al., CVPR 2019; Roboflow export, CC BY 4.0) holds 1,051 high-resolution photographs of
concrete bridges (mostly 4608x3456 px) with boxes for five defect kinds. It is the only dataset we have in
the right domain for the platform's structural-defect detector, and the only one that shows what cracks
are NOT: spalling, rust stains and efflorescence sit in the same images.

  python training/build_codebrim_yolo.py --src E:/Datasets/CODEBRIM.coco --out data/codebrim_det --scheme native
  python training/build_codebrim_yolo.py --src E:/Datasets/CODEBRIM.coco --out data/codebrim_platform --scheme platform

Schemes
  native    the dataset's own five classes: efflorescence, corrosion_stain, crack, spallation, exposed_bars
  platform  the platform's defect vocabulary:
              concrete_crack  <- crack
              rusted_rebar    <- corrosion_stain + exposed_bars   (ASSUMPTION: both indicate corroding reinforcement;
                                                                   have an engineer confirm before relying on it)
              spalling        <- spallation                        (not in the hazard library yet)
              efflorescence is NOT labelled: it stays in the images as an unlabelled hard negative
            There is no honeycombed-concrete source in this dataset.

Splits are the dataset's own (train / valid / test). Keep `test` for reporting only, for EVERY model: the
existing crack model's out-of-domain check used CODEBRIM images, so training on them removes that check
unless the test split stays untouched.

Images are resized to --max-side (default 1280, the size the inference service analyses at); labels are
normalised so they do not change. The 'Background' category in the export is dropped.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

import cv2

SPLITS = {"train": "train", "valid": "val", "test": "test"}
NATIVE = ["efflorescence", "corrosion_stain", "crack", "spallation", "exposed_bars"]
SRC_NAME = {"0 Efflorescence": "efflorescence", "1 CorrosionStain": "corrosion_stain", "2 Crack": "crack",
            "3 Spallation": "spallation", "4 ExposedBars": "exposed_bars"}
PLATFORM = ["concrete_crack", "rusted_rebar", "spalling"]
PLATFORM_MAP = {"crack": "concrete_crack", "corrosion_stain": "rusted_rebar", "exposed_bars": "rusted_rebar", "spallation": "spalling"}
MIN_SIDE_PX = 2.0          # boxes thinner than this after resizing are dropped


def classes_for(scheme: str):
    return NATIVE if scheme == "native" else PLATFORM


def class_of(name: str, scheme: str):
    """Class index for a native class name under `scheme`, or None if it is not labelled in that scheme."""
    if scheme == "native":
        return NATIVE.index(name)
    mapped = PLATFORM_MAP.get(name)
    return PLATFORM.index(mapped) if mapped else None


def yolo_lines(anns, cats, width, height, scale, scheme):
    """COCO boxes of one image -> YOLO lines. Returns (lines, dropped) with dropped = {reason: count}."""
    out, dropped = [], Counter()
    for a in anns:
        name = SRC_NAME.get(cats[a["category_id"]])
        if name is None:
            dropped["background_or_unknown"] += 1
            continue
        idx = class_of(name, scheme)
        if idx is None:
            dropped[f"unlabelled_in_{scheme}:{name}"] += 1
            continue
        x, y, w, h = a["bbox"]
        x1, y1, x2, y2 = max(0.0, x), max(0.0, y), min(float(width), x + w), min(float(height), y + h)
        if (x2 - x1) * scale < MIN_SIDE_PX or (y2 - y1) * scale < MIN_SIDE_PX:
            dropped["too_small"] += 1
            continue
        out.append(f"{idx} {(x1 + x2) / 2 / width:.6f} {(y1 + y2) / 2 / height:.6f} {(x2 - x1) / width:.6f} {(y2 - y1) / height:.6f}")
    return out, dropped


def _work(job):
    src_img, dst_img, dst_lbl, anns, cats, width, height, max_side, scheme, full_res = job
    img = cv2.imread(str(src_img), cv2.IMREAD_REDUCED_COLOR_2) if full_res and max(width, height) >= 2 * max_side else cv2.imread(str(src_img))
    if img is None:
        return None
    h0, w0 = img.shape[:2]
    scale = min(1.0, max_side / max(h0, w0))
    if scale < 1.0:
        img = cv2.resize(img, (round(w0 * scale), round(h0 * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(dst_img), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    # the full-resolution size in the COCO file decides the label scale (labels are normalised)
    lines, dropped = yolo_lines(anns, cats, width, height, img.shape[1] / width, scheme)
    dst_lbl.write_text("\n".join(lines))
    return len(lines), dict(dropped), img.shape[1], img.shape[0]


def build(src: Path, out: Path, scheme: str, max_side: int = 1280, workers: int = 2, reuse: Path = None, log=print) -> dict:
    classes = classes_for(scheme)
    jobs, meta = [], {}
    for sub, split in SPLITS.items():
        coco = json.loads((src / sub / "_annotations.coco.json").read_text())
        cats = {c["id"]: c["name"] for c in coco["categories"]}
        by = {}
        for a in coco["annotations"]:
            by.setdefault(a["image_id"], []).append(a)
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        for im in coco["images"]:
            base = re.match(r"(image_\d+)", im["file_name"]).group(1)
            name = f"{split}_{base}"
            meta[name] = {"split": split, "source_file": im["file_name"], "photo": base}
            # with `reuse`, the images already resized for another scheme are copied instead of decoding the full-size photographs again
            origin = (reuse / "images" / split / f"{name}.jpg") if reuse else (src / sub / im["file_name"])
            jobs.append((origin, out / "images" / split / f"{name}.jpg", out / "labels" / split / f"{name}.txt",
                         by.get(im["id"], []), cats, im["width"], im["height"], max_side, scheme, not reuse))
    stats = {"scheme": scheme, "classes": classes, "images": Counter(), "boxes": Counter(), "boxes_per_class": Counter(), "dropped": Counter()}
    with Pool(workers) as pool:
        for k, (job, res) in enumerate(zip(jobs, pool.imap(_work, jobs, chunksize=4)), 1):
            split = job[1].parent.name
            if res is None:
                stats["dropped"]["unreadable_image"] += 1
                continue
            n, dropped, _, _ = res
            stats["images"][split] += 1
            stats["boxes"][split] += n
            stats["dropped"].update(dropped)
            for line in job[2].read_text().splitlines():
                stats["boxes_per_class"][classes[int(line.split()[0])]] += 1
            if k % 100 == 0:
                log(f"{k}/{len(jobs)}")
    # the same photograph in two splits would leak; report it (Roboflow exports can contain near-duplicates)
    seen, leaks = {}, []
    for name, m in meta.items():
        if m["photo"] in seen and seen[m["photo"]] != m["split"]:
            leaks.append(m["photo"])
        seen.setdefault(m["photo"], m["split"])
    stats = {k: (dict(v) if isinstance(v, Counter) else v) for k, v in stats.items()}
    stats["photos_in_more_than_one_split"] = leaks
    (out / "data.yaml").write_text(
        f"path: {out.resolve().as_posix()}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(classes)))
    (out / "stats.json").write_text(json.dumps(stats, indent=2))
    (out / "README.md").write_text(
        f"# CODEBRIM YOLO detection dataset ({scheme})\n\nBuilt by `training/build_codebrim_yolo.py` from the CODEBRIM Roboflow export "
        f"(Mundt et al., CVPR 2019; CC BY 4.0). Classes: {', '.join(classes)}.\n\nImages are resized to at most {max_side} px on the long side. "
        "Splits are the dataset's own; use `test` for reporting only. Not real CCTV footage: these are close-up inspection photographs of bridges.\n"
        + ("\nScheme `platform` maps corrosion_stain and exposed_bars to rusted_rebar (assumption, needs engineer review), drops efflorescence "
           "(left as an unlabelled hard negative) and has no honeycomb source.\n" if scheme == "platform" else ""))
    return stats


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", default="E:/Datasets/CODEBRIM.coco")
    ap.add_argument("--out", default="data/codebrim_det")
    ap.add_argument("--scheme", choices=["native", "platform"], default="native")
    ap.add_argument("--max-side", type=int, default=1280)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--reuse-images", default=None, help="a dataset built earlier from the same source: copy its resized images")
    a = ap.parse_args()
    print(json.dumps(build(Path(a.src), Path(a.out), a.scheme, a.max_side, a.workers, Path(a.reuse_images) if a.reuse_images else None), indent=2))
