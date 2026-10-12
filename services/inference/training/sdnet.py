"""
sdnet.py - SDNET2018 index and leakage-safe train/val/test split.

SDNET2018 (Utah State University, CC BY 4.0) holds 256x256 px patches cut from larger
photographs of concrete bridge decks, walls and pavements, sorted into Cracked / Non-cracked
folders. A file name is "<photo>-<patch>.jpg"; all patches with the same <photo> prefix (within
one surface) come from the same photograph.

Why the split is done per photo and not per patch
--------------------------------------------------
Neighbouring patches of one photograph share lighting, texture and colour. A random patch split
puts siblings in train and test, so the network can score well by recognising the photograph
instead of the crack. Here every photograph lives in exactly one split.

Known property of the copy in this project: only 13 photographs contribute Non-cracked patches
(Decks 7001-7004, Pavements 001-004, Walls 7069-7073); every other photograph contributes
Cracked patches only. These "full" photographs are the only place where both classes sit on the
same background, so they are spread over the splits first (one each to test and validation per
surface, the rest to training) and the cracked-only photographs are then divided 70/15/15.
"""

from __future__ import annotations

import os
import random
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Tuple

SURFACES = ("Decks", "Pavements", "Walls")
CLASS_DIRS = (("Non-cracked", 0), ("Cracked", 1))
IMAGE_EXTS = (".jpg", ".jpeg", ".png")


@dataclass(frozen=True)
class Sample:
    path: str
    label: int  # 1 = cracked
    surface: str
    photo: str  # photograph id, unique together with `surface`

    @property
    def group(self) -> Tuple[str, str]:
        return (self.surface, self.photo)


def index_sdnet(root: str) -> List[Sample]:
    samples: List[Sample] = []
    for surface in SURFACES:
        for folder, label in CLASS_DIRS:
            d = os.path.join(root, surface, folder)
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                if name.lower().endswith(IMAGE_EXTS):
                    samples.append(Sample(os.path.join(d, name), label, surface, name.split("-")[0]))
    if not samples:
        raise FileNotFoundError(f"no SDNET2018 images found under {root!r}")
    return samples


def index_site_folder(root: str) -> List[Sample]:
    """
    The team's own labelled crops from site/CCTV footage: <root>/cracked/*.jpg and <root>/clean/*.jpg.
    Include plenty of crack-free look-alikes (formwork joints, stains, shadows, dirt, rust): those are
    what SDNET lacks and what causes false alarms. Name files "<camera-or-session>_<n>.jpg"; the part
    before the first "_" is used as the photo id.
    """
    samples: List[Sample] = []
    for folder, label in (("clean", 0), ("cracked", 1)):
        d = os.path.join(root, folder)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.lower().endswith(IMAGE_EXTS):
                samples.append(Sample(os.path.join(d, name), label, "Site", name.split("_")[0]))
    return samples


def split_by_photo(samples: List[Sample], seed: int = 42,
                   frac: Tuple[float, float, float] = (0.70, 0.15, 0.15)) -> Dict[str, List[Sample]]:
    """Return {"train": [...], "val": [...], "test": [...]} with no photograph in two splits."""
    rng = random.Random(seed)
    classes_of = defaultdict(set)
    by_group = defaultdict(list)
    for s in samples:
        classes_of[s.group].add(s.label)
        by_group[s.group].append(s)

    assignment: Dict[Tuple[str, str], str] = {}
    for surface in SURFACES:
        full = sorted(g for g in by_group if g[0] == surface and classes_of[g] == {0, 1})
        only = sorted(g for g in by_group if g[0] == surface and classes_of[g] != {0, 1})
        rng.shuffle(full)
        rng.shuffle(only)
        # fully labelled photographs: test, val, then the rest train (needs >= 3 to cover all splits)
        for i, g in enumerate(full):
            assignment[g] = "test" if i == 0 else "val" if i == 1 else "train"
        n_val = max(1, round(len(only) * frac[1]))
        n_test = max(1, round(len(only) * frac[2]))
        for i, g in enumerate(only):
            assignment[g] = "test" if i < n_test else "val" if i < n_test + n_val else "train"

    out: Dict[str, List[Sample]] = {"train": [], "val": [], "test": []}
    for g, split in assignment.items():
        out[split].extend(by_group[g])
    return out


def describe(split: Dict[str, List[Sample]]) -> Dict[str, dict]:
    info = {}
    for name, items in split.items():
        info[name] = {
            "patches": len(items),
            "cracked": sum(s.label for s in items),
            "non_cracked": sum(1 - s.label for s in items),
            "photos": len({s.group for s in items}),
            "photos_with_non_cracked": len({s.group for s in items if s.label == 0}),
        }
    return info
