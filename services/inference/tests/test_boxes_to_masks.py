"""Box -> mask conversion for the yard datasets (TC-DATA-MASK). SAM is replaced by a fake that returns known masks."""

import json
import pathlib
import sys
from collections import Counter

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from training import boxes_to_masks as b2m  # noqa: E402


def fake_sam(fill=1.0):
    """A 'SAM' that fills each box rectangle (scaled by `fill` of its width and height)."""
    def predict(img, boxes):
        out = []
        for x1, y1, x2, y2 in boxes:
            m = np.zeros(img.shape[:2], bool)
            w, h = (x2 - x1) * fill, (y2 - y1) * fill
            m[int(y1):int(y1 + h), int(x1):int(x1 + w)] = True
            out.append(m)
        return out
    return predict


def box(cls, x1, y1, x2, y2):
    return {"cls": cls, "xyxy": [x1, y1, x2, y2]}


def test_class_names_are_read_from_both_roboflow_yaml_forms(tmp_path):
    a = tmp_path / "a.yaml"
    a.write_text("train: ../train/images\nnc: 2\nnames: ['bag', 'pallet']\n")
    b = tmp_path / "b.yaml"
    b.write_text("path: x\nnames:\n  0: Sand\n  1: Rock\nroboflow:\n  workspace: w\n")
    c = tmp_path / "c.yaml"
    c.write_text("names:\n- cement_bag\n- other\n")
    assert b2m.read_names(a) == ["bag", "pallet"]
    assert b2m.read_names(b) == ["Sand", "Rock"]
    assert b2m.read_names(c) == ["cement_bag", "other"]


def test_yolo_boxes_accepts_box_and_polygon_lines(tmp_path):
    f = tmp_path / "l.txt"
    f.write_text("1 0.5 0.5 0.2 0.4\n0 0.1 0.1 0.3 0.1 0.3 0.3 0.1 0.3\n")
    b = b2m.yolo_boxes(f, 1000, 500)
    assert b[0]["cls"] == 1 and b[0]["xyxy"] == pytest.approx([400, 150, 600, 350])
    assert b[1]["cls"] == 0 and b[1]["xyxy"] == pytest.approx([100, 50, 300, 150])
    assert b2m.yolo_boxes(tmp_path / "missing.txt", 10, 10) == []


def test_a_good_mask_becomes_a_normalised_polygon_with_the_yard_class():
    img = np.zeros((200, 400, 3), np.uint8)
    stats = Counter()
    lines = b2m.convert_image(img, [box(0, 100, 50, 300, 150)], {0: 1}, fake_sam(1.0), 60, stats)
    assert len(lines) == 1 and lines[0].split()[0] == "1" and stats["instances_kept"] == 1
    pts = np.array(lines[0].split()[1:], float).reshape(-1, 2)
    assert pts.min() >= 0 and pts.max() <= 1 and len(pts) >= 3
    xs, ys = pts[:, 0] * 400, pts[:, 1] * 200
    assert xs.min() == pytest.approx(100, abs=2) and xs.max() == pytest.approx(299, abs=2) and ys.min() == pytest.approx(50, abs=2)


def test_masks_that_are_too_small_or_spill_out_of_the_box_are_dropped_and_counted():
    img = np.zeros((200, 400, 3), np.uint8)
    s = Counter()
    assert b2m.convert_image(img, [box(0, 100, 50, 300, 150)], {0: 0}, fake_sam(0.3), 60, s) == []      # 9 % of the box
    assert s["dropped_mask_too_small"] == 1

    def spill(image, boxes):
        m = np.zeros(image.shape[:2], bool)
        m[:, :] = True                                                                                  # the whole image
        return [m for _ in boxes]
    assert b2m.convert_image(img, [box(0, 100, 50, 150, 100)], {0: 0}, spill, 60, s) == []
    assert s["dropped_mask_spills_out_of_box"] == 1

    assert b2m.convert_image(img, [box(0, 10, 10, 50, 50)], {0: 0}, lambda i, b: [None], 60, s) == []
    assert s["dropped_no_mask"] == 1


