"""
build_corrosion_cls.py - a clean image-classification dataset (corrosion / no_corrosion) from "Rust - Dataset.zip".

The zip holds 1,455 JPEGs sorted into train/test and CORROSION / NOCORROSION folders. What it shows is general
corrosion on industrial and marine objects (chains, rails, sheet metal) against shiny metal and unrelated objects, NOT
reinforcing steel in concrete. It is therefore an AUXILIARY dataset: useful to teach a network what rust texture looks
like, but it will not tell you whether a rebar on a site is corroded. Do not report accuracy on it as site accuracy.

What this script adds
  * near-duplicate removal (stock photos often appear twice): perceptual dHash, Hamming distance <= --hamming
  * no leakage: a near-duplicate group never spans two splits (a copy in `test` removes the copies in `train`)
  * a validation split taken from train by GROUP, stratified by label
  * images resized to --max-side (default 512)

  python training/build_corrosion_cls.py --zip "E:/Datasets/Rust - Dataset.zip" --out data/corrosion_cls
"""

from __future__ import annotations

import argparse
import json
import random
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

LABELS = ("no_corrosion", "corrosion")


def label_of(path: str):
    """'.../NOCORROSION/...' must be tested before 'CORROSION', which is a substring of it."""
    if "/NOCORROSION/" in path:
        return 0
    if "/CORROSION/" in path:
        return 1
    return None


def split_of(path: str):
    top = path.split("/")[0].lower()
    return top if top in ("train", "test") else None


def dhash(img: np.ndarray) -> int:
    g = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (9, 8), interpolation=cv2.INTER_AREA)
    bits = (g[:, 1:] > g[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def groups(hashes, max_hamming: int):
    """Union-find over images whose hashes differ by at most `max_hamming` bits. Returns a group id per image."""
    n = len(hashes)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    h = np.array(hashes, dtype=np.uint64)
    for i in range(n):
        x = h[i] ^ h[i + 1:]
        # popcount of the xor
        dist = np.array([bin(int(v)).count("1") for v in x]) if len(x) else np.array([])
        for j in np.nonzero(dist <= max_hamming)[0]:
            a, b = find(i), find(i + 1 + int(j))
            if a != b:
                parent[b] = a
    return [find(i) for i in range(n)]


def build(zip_path: Path, out: Path, max_side: int = 512, hamming: int = 4, val_fraction: float = 0.15, seed: int = 7, log=print) -> dict:
    zf = zipfile.ZipFile(zip_path)
    items = []
    stats = Counter()
    for name in zf.namelist():
        if name.endswith("/") or not name.lower().endswith((".jpg", ".jpeg", ".png")):
            continue
        lab, sp = label_of(name), split_of(name)
        if lab is None or sp is None:
            stats["skipped_unrecognised_path"] += 1
            continue
        img = cv2.imdecode(np.frombuffer(zf.read(name), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            stats["skipped_unreadable"] += 1
            continue
        items.append({"name": name, "label": lab, "split": sp, "img": img, "hash": dhash(img)})
    log(f"read {len(items)} images")

    gid = groups([it["hash"] for it in items], hamming)
    by_group = defaultdict(list)
    for it, g in zip(items, gid):
        it["group"] = g
        by_group[g].append(it)

    keep = []
    for g, members in by_group.items():
        splits = {m["split"] for m in members}
        labels = {m["label"] for m in members}
        if len(labels) > 1:                       # the same picture filed under both classes: unusable
            stats["dropped_conflicting_labels"] += len(members)
            continue
        if "test" in splits:                      # test is untouchable: copies in train are dropped, one test copy is kept
            test_copies = [m for m in members if m["split"] == "test"]
            stats["dropped_duplicates_of_test_in_train"] += len(members) - len(test_copies)
            keep.append(test_copies[0])
            stats["dropped_duplicates_within_test"] += len(test_copies) - 1
        else:
            keep.append(members[0])               # one representative per group
            stats["dropped_duplicates_within_train"] += len(members) - 1

    # validation split from train, by group (each kept item is already its own group), stratified by label
    rng = random.Random(seed)
    train_items = [k for k in keep if k["split"] == "train"]
    for lab in (0, 1):
        pool = [k for k in train_items if k["label"] == lab]
        rng.shuffle(pool)
        for k in pool[: round(len(pool) * val_fraction)]:
            k["split"] = "val"

    counts = Counter()
    for k in keep:
        d = out / k["split"] / LABELS[k["label"]]
        d.mkdir(parents=True, exist_ok=True)
        img = k["img"]
        s = min(1.0, max_side / max(img.shape[:2]))
        if s < 1.0:
            img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        counts[(k["split"], LABELS[k["label"]])] += 1
        cv2.imwrite(str(d / f"{k['split']}_{LABELS[k['label']]}_{counts[(k['split'], LABELS[k['label']])]:05d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 90])

    result = {"source": zip_path.name, "labels": LABELS, "kept": {f"{s}/{l}": n for (s, l), n in sorted(counts.items())},
              "total_kept": sum(counts.values()), "read": len(items), "removed": dict(stats), "hamming": hamming, "max_side": max_side}
    (out / "stats.json").write_text(json.dumps(result, indent=2))
    (out / "README.md").write_text(
        "# Corrosion classification (auxiliary)\n\nBuilt by `training/build_corrosion_cls.py` from `Rust - Dataset.zip`. Image-level labels only "
        "(corrosion / no_corrosion); general corrosion on industrial and marine objects, not reinforcing steel in concrete. Near-duplicates "
        "removed and no group spans two splits. Use to teach rust texture; do not report accuracy on it as site accuracy.\n")
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--zip", default="E:/Datasets/Rust - Dataset.zip")
    ap.add_argument("--out", default="data/corrosion_cls")
    ap.add_argument("--max-side", type=int, default=512)
    ap.add_argument("--hamming", type=int, default=4)
    a = ap.parse_args()
    print(json.dumps(build(Path(a.zip), Path(a.out), a.max_side, a.hamming), indent=2))
