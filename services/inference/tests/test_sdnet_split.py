"""SDNET2018 split per photograph (TC-DATA): no photograph in two splits, in both the small and the complete copy."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "training"))

import sdnet  # noqa: E402


def photo(surface, pid, n_clean, n_cracked):
    out = [sdnet.Sample(f"{surface}/{pid}-{i}c.jpg", 0, surface, pid) for i in range(n_clean)]
    out += [sdnet.Sample(f"{surface}/{pid}-{i}x.jpg", 1, surface, pid) for i in range(n_cracked)]
    return out


def groups_of(items):
    return {s.group for s in items}


def test_no_photograph_is_in_two_splits_in_the_complete_dataset():
    samples = []
    for surface in sdnet.SURFACES:
        for k in range(75):                                   # 75 photographs with both classes per surface, like the full copy
            samples += photo(surface, f"{k:04d}", 5, 2)
    sp = sdnet.split_by_photo(samples)
    g = {k: groups_of(v) for k, v in sp.items()}
    assert not (g["train"] & g["val"]) and not (g["train"] & g["test"]) and not (g["val"] & g["test"])
    assert sum(len(v) for v in sp.values()) == len(samples)                       # every patch lands somewhere
    assert len(g["test"]) >= 30 and len(g["val"]) >= 30                           # dozens of photographs, not one per surface
    assert abs(len(g["train"]) - 0.7 * 225) <= 6


def test_the_small_copy_keeps_one_full_photograph_each_for_test_and_validation():
    samples = []
    for surface in sdnet.SURFACES:
        for k in range(4):                                    # 4 full photographs per surface (the repo subset has 4 or 5)
            samples += photo(surface, f"f{k}", 3, 3)
        for k in range(10):                                   # cracked-only photographs
            samples += photo(surface, f"c{k}", 0, 4)
    sp = sdnet.split_by_photo(samples)
    for name in ("test", "val"):
        full_in = {s.group for s in sp[name] if s.label == 0}
        assert len(full_in) == 3                                                  # one clean photograph per surface
    g = {k: groups_of(v) for k, v in sp.items()}
    assert not (g["train"] & g["val"]) and not (g["train"] & g["test"]) and not (g["val"] & g["test"])


def test_split_is_reproducible_for_a_seed_and_changes_with_it():
    samples = [s for surface in sdnet.SURFACES for k in range(30) for s in photo(surface, f"{k:03d}", 2, 1)]
    a = {k: groups_of(v) for k, v in sdnet.split_by_photo(samples, seed=1).items()}
    b = {k: groups_of(v) for k, v in sdnet.split_by_photo(samples, seed=1).items()}
    c = {k: groups_of(v) for k, v in sdnet.split_by_photo(samples, seed=2).items()}
    assert a == b and a != c
