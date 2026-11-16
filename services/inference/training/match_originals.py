"""
match_originals.py - map recompressed copies (e.g. WhatsApp) back to the original phone files.

    python training/match_originals.py --manifest data/gilgit_real/manifest.csv --originals <folder of originals> --out mapping.csv

Why: the first real footage reached us through WhatsApp (resized, recompressed, no EXIF date). The originals
have the capture time and full resolution. Grades and draft labels are keyed by the WhatsApp file name, so each
copy has to be tied to its original. Matching is by picture content (a 64x64 difference hash), so file names do
not matter; for a video, five frames across its length are compared.

A match is accepted only when it is close (<= --max-distance bits of 64) AND clearly better than the second-best
original (--margin). Everything else is listed as "ambiguous" or "no match" so a person can decide: never trust a
silent best guess for evidence.
"""

from __future__ import annotations

import argparse
import csv
import pathlib
from typing import Dict, List, Optional, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
VIDEO_EXT = {".mp4", ".mov", ".3gp", ".mkv", ".avi"}
FRACTIONS = (0.1, 0.3, 0.5, 0.7, 0.9)


def dhash(gray: np.ndarray) -> np.ndarray:
    small = cv2.resize(cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA), (9, 8), interpolation=cv2.INTER_AREA)
    return (small[:, 1:] > small[:, :-1]).flatten()


def image_hash(path: pathlib.Path) -> Optional[np.ndarray]:
    try:
        im = ImageOps.exif_transpose(Image.open(path)).convert("L")          # originals may store rotation in EXIF; WhatsApp copies have it applied
        return dhash(np.asarray(im))
    except Exception:
        return None


def video_hashes(path: pathlib.Path) -> List[np.ndarray]:
    cap = cv2.VideoCapture(str(path))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    out = []
    for f in FRACTIONS:
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(n * f) - 1))
        ok, fr = cap.read()
        if ok:
            out.append(dhash(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)))
    cap.release()
    return out


def distance(a: np.ndarray, b: np.ndarray) -> int:
    return int((a != b).sum())


def best_matches(query: Sequence[np.ndarray], originals: Dict[str, List[np.ndarray]]) -> List[tuple]:
    """(distance, original name) sorted ascending; the distance of an original is its closest frame to any query frame."""
    scored = []
    for name, hs in originals.items():
        scored.append((min(distance(q, h) for q in query for h in hs), name))
    return sorted(scored)


def match(copies: Dict[str, List[np.ndarray]], originals: Dict[str, List[np.ndarray]], max_distance: int = 10, margin: int = 4) -> List[dict]:
    rows = []
    for name, hs in copies.items():
        if not hs:
            rows.append({"copy": name, "original": "", "distance": "", "status": "unreadable"}); continue
        ranked = best_matches(hs, originals)
        if not ranked:
            rows.append({"copy": name, "original": "", "distance": "", "status": "no originals"}); continue
        d1, o1 = ranked[0]
        d2 = ranked[1][0] if len(ranked) > 1 else 99
        status = "matched" if d1 <= max_distance and d2 - d1 >= margin else "ambiguous" if d1 <= max_distance else "no match"
        rows.append({"copy": name, "original": o1 if status != "no match" else "", "distance": d1, "status": status})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="manifest.csv with a local_file column (path relative to the manifest's folder)")
    ap.add_argument("--originals", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-distance", type=int, default=10)
    ap.add_argument("--margin", type=int, default=4)
    a = ap.parse_args()

    mf = pathlib.Path(a.manifest)
    copies: Dict[str, List[np.ndarray]] = {}
    for r in csv.DictReader(open(mf, encoding="utf-8-sig")):
        p = mf.parent / r["local_file"]
        ext = p.suffix.lower()
        copies[r["local_file"]] = video_hashes(p) if ext in VIDEO_EXT else [h] if (h := image_hash(p)) is not None else []
    originals: Dict[str, List[np.ndarray]] = {}
    for p in sorted(pathlib.Path(a.originals).rglob("*")):
        ext = p.suffix.lower()
        if ext in VIDEO_EXT:
            originals[str(p)] = video_hashes(p)
        elif ext in IMAGE_EXT:
            h = image_hash(p)
            if h is not None:
                originals[str(p)] = [h]
    originals = {k: v for k, v in originals.items() if v}
    rows = match(copies, originals, a.max_distance, a.margin)
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, ["copy", "original", "distance", "status"]); w.writeheader(); w.writerows(rows)
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in ("matched", "ambiguous", "no match", "unreadable")}
    print(f"{len(copies)} copies against {len(originals)} originals:", counts)
    used = [r["original"] for r in rows if r["status"] == "matched"]
    dup = {o for o in used if used.count(o) > 1}
    if dup:
        print("WARNING: these originals were matched by more than one copy (near-duplicate pictures):", sorted(dup)[:5])


if __name__ == "__main__":
    main()
