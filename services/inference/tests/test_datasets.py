"""Dataset builders (TC-DATA): CODEBRIM -> YOLO labels, and the corrosion classification set."""

import json
import pathlib
import sys
import zipfile

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from training import build_codebrim_yolo as cb  # noqa: E402
from training import build_corrosion_cls as cc  # noqa: E402

CATS = {1: "0 Efflorescence", 2: "1 CorrosionStain", 3: "2 Crack", 4: "3 Spallation", 5: "4 ExposedBars", 6: "Background", 0: "CODEBRIM"}
ID = {v: k for k, v in CATS.items()}


def ann(cat, box):
    return {"category_id": ID[cat], "bbox": box}


# ---------------------------------------------------------------- CODEBRIM conversion
def test_native_scheme_keeps_five_classes_and_normalises_boxes():
    lines, dropped = cb.yolo_lines([ann("2 Crack", [100, 200, 50, 20])], CATS, 1000, 500, 1.0, "native")
    assert lines == ["2 0.125000 0.420000 0.050000 0.040000"] and not dropped


def test_background_category_is_dropped_not_converted():
    lines, dropped = cb.yolo_lines([ann("Background", [0, 0, 100, 100]), ann("CODEBRIM", [0, 0, 5, 5])], CATS, 1000, 500, 1.0, "native")
    assert lines == [] and dropped["background_or_unknown"] == 2


def test_platform_scheme_merges_rust_classes_and_leaves_efflorescence_unlabelled():
    anns = [ann("1 CorrosionStain", [0, 0, 40, 40]), ann("4 ExposedBars", [10, 10, 40, 40]), ann("2 Crack", [0, 0, 40, 40]),
            ann("3 Spallation", [0, 0, 40, 40]), ann("0 Efflorescence", [0, 0, 40, 40])]
    lines, dropped = cb.yolo_lines(anns, CATS, 400, 400, 1.0, "platform")
    assert [int(l.split()[0]) for l in lines] == [1, 1, 0, 2]            # rusted_rebar twice, crack, spalling
    assert dropped["unlabelled_in_platform:efflorescence"] == 1
    assert cb.PLATFORM == ["concrete_crack", "rusted_rebar", "spalling"]


def test_boxes_are_clipped_to_the_image_and_tiny_ones_dropped():
    lines, dropped = cb.yolo_lines([ann("2 Crack", [-20, -20, 70, 70]), ann("2 Crack", [10, 10, 1, 1])], CATS, 100, 100, 0.5, "native")
    cx, cy, w, h = map(float, lines[0].split()[1:])
    assert (cx, cy, w, h) == (0.25, 0.25, 0.5, 0.5)                          # clipped to [0, 50]
    assert dropped["too_small"] == 1                                         # 1 px * 0.5 scale < 2 px


def test_every_label_value_is_inside_zero_one():
    anns = [ann("3 Spallation", [900, 400, 300, 300])]                       # runs past the image edge
    for line in cb.yolo_lines(anns, CATS, 1000, 500, 1.0, "native")[0]:
        assert all(0.0 <= float(v) <= 1.0 for v in line.split()[1:])


def test_build_end_to_end_on_a_tiny_export(tmp_path):
    src = tmp_path / "src"
    for sub, n in (("train", 2), ("valid", 1), ("test", 1)):
        (src / sub).mkdir(parents=True)
        images, anns = [], []
        for i in range(n):
            fn = f"image_{sub}{i}0001_jpg.rf.abc.jpg".replace("image_", "image_0")
            cv2.imwrite(str(src / sub / fn), np.random.default_rng(i).integers(0, 255, (300, 400, 3), dtype=np.uint8))
            images.append({"id": i, "file_name": fn, "width": 400, "height": 300})
            anns.append({"image_id": i, "category_id": ID["2 Crack"], "bbox": [40, 30, 80, 60]})
        (src / sub / "_annotations.coco.json").write_text(json.dumps({"images": images, "annotations": anns, "categories": [{"id": k, "name": v} for k, v in CATS.items()]}))
    stats = cb.build(src, tmp_path / "out", "native", max_side=200, workers=1, log=lambda *_: None)
    assert stats["images"] == {"train": 2, "val": 1, "test": 1} and stats["boxes_per_class"] == {"crack": 4}
    assert (tmp_path / "out" / "data.yaml").exists() and "crack" in (tmp_path / "out" / "data.yaml").read_text()
    out_img = cv2.imread(str(next((tmp_path / "out" / "images" / "train").glob("*.jpg"))))
    assert max(out_img.shape[:2]) == 200                                     # resized to the long-side limit
    # a platform build reusing the resized images gives the same boxes under platform names
    p = cb.build(src, tmp_path / "plat", "platform", max_side=200, workers=1, reuse=tmp_path / "out", log=lambda *_: None)
    assert p["boxes_per_class"] == {"concrete_crack": 4}