def test_crowded_counting_images_are_skipped_and_unmapped_classes_are_ignored():
    img = np.zeros((300, 300, 3), np.uint8)
    s = Counter()
    many = [box(0, 5 * i, 5 * i, 5 * i + 4, 5 * i + 4) for i in range(10)]
    assert b2m.convert_image(img, many, {0: 4}, fake_sam(), 5, s) == []
    assert s["images_skipped_crowded"] == 1 and s["boxes_in_skipped_images"] == 10
    s2 = Counter()
    lines = b2m.convert_image(img, [box(0, 10, 10, 100, 100), box(1, 120, 120, 200, 200)], {0: 0}, fake_sam(), 60, s2)
    assert len(lines) == 1 and s2["boxes_unmapped_class"] == 1


def _roboflow_tree(root):
    (root).mkdir(parents=True)
    (root / "data.yaml").write_text("names: ['bag', 'person']\n")
    for sub in ("train", "valid", "test"):
        (root / sub / "images").mkdir(parents=True)
        (root / sub / "labels").mkdir(parents=True)
    for sub, stem in (("train", "a"), ("train", "b"), ("valid", "c"), ("test", "d")):
        cv2.imwrite(str(root / sub / "images" / f"{stem}.jpg"), np.full((120, 160, 3), 90, np.uint8))
    (root / "train/labels/a.txt").write_text("0 0.5 0.5 0.4 0.4\n1 0.2 0.2 0.1 0.1\n")        # a bag and a person
    (root / "train/labels/b.txt").write_text("1 0.5 0.5 0.4 0.4\n")                             # only a person: no yard label
    (root / "valid/labels/c.txt").write_text("0 0.3 0.3 0.2 0.2\n")
    (root / "test/labels/d.txt").write_text("0 0.6 0.6 0.2 0.2\n")


def test_build_end_to_end_writes_yard_class_labels_and_never_writes_unlabelled_images(tmp_path):
    src = tmp_path / "cement"
    _roboflow_tree(src)
    r = b2m.build(src, tmp_path / "out", {"bag": "cement_bags"}, fake_sam(), log=lambda *_: None)
    assert r["auto_labelled"] is True
    assert r["stats"]["images_written"] == 3 and r["stats"]["images_without_labels"] == 1      # image b had only a person
    assert r["stats"]["written_train"] == 1 and r["stats"]["written_val"] == 1 and r["stats"]["written_test"] == 1
    lab = next((tmp_path / "out" / "labels" / "train").glob("*.txt")).read_text().split()
    assert lab[0] == "0"                                                                       # cement_bags is yard class 0
    assert "AUTO-LABELLED" in (tmp_path / "out" / "README.md").read_text()
    assert json.loads((tmp_path / "out" / "stats.json").read_text())["mapping"] == {"bag": "cement_bags"}


def test_polygons_already_in_the_source_are_kept_as_drawn_without_sam(tmp_path):
    src = tmp_path / "piles"
    _roboflow_tree(src)
    (src / "data.yaml").write_text("names: ['Rock', 'Sand']\n")
    (src / "train/labels/a.txt").write_text("1 0.1 0.1 0.9 0.1 0.9 0.9 0.1 0.9\n0 0.5 0.5 0.2 0.2\n")     # a Sand polygon and a Rock box
    for stem, sub in (("b", "train"), ("c", "valid"), ("d", "test")):
        (src / sub / "labels" / f"{stem}.txt").write_text("")

    def no_sam(img, boxes):
        return [None] * len(boxes)
    r = b2m.build(src, tmp_path / "out", {"Sand": "sand_pile", "Rock": "aggregate_pile"}, no_sam, log=lambda *_: None)
    assert r["stats"]["polygons_passed_through"] == 1 and r["stats"]["images_written"] == 1
    assert r["stats"]["dropped_no_mask"] == 1                                                      # the Rock BOX needed SAM, which gave nothing
    lab = (tmp_path / "out/labels/train").glob("*.txt").__next__().read_text().split()
    assert lab[0] == "1" and lab[1:] == ["0.100000", "0.100000", "0.900000", "0.100000", "0.900000", "0.900000", "0.100000", "0.900000"]
    assert r["auto_labelled"] is False


