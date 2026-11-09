"""Real-photo evaluation of the yard model (TC-EVAL-REAL). The model is replaced by a fake predictor with known output."""

import json
import pathlib
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import evaluate_real as er  # noqa: E402

H, W = 100, 200
SAND, AGG, BRICK = er.CLASSES.index("sand_pile"), er.CLASSES.index("aggregate_pile"), er.CLASSES.index("brick_stack")
SQUARE = "0.1 0.2 0.5 0.2 0.5 0.8 0.1 0.8"          # x 20..100, y 20..80 on a 200x100 frame: 80 x 60 px


def make_set(root, labelled, frames):
    """frames: {stem: label text}. Writes images/test, labels/test and a stats.json whose mapping labels `labelled`."""
    (root / "images/test").mkdir(parents=True)
    (root / "labels/test").mkdir(parents=True)
    (root / "stats.json").write_text(json.dumps({"mapping": {f"src_{c}": c for c in labelled}}))
    for stem, label in frames.items():
        cv2.imwrite(str(root / "images/test" / f"{stem}.jpg"), np.full((H, W, 3), 120, np.uint8))
        (root / "labels/test" / f"{stem}.txt").write_text(label)


def box_mask(x1, y1, x2, y2):
    m = np.zeros((H, W), bool)
    m[y1:y2, x1:x2] = True
    return m


def test_ground_truth_polygons_are_rasterised_and_box_lines_ignored(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text(f"{SAND} {SQUARE}\n{BRICK} 0.5 0.5 0.2 0.2\n")
    gt = er.gt_masks(f, H, W)
    assert set(gt) == {SAND} and gt[SAND].sum() == pytest.approx(80 * 60, rel=0.05)
    assert er.gt_masks(tmp_path / "missing.txt", H, W) == {}


def test_a_perfect_predictor_scores_iou_one_and_zero_area_error(tmp_path):
    d = tmp_path / "piles"
    make_set(d, ["sand_pile"], {"a": f"{SAND} {SQUARE}", "b": f"{SAND} {SQUARE}"})
    perfect = lambda img: {SAND: er.gt_masks(d / "labels/test/a.txt", H, W)[SAND]}
    rep = er.evaluate([d], perfect, log=lambda *_: None)
    s = rep["classes"]["sand_pile"]
    assert s["recall"] == 1.0 and s["precision"] == 1.0 and s["pooled_pixel_iou"] == pytest.approx(1.0)
    assert s["median_abs_area_error_pct"] == pytest.approx(0.0, abs=0.1)


def test_a_predictor_that_finds_nothing_has_zero_recall_and_counts_a_miss_as_iou_zero(tmp_path):
    d = tmp_path / "piles"
    make_set(d, ["sand_pile"], {"a": f"{SAND} {SQUARE}"})
    rep = er.evaluate([d], lambda img: {}, log=lambda *_: None)
    s = rep["classes"]["sand_pile"]
    assert s["recall"] == 0.0 and s["median_frame_iou"] == 0.0 and s["precision"] is None


def test_a_class_the_dataset_does_not_label_is_never_scored_so_it_cannot_be_a_false_alarm(tmp_path):
    d = tmp_path / "piles"
    make_set(d, ["sand_pile"], {"a": f"{SAND} {SQUARE}"})
    finds_bricks_everywhere = lambda img: {SAND: box_mask(20, 20, 100, 80), BRICK: box_mask(0, 0, 200, 100)}
    rep = er.evaluate([d], finds_bricks_everywhere, log=lambda *_: None)
    assert "brick_stack" not in rep["classes"] and "brick_stack" in rep["classes_without_real_frames"]


def test_false_alarm_on_a_labelled_frame_without_the_material_lowers_precision(tmp_path):
    d = tmp_path / "piles"
    make_set(d, ["sand_pile"], {"a": f"{SAND} {SQUARE}", "b": ""})            # b is a frame with no sand
    everywhere = lambda img: {SAND: box_mask(20, 20, 100, 80)}
    s = er.evaluate([d], everywhere, log=lambda *_: None)["classes"]["sand_pile"]
    assert s["recall"] == 1.0 and s["precision"] == 0.5


def test_sand_and_aggregate_are_merged_into_a_pile_score_so_a_label_mix_up_is_not_a_miss(tmp_path):
    d = tmp_path / "site"
    make_set(d, ["aggregate_pile"], {"a": f"{AGG} {SQUARE}"})                  # the site set calls every heap "Aggregates"
    calls_it_sand = lambda img: {SAND: box_mask(20, 20, 100, 80)}
    rep = er.evaluate([d], calls_it_sand, log=lambda *_: None)
    assert rep["classes"]["aggregate_pile"]["recall"] == 0.0                   # strict class score: a miss
    assert rep["classes"]["pile (sand + aggregate)"]["recall"] == 1.0          # merged: the heap was found
    assert rep["classes"]["pile (sand + aggregate)"]["pooled_pixel_iou"] == pytest.approx(1.0, abs=0.05)


def test_over_measuring_shows_as_a_pred_over_true_area_above_one(tmp_path):
    d = tmp_path / "piles"
    make_set(d, ["sand_pile"], {"a": f"{SAND} {SQUARE}"})
    double = lambda img: {SAND: box_mask(20, 20, 100, 80) | box_mask(100, 20, 180, 80)}       # twice the true footprint
    s = er.evaluate([d], double, log=lambda *_: None)["classes"]["sand_pile"]
    assert s["median_pred_over_true_area"] == pytest.approx(2.0, rel=0.1) and s["median_abs_area_error_pct"] == pytest.approx(100, abs=10)     # polygon edges are inclusive: 81x61 vs 80x60 px
