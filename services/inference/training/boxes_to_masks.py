"""
boxes_to_masks.py - turn a box-labelled YOLO dataset (a Roboflow "YOLOv8" export) into a mask-labelled one for the
yard model, using a box-prompted Segment Anything model.

The yard model (`yard_seg`, a YOLO segmentation model) measures a pile or stack by its footprint AREA. Public
yard-material datasets only have boxes, and a box over-states an irregular pile. SAM, prompted with each box,
draws the outline inside it.

  python training/boxes_to_masks.py --src E:/Datasets/roboflow/cement_bag_detection --out data/yard_real/cement \
        --map bag=cement_bags
  python training/boxes_to_masks.py --src E:/Datasets/roboflow/piled_materials --out data/yard_real/piles \
        --map Sand=sand_pile --map Rock=aggregate_pile
  python training/boxes_to_masks.py --combine data/yard_real/cement data/yard_real/piles --yaml data/yard_real/yard_real.yaml

Source layout (Roboflow YOLOv8 export): <src>/data.yaml plus train|valid|test / images + labels.

Quality gates (a bad mask is worse than no mask)
  * a mask must cover between MIN_FILL and MAX_FILL of its box, otherwise the instance is dropped
  * an image with more than --max-instances boxes is skipped: "counting" datasets put a box on every bar end or
    brick, and a per-item mask is meaningless for footprint-based stock
  * classes not named in --map are not labelled (they stay as unlabelled background)
Every drop is counted in stats.json so nothing disappears silently. The result is AUTO-LABELLED where SAM drew the mask
(polygons already present in the source are kept as they are and counted as polygons_passed_through);
masks from SAM come from a model, not from a person; check a contact sheet of them before training on them, and never use them as test data.
"""

from __future__ import annotations

import argparse
import json
import shutil
from collections import Counter
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

import cv2
import numpy as np

YARD_CLASSES = ["cement_bags", "sand_pile", "aggregate_pile", "brick_stack", "rebar_bundle"]   # same order as synth/yard.py
MIN_FILL = 0.25          # mask area / box area below this: SAM latched onto a tiny part
MAX_FILL = 1.10          # above this: the mask spilled outside the box
MIN_POLY_POINTS = 3
SPLIT_NAMES = {"train": "train", "valid": "val", "val": "val", "test": "test"}

SamFn = Callable[[np.ndarray, List[List[float]]], List[Optional[np.ndarray]]]


def read_names(data_yaml: Path) -> List[str]:
    """Class names from a Roboflow data.yaml (list or index->name mapping), without needing a YAML library."""
    names, in_names = [], False
    for line in data_yaml.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("names:"):
            rest = s[len("names:"):].strip()
            if rest.startswith("["):
                return [x.strip().strip("'\"") for x in rest.strip("[]").split(",") if x.strip()]
            in_names = True
            continue
        if in_names:
            if s.startswith("-"):
                names.append(s[1:].strip().strip("'\""))
            elif ":" in s and s.split(":")[0].strip().isdigit():
                names.append(s.split(":", 1)[1].strip().strip("'\""))
            elif s and not s.startswith("#"):
                break
    return names


def yolo_boxes(label_file: Path, width: int, height: int, include_polygons: bool = True) -> List[dict]:
    """YOLO detection lines -> [{cls, xyxy}] in pixels (polygon lines are reduced to their bounding box, or skipped
    when `include_polygons` is False because they are passed through as masks by `yolo_polygons`)."""
    out = []
    if not label_file.exists():
        return out
    for line in label_file.read_text().splitlines():
        p = line.split()
        if len(p) < 5:
            continue
        cls, vals = int(float(p[0])), [float(v) for v in p[1:]]
        if len(vals) != 4 and not include_polygons:
            continue
        if len(vals) == 4:
            cx, cy, w, h = vals
            x1, y1, x2, y2 = (cx - w / 2) * width, (cy - h / 2) * height, (cx + w / 2) * width, (cy + h / 2) * height
        else:
            xs, ys = vals[0::2], vals[1::2]
            x1, y1, x2, y2 = min(xs) * width, min(ys) * height, max(xs) * width, max(ys) * height
        out.append({"cls": cls, "xyxy": [max(0.0, x1), max(0.0, y1), min(float(width), x2), min(float(height), y2)]})
    return out