def test_a_picture_in_two_splits_is_removed_from_the_less_protected_one(tmp_path):
    rng = np.random.default_rng(1)
    a, b, c = (rng.integers(0, 255, (80, 80, 3), dtype=np.uint8) for _ in range(3))
    for sp in ("train", "val", "test"):
        (tmp_path / "images" / sp).mkdir(parents=True)
        (tmp_path / "labels" / sp).mkdir(parents=True)
    for sp, name, im in (("train", "a_tr", a), ("val", "a_va", a), ("test", "a_te", a), ("train", "b_tr", b), ("val", "c_va", c)):
        cv2.imwrite(str(tmp_path / "images" / sp / f"{name}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 95])
        (tmp_path / "labels" / sp / f"{name}.txt").write_text("0 0.1 0.1 0.9 0.1 0.5 0.9")
    r = b2m.dedupe_splits(tmp_path)
    assert r == {"removed_from_train": 1, "removed_from_val": 1}
    assert [p.name for p in (tmp_path / "images/test").glob("*")] == ["a_te.jpg"]                  # the test copy is never the one removed
    assert not (tmp_path / "images/train/a_tr.jpg").exists() and not (tmp_path / "labels/train/a_tr.txt").exists()
    assert (tmp_path / "images/train/b_tr.jpg").exists() and (tmp_path / "images/val/c_va.jpg").exists()


def test_source_copies_of_a_protected_picture_are_skipped_before_conversion(tmp_path):
    src = tmp_path / "s"
    rng = np.random.default_rng(4)
    a, b = (rng.integers(0, 255, (80, 80, 3), dtype=np.uint8) for _ in range(2))
    for sub, name, im in (("train", "a_tr", a), ("valid", "a_va", a), ("test", "b_te", b), ("train", "b_tr", b), ("train", "only", rng.integers(0, 255, (80, 80, 3), dtype=np.uint8))):
        (src / sub / "images").mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(src / sub / "images" / f"{name}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 95])
    skip = b2m.source_duplicates(src)
    assert {p.name for p in skip} == {"a_tr.jpg", "b_tr.jpg"}                                       # val beats train, test beats train


def test_resume_never_runs_sam_again_on_an_image_that_is_already_converted(tmp_path):
    src = tmp_path / "cement"
    _roboflow_tree(src)
    calls = []

    def counting_sam(img, boxes):
        calls.append(len(boxes))
        return fake_sam()(img, boxes)
    mp = {"bag": "cement_bags"}
    b2m.build(src, tmp_path / "out", mp, counting_sam, log=lambda *_: None)
    first = len(calls)
    assert first >= 1
    r = b2m.build(src, tmp_path / "out", mp, counting_sam, log=lambda *_: None, resume=True)
    assert len(calls) == first                                                                       # SAM was not called again
    assert r["stats"]["resumed_already_converted"] >= 3 and r["stats"]["labels_on_disk_images"] == 3
    # an interrupted run: remove one finished image and its marker entry; only that one is redone
    for f in (tmp_path / "out/images/train").glob("*.jpg"):
        f.unlink()
    for f in (tmp_path / "out/labels/train").glob("*.txt"):
        f.unlink()
    (tmp_path / "out/.processed.txt").write_text("")
    r2 = b2m.build(src, tmp_path / "out", mp, counting_sam, log=lambda *_: None, resume=True)
    assert len(calls) > first and r2["stats"]["labels_on_disk_images"] == 3


def test_an_unmatched_mapping_is_an_error_not_an_empty_dataset(tmp_path):
    src = tmp_path / "x"
    _roboflow_tree(src)
    with pytest.raises(SystemExit):
        b2m.build(src, tmp_path / "out", {"cement": "cement_bags"}, fake_sam(), log=lambda *_: None)


def test_combine_writes_one_yaml_with_the_yard_class_names(tmp_path):
    for n in ("a", "b"):
        (tmp_path / n / "images" / "train").mkdir(parents=True)
        (tmp_path / n / "images" / "val").mkdir(parents=True)
    y = tmp_path / "yard.yaml"
    b2m.combine([tmp_path / "a", tmp_path / "b"], y)
    text = y.read_text()
    assert text.count("/images/train") == 2 and "0: cement_bags" in text and "4: rebar_bundle" in text
    assert "test:\n" in text and "/images/test" not in text                                    # no test split present, none listed
