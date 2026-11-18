"""TC-DATA-MATCH: recompressed copies are tied back to their originals by picture content, and doubtful matches are not guessed."""

import csv
import pathlib
import subprocess
import sys

import cv2
import numpy as np
import pytest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / "training"))

import match_originals as mo  # noqa: E402


def scene(seed: int, size=(480, 640)) -> np.ndarray:
    """A textured picture that is different for every seed (blobs and lines on a gradient)."""
    rng = np.random.default_rng(seed)
    h, w = size
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = rng.integers(40, 200, 3)
    for _ in range(25):
        c = tuple(int(v) for v in rng.integers(0, 255, 3))
        cv2.circle(img, (int(rng.integers(0, w)), int(rng.integers(0, h))), int(rng.integers(10, 90)), c, -1)
    for _ in range(12):
        cv2.line(img, (int(rng.integers(0, w)), int(rng.integers(0, h))), (int(rng.integers(0, w)), int(rng.integers(0, h))), (255, 255, 255), 3)
    return img


def save(path: pathlib.Path, img: np.ndarray, quality: int) -> None:
    cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tofile(str(path))


def test_recompressed_and_resized_copies_find_their_originals_and_a_stranger_is_not_matched(tmp_path):
    orig, copies = tmp_path / "orig", tmp_path / "copies"
    orig.mkdir(); copies.mkdir()
    for i in range(6):
        big = scene(i, (1440, 1920))
        save(orig / f"IMG_{i}.jpg", big, 97)                                         # the original: large, high quality
        save(copies / f"c{i}.jpg", cv2.resize(big, (480, 360)), 55)                  # the WhatsApp copy: small, heavily compressed
    save(copies / "stranger.jpg", scene(99, (360, 480)), 55)                          # a picture with no original
    rows = {r["copy"]: r for r in mo.match({p.name: [mo.image_hash(p)] for p in copies.iterdir()},
                                           {str(p): [mo.image_hash(p)] for p in orig.iterdir()})}
    for i in range(6):
        assert rows[f"c{i}.jpg"]["status"] == "matched" and rows[f"c{i}.jpg"]["original"].endswith(f"IMG_{i}.jpg")
    assert rows["stranger.jpg"]["status"] in ("no match", "ambiguous")             # never a silent guess


def test_two_identical_originals_make_the_match_ambiguous(tmp_path):
    img = scene(3, (480, 640))
    save(tmp_path / "a.jpg", img, 95); save(tmp_path / "b.jpg", img, 95); save(tmp_path / "copy.jpg", cv2.resize(img, (320, 240)), 60)
    rows = mo.match({"copy": [mo.image_hash(tmp_path / "copy.jpg")]}, {"a": [mo.image_hash(tmp_path / "a.jpg")], "b": [mo.image_hash(tmp_path / "b.jpg")]})
    assert rows[0]["status"] == "ambiguous"


def test_unreadable_copy_is_reported(tmp_path):
    bad = tmp_path / "bad.jpg"; bad.write_bytes(b"not an image")
    assert mo.image_hash(bad) is None
    assert mo.match({"bad.jpg": []}, {"a": [np.zeros(64, bool)]})[0]["status"] == "unreadable"


def test_command_line_end_to_end(tmp_path):
    (tmp_path / "data" / "whatsapp").mkdir(parents=True); (tmp_path / "orig").mkdir()
    for i in range(3):
        big = scene(10 + i, (960, 1280))
        save(tmp_path / "orig" / f"P{i}.jpg", big, 95)
        save(tmp_path / "data" / "whatsapp" / f"w{i}.jpg", cv2.resize(big, (480, 360)), 50)
    with open(tmp_path / "data" / "manifest.csv", "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["local_file"]); [w.writerow([f"whatsapp/w{i}.jpg"]) for i in range(3)]
    out = tmp_path / "map.csv"
    r = subprocess.run([sys.executable, str(HERE / "training" / "match_originals.py"), "--manifest", str(tmp_path / "data" / "manifest.csv"),
                        "--originals", str(tmp_path / "orig"), "--out", str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    rows = list(csv.DictReader(open(out)))
    assert [x["status"] for x in rows] == ["matched"] * 3 and "3 copies against 3 originals" in r.stdout