# ---------------------------------------------------------------- corrosion classification
def test_nocorrosion_is_not_mistaken_for_corrosion():
    """'CORROSION' is a substring of 'NOCORROSION': testing in the wrong order would label every clean image as rusty."""
    assert cc.label_of("train/train/NOCORROSION/1.jpg") == 0
    assert cc.label_of("train/train/CORROSION/1.jpg") == 1
    assert cc.label_of("train/train/OTHER/1.jpg") is None
    assert cc.split_of("test/test/CORROSION/1.jpg") == "test" and cc.split_of("misc/1.jpg") is None


def test_near_duplicates_are_grouped_and_different_pictures_are_not():
    rng = np.random.default_rng(0)
    a = rng.integers(0, 255, (80, 80, 3), dtype=np.uint8)
    b = np.clip(a.astype(int) + rng.integers(-3, 4, a.shape), 0, 255).astype(np.uint8)      # same picture, slight noise
    c = rng.integers(0, 255, (80, 80, 3), dtype=np.uint8)
    g = cc.groups([cc.dhash(a), cc.dhash(b), cc.dhash(c)], 4)
    assert g[0] == g[1] and g[0] != g[2]


def _jpg(seed, w=96, h=96):
    img = np.random.default_rng(seed).integers(0, 255, (h, w, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", img)[1].tobytes()


def test_corrosion_build_removes_duplicates_and_never_leaks_into_test(tmp_path):
    z = tmp_path / "r.zip"
    with zipfile.ZipFile(z, "w") as f:
        for i in range(12):
            f.writestr(f"train/train/CORROSION/{i}.jpg", _jpg(i))
            f.writestr(f"train/train/NOCORROSION/{i}.jpg", _jpg(100 + i))
        f.writestr("test/test/CORROSION/t0.jpg", _jpg(0))                  # identical picture to train/CORROSION/0
        f.writestr("test/test/CORROSION/t1.jpg", _jpg(500))
        f.writestr("test/test/NOCORROSION/t2.jpg", _jpg(600))
        f.writestr("train/train/CORROSION/dup.jpg", _jpg(3))               # duplicate inside train
    r = cc.build(z, tmp_path / "out", max_side=64, log=lambda *_: None)
    assert r["removed"]["dropped_duplicates_of_test_in_train"] == 1
    assert r["removed"]["dropped_duplicates_within_train"] == 1
    kept = r["kept"]
    assert kept["test/corrosion"] == 2 and kept["test/no_corrosion"] == 1
    assert kept.get("val/corrosion", 0) >= 1 and kept.get("val/no_corrosion", 0) >= 1            # a stratified validation split exists
    # 13 corrosion in train - 1 copy of a test picture - 1 internal duplicate + 2 test = 13; 12 clean in train + 1 test = 13
    assert sum(kept.values()) == r["total_kept"] == 26
    # no image hash appears in two splits
    seen = {}
    for p in (tmp_path / "out").rglob("*.jpg"):
        h = cc.dhash(cv2.imread(str(p)))
        assert seen.setdefault(h, p.parts[-3]) == p.parts[-3], "a picture sits in two splits"
    assert (tmp_path / "out" / "README.md").exists()