def yolo_polygons(label_file: Path, class_map: Dict[int, int], stats: Counter) -> List[str]:
    """Segmentation lines already in the source (some Roboflow sets are polygon-labelled): keep them as they are,
    re-numbered to yard classes. They were drawn by a person, so no SAM and no fill gate."""
    out = []
    if not label_file.exists():
        return out
    for line in label_file.read_text().splitlines():
        p = line.split()
        if len(p) < 7 or len(p) % 2 == 0:                       # a polygon: class + at least 3 (x, y) pairs
            continue
        c = int(float(p[0]))
        if c not in class_map:
            stats["polygons_unmapped_class"] += 1
            continue
        vals = [min(1.0, max(0.0, float(v))) for v in p[1:]]
        out.append(f"{class_map[c]} " + " ".join(f"{v:.6f}" for v in vals))
        stats["polygons_passed_through"] += 1
    return out


def polygon_of(mask: np.ndarray, eps: float = 0.003) -> Optional[np.ndarray]:
    """Largest outer contour of a binary mask, simplified. None if there is no usable outline."""
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, eps * cv2.arcLength(c, True), True)[:, 0, :]
    return c.astype(float) if len(c) >= MIN_POLY_POINTS else None


def convert_image(img: np.ndarray, boxes: Sequence[dict], class_map: Dict[int, int], sam: SamFn, max_instances: int, stats: Counter) -> List[str]:
    """One image -> YOLO-seg lines. `class_map` maps source class index -> yard class index."""
    use = [b for b in boxes if b["cls"] in class_map]
    stats["boxes_unmapped_class"] += len(boxes) - len(use)
    if not use:
        return []
    if len(use) > max_instances:
        stats["images_skipped_crowded"] += 1
        stats["boxes_in_skipped_images"] += len(use)
        return []
    h, w = img.shape[:2]
    masks = sam(img, [b["xyxy"] for b in use])
    lines = []
    for b, m in zip(use, masks):
        x1, y1, x2, y2 = b["xyxy"]
        box_area = max(1.0, (x2 - x1) * (y2 - y1))
        if m is None or not np.any(m):
            stats["dropped_no_mask"] += 1
            continue
        fill = float(np.count_nonzero(m)) / box_area
        if fill < MIN_FILL:
            stats["dropped_mask_too_small"] += 1
            continue
        if fill > MAX_FILL:
            stats["dropped_mask_spills_out_of_box"] += 1
            continue
        poly = polygon_of(m)
        if poly is None:
            stats["dropped_no_outline"] += 1
            continue
        pts = " ".join(f"{min(1.0, max(0.0, x / w)):.6f} {min(1.0, max(0.0, y / h)):.6f}" for x, y in poly)
        lines.append(f"{class_map[b['cls']]} {pts}")
        stats["instances_kept"] += 1
    return lines


