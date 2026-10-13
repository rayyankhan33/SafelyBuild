"""Smoke tests for the evaluation harness, using small synthetic labelled sets."""
import json
import pathlib
import sys

import cv2
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import demo_frames as df  # noqa: E402
import evaluate  # noqa: E402


def write(dirpath, name, img):
    cv2.imwrite(str(dirpath / name), img)


def test_stage_evaluation_on_synthetic_set(tmp_path):
    labels = []
    for stage in (0, 1, 2, 3):
        write(tmp_path, f"s{stage}.png", df.render_zone("slab", stage, seed=stage))
        labels.append({"file": f"s{stage}.png", "element_type": "slab", "stage": stage})
    write(tmp_path, "w.png", df.render_zone("masonry_wall", fraction=0.6, seed=1))
    labels.append({"file": "w.png", "element_type": "masonry_wall", "fraction": 0.6})
    (tmp_path / "labels.json").write_text(json.dumps(labels))
    res = evaluate.run("stage", "classical_color", str(tmp_path))
    assert res["accuracy"] == 1.0 and res["within_one_stage"] == 1.0
    assert res["masonry_fraction_mae"] < 0.03
    assert res["model"]["backend"] == "classical_color"


def test_inventory_evaluation_reports_error_and_bias(tmp_path):
    labels = []
    for i, q in enumerate((50.0, 90.0)):
        write(tmp_path, f"y{i}.png", df.render_yard({"SAND": q}, 0.1, seed=i))
        labels.append({"file": f"y{i}.png", "scale_m_per_px": 0.1, "stock": {"SAND": q}})
    (tmp_path / "labels.json").write_text(json.dumps(labels))
    res = evaluate.run("inventory", "classical_color", str(tmp_path))
    sand = res["per_material"]["SAND"]
    assert sand["n"] == 2 and sand["mape"] < 0.08
    assert sand["bias"] < 0  # the classical estimator reads a few percent low on synthetic frames


def test_defects_evaluation_counts_precision_and_recall(tmp_path):
    sample = ROOT / "samples" / "Rusted Rebar 2.jpg"
    (tmp_path / "rust.jpg").write_bytes(sample.read_bytes())
    write(tmp_path, "clean.png", df.render_zone("slab", 0))
    labels = [{"file": "rust.jpg", "boxes": []}, {"file": "clean.png", "boxes": []}]  # nothing labelled: any finding is a false positive
    (tmp_path / "labels.json").write_text(json.dumps(labels))
    res = evaluate.run("defects", "opencv_tiles", str(tmp_path))
    assert res["recall"] == 0.0 and res["precision"] == 0.0
    assert res["images"] == 2


def test_cli_reports_unavailable_backend(tmp_path, capsys):
    (tmp_path / "labels.json").write_text("[]")
    code = evaluate.main(["--task", "stage", "--backend", "does_not_exist", "--data", str(tmp_path)])
    assert code == 2 and "no backend named" in capsys.readouterr().err


def test_cli_missing_labels(tmp_path):
    assert evaluate.main(["--task", "stage", "--data", str(tmp_path)]) == 2