def sam_predictor(weights: str) -> SamFn:
    """Box-prompted SAM through ultralytics. Imported lazily so the converter's logic is testable without the weights."""
    from ultralytics import SAM
    model = SAM(weights)

    def predict(img: np.ndarray, boxes: List[List[float]]):
        r = model(img, bboxes=boxes, verbose=False)[0]
        if r.masks is None:
            return [None] * len(boxes)
        data = r.masks.data.cpu().numpy() > 0.5                      # (n, H', W')
        out = []
        for m in data:
            if m.shape != img.shape[:2]:
                m = cv2.resize(m.astype(np.uint8), (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)
            out.append(m)
        return out + [None] * (len(boxes) - len(out))
    return predict


def source_duplicates(src: Path, hamming: int = 4) -> set:
    """Source images that are near-copies of a picture in a MORE protected split (test over val over train). Finding them
    before conversion means SAM is never run on a picture that would be deleted afterwards."""
    try:
        from training.build_corrosion_cls import dhash, groups
    except ModuleNotFoundError:
        from build_corrosion_cls import dhash, groups
    rank = {"test": 0, "valid": 1, "val": 1, "train": 2}
    items = [(sub, p) for sub in rank for p in sorted((src / sub / "images").glob("*")) if (src / sub / "images").is_dir()
             and p.suffix.lower() in (".jpg", ".jpeg", ".png")]
    hashes = []
    for _, p in items:
        im = cv2.imread(str(p))
        hashes.append(dhash(cv2.resize(im, (64, 64), interpolation=cv2.INTER_AREA)) if im is not None else 0)
    by_group: Dict[int, list] = {}
    for (sub, p), g in zip(items, groups(hashes, hamming)):
        by_group.setdefault(g, []).append((sub, p))
    skip = set()
    for members in by_group.values():
        best = min(rank[s] for s, _ in members)
        skip.update(p for s, p in members if rank[s] > best)
    return skip


def build(src: Path, out: Path, mapping: Dict[str, str], sam: Optional[SamFn], max_instances: int = 60, max_side: int = 1280, log=print,
          skip: Optional[set] = None, resume: bool = False) -> dict:
    """`resume`: continue an interrupted run. An image already converted (output image and label both present, or listed in
    `.processed.txt` as converted-with-no-usable-label) is not converted again, so SAM is never repeated for it."""
    names = read_names(src / "data.yaml")
    class_map = {}
    for i, n in enumerate(names):
        target = mapping.get(n)
        if target is not None:
            class_map[i] = YARD_CLASSES.index(target)
    if not class_map:
        raise SystemExit(f"--map matches none of the dataset's classes {names}")
    stats = Counter()
    out.mkdir(parents=True, exist_ok=True)
    marker = out / ".processed.txt"
    processed = set(marker.read_text().splitlines()) if resume and marker.exists() else set()
    for sub in ("train", "valid", "val", "test"):
        imgs = src / sub / "images"
        if not imgs.is_dir():
            continue
        split = SPLIT_NAMES[sub]
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        for p in sorted(imgs.iterdir()):
            if p.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            if skip and p in skip:
                stats["skipped_copy_of_a_picture_in_a_more_protected_split"] += 1
                continue
            name = f"{src.name}_{split}_{p.stem[:60]}"
            if resume and (f"{split}/{p.stem}" in processed or ((out / "images" / split / f"{name}.jpg").exists() and (out / "labels" / split / f"{name}.txt").exists())):
                stats["resumed_already_converted"] += 1
                continue
            img = cv2.imread(str(p))
            if img is None:
                stats["images_unreadable"] += 1
                continue
            s = min(1.0, max_side / max(img.shape[:2]))
            if s < 1.0:
                img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
            lab = src / sub / "labels" / f"{p.stem}.txt"
            boxes = yolo_boxes(lab, img.shape[1], img.shape[0], include_polygons=False)
            lines = yolo_polygons(lab, class_map, stats) + convert_image(img, boxes, class_map, sam, max_instances, stats)
            stats["images_seen"] += 1
            if not lines:
                stats["images_without_labels"] += 1
                with marker.open("a") as m:
                    m.write(f"{split}/{p.stem}" + chr(10))
                continue                                                # not written: an unlabelled image would teach "nothing here"
            cv2.imwrite(str(out / "images" / split / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            (out / "labels" / split / f"{name}.txt").write_text("\n".join(lines))
            stats["images_written"] += 1
            stats[f"written_{split}"] += 1
            with marker.open("a") as m:
                m.write(f"{split}/{p.stem}" + chr(10))
            if stats["images_seen"] % 25 == 0:
                log(f"{stats['images_seen']} images seen, {stats['instances_kept'] + stats['polygons_passed_through']} masks kept")
    on_disk = {sp: len(list((out / "labels" / sp).glob("*.txt"))) for sp in ("train", "val", "test") if (out / "labels" / sp).is_dir()}
    instances = sum(len([l for l in f.read_text().splitlines() if l.strip()]) for f in (out / "labels").glob("*/*.txt"))
    stats["labels_on_disk_images"] = sum(on_disk.values())
    stats["labels_on_disk_instances"] = instances
    result = {"source": str(src), "source_classes": names, "mapping": mapping, "auto_labelled": stats["instances_kept"] > 0 or (resume and instances > stats["polygons_passed_through"]), "stats": dict(stats), "images_per_split_on_disk": on_disk}
    (out / "stats.json").write_text(json.dumps(result, indent=2))
    (out / "README.md").write_text(
        f"# Yard masks ({src.name})\n\nBuilt by `training/boxes_to_masks.py` with mapping {', '.join(f'{k} -> {v}' for k, v in mapping.items())}. "
        f"Polygons already in the source were kept as drawn ({stats['polygons_passed_through']}); {stats['instances_kept']} masks were AUTO-LABELLED "
        "by a box-prompted Segment Anything model inside source boxes and are not verified by a person. Do not use auto-labelled masks as test data.\n")
    return result


def dedupe_splits(out: Path, hamming: int = 4) -> dict:
    """Remove near-duplicate pictures that sit in more than one split, so a validation or test score is not a memory test.
    A copy in `test` wins over `val`, which wins over `train`: the copy in the less protected split is deleted (image and label).
    Duplicates inside one split are left alone."""
    try:                                                                  # same perceptual hash the corrosion set uses
        from training.build_corrosion_cls import dhash, groups
    except ModuleNotFoundError:                                           # run as `python training/boxes_to_masks.py`
        from build_corrosion_cls import dhash, groups
    rank = {"test": 0, "val": 1, "train": 2}
    items = [(sp, p) for sp in rank for p in sorted((out / "images" / sp).glob("*.jpg"))] if (out / "images").is_dir() else []
    hashes = [dhash(cv2.resize(cv2.imread(str(p)), (64, 64), interpolation=cv2.INTER_AREA)) for _, p in items]
    by_group: Dict[int, list] = {}
    for (sp, p), g in zip(items, groups(hashes, hamming)):
        by_group.setdefault(g, []).append((sp, p))
    removed = Counter()
    for members in by_group.values():
        best = min(rank[sp] for sp, _ in members)
        if len({sp for sp, _ in members}) < 2:
            continue
        for sp, p in members:
            if rank[sp] > best:
                p.unlink()
                (out / "labels" / sp / f"{p.stem}.txt").unlink(missing_ok=True)
                removed[f"removed_from_{sp}"] += 1
    if (out / "stats.json").exists():
        st = json.loads((out / "stats.json").read_text())
        st["dedupe_across_splits"] = {"hamming": hamming, **removed}
        (out / "stats.json").write_text(json.dumps(st, indent=2))
    return dict(removed)


def combine(dirs: Sequence[Path], yaml_path: Path) -> None:
    """One data.yaml that trains on several built datasets (and, optionally, the synthetic one: add its images/train path)."""
    def lst(split):
        return "".join(f"  - {d.resolve().as_posix()}/images/{split}\n" for d in dirs if (d / "images" / split).is_dir())
    yaml_path.write_text("train:\n" + lst("train") + "val:\n" + lst("val") + "test:\n" + lst("test") +
                         "names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(YARD_CLASSES)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src")
    ap.add_argument("--out")
    ap.add_argument("--map", action="append", default=[], help="source_class=yard_class (repeatable); yard classes: " + ", ".join(YARD_CLASSES))
    ap.add_argument("--sam", default=str(Path(__file__).resolve().parents[1] / "models" / "sam_b.pt"))
    ap.add_argument("--no-sam", action="store_true", help="do not load SAM: keep only polygons already in the source (box lines are dropped)")
    ap.add_argument("--hamming", type=int, default=4, help="near-duplicate threshold in dHash bits (0 = identical; chaining makes large values merge similar scenes)")
    ap.add_argument("--resume", action="store_true", help="continue an interrupted run: images already converted are not converted again (no SAM repeated)")
    ap.add_argument("--keep-cross-split-duplicates", action="store_true", help="skip the removal of near-duplicates that span train/val/test")
    ap.add_argument("--max-instances", type=int, default=60)
    ap.add_argument("--max-side", type=int, default=1280)
    ap.add_argument("--combine", nargs="+", default=None, help="built dataset folders to combine into one yaml")
    ap.add_argument("--yaml", default=None)
    a = ap.parse_args()
    if a.combine:
        combine([Path(d) for d in a.combine], Path(a.yaml))
        print("wrote", a.yaml)
    else:
        mp = dict(x.split("=", 1) for x in a.map)
        bad = [v for v in mp.values() if v not in YARD_CLASSES]
        if bad:
            raise SystemExit(f"unknown yard class(es) {bad}; use {YARD_CLASSES}")
        sam = (lambda img, boxes: [None] * len(boxes)) if a.no_sam else sam_predictor(a.sam)
        skip = None if a.keep_cross_split_duplicates else source_duplicates(Path(a.src), a.hamming)
        print(json.dumps(build(Path(a.src), Path(a.out), mp, sam, a.max_instances, a.max_side, skip=skip, resume=a.resume), indent=2))
        if not a.keep_cross_split_duplicates:
            print("cross-split near-duplicates removed after conversion:", dedupe_splits(Path(a.out), a.hamming))
