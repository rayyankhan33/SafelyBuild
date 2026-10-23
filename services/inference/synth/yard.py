"""
synth/yard.py - SYNTHETIC yard-camera scenes with exact ground truth, for training and testing the
material-inventory model (the vision half of the financial module).

Each scene is a fixed overhead-ish view of a material yard. The scene is built FROM a true state
(how many bags, how many m3 of sand, ...), so every frame comes with:

  * instance polygons per class (YOLO-segmentation labels)
  * the true quantity of each material and the ground scale (m per pixel)

Geometry follows scene.py so a mask area maps to a quantity with the same documented formulas:
  sand / aggregate  cone volume from the pile footprint (angle of repose 34 / 38 degrees)
  cement            footprint / 0.15 m2 bag face x 8 layers
  brick             footprint x 600 per m2
  rebar             footprint x 600 kg per m2

Domain randomisation (so a model cannot just learn one flat colour): random ground, material colours
and textures, shading, hard-negative distractors (white tarps, grey slabs, red containers, yellow
machines, pallets, workers, cones, shadows, puddles), white balance, haze, blur, noise, JPEG.

THESE ARE NOT REAL PHOTOS. A model measured here has proven it can learn the task on this synthetic
distribution; it says nothing certain about real yards (see docs/financial-model.md).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

import scene

W, H = 1280, 720
CLASSES = ["cement_bags", "sand_pile", "aggregate_pile", "brick_stack", "rebar_bundle"]
CODE = {"cement_bags": "CEMENT", "sand_pile": "SAND", "aggregate_pile": "AGGREGATE", "brick_stack": "BRICK", "rebar_bundle": "REBAR"}
UNIT = {"CEMENT": "bag", "SAND": "m3", "AGGREGATE": "m3", "BRICK": "nos", "REBAR": "kg"}

# true quantity ranges per class (min, max)
RANGE = {"cement_bags": (100, 2200), "sand_pile": (2, 38), "aggregate_pile": (2, 38), "brick_stack": (2000, 28000), "rebar_bundle": (500, 11000)}


# ------------------------------------------------------------------ quantity <-> footprint (inverse of scene.py)
def footprint_m2(cls: str, qty: float) -> float:
    if cls in ("sand_pile", "aggregate_pile"):
        repose = scene.REPOSE_DEG["SAND" if cls == "sand_pile" else "AGGREGATE"]
        k = math.tan(math.radians(repose)) / (3.0 * math.sqrt(math.pi))
        return (qty / k) ** (2.0 / 3.0)
    if cls == "cement_bags":
        return qty / scene.BAG_LAYERS * scene.BAG_FACE_M2
    if cls == "brick_stack":
        return qty / scene.BRICKS_PER_M2_FOOTPRINT
    return qty / scene.REBAR_KG_PER_M2_FOOTPRINT


def quantity_from_area(cls: str, area_m2: float) -> float:
    """Same formulas as scene.estimate_inventory, applied to a mask footprint."""
    if cls in ("sand_pile", "aggregate_pile"):
        return scene.cone_volume_m3(area_m2, scene.REPOSE_DEG["SAND" if cls == "sand_pile" else "AGGREGATE"])
    if cls == "cement_bags":
        return area_m2 / scene.BAG_FACE_M2 * scene.BAG_LAYERS
    if cls == "brick_stack":
        return area_m2 * scene.BRICKS_PER_M2_FOOTPRINT
    return area_m2 * scene.REBAR_KG_PER_M2_FOOTPRINT


# ------------------------------------------------------------------ small helpers
def hsv(h, s, v):
    return tuple(int(c) for c in cv2.cvtColor(np.uint8([[[int(h) % 180, int(np.clip(s, 0, 255)), int(np.clip(v, 0, 255))]]]), cv2.COLOR_HSV2BGR)[0, 0])


def smooth_noise(rng, shape, scale):
    """Low-frequency noise in [-1, 1]."""
    h, w = shape
    small = rng.normal(0, 1, (max(2, h // scale), max(2, w // scale))).astype(np.float32)
    n = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return np.clip(n / 2.5, -1, 1)


def blob_polygon(rng, cx, cy, area_px, irregular=0.18, stretch=None):
    """Closed irregular blob whose pixel area is `area_px` (scaled after drawing once)."""
    n = 28
    ang = np.sort(rng.uniform(0, 2 * np.pi, n))
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False) + rng.normal(0, 0.05, n)
    rad = 1 + irregular * smooth_ring(rng, n)
    sx, sy = (stretch if stretch else (rng.uniform(0.85, 1.25), 1.0))
    pts = np.stack([np.cos(ang) * rad * sx, np.sin(ang) * rad * sy], 1)
    a = abs(cv2.contourArea((pts * 1000).astype(np.float32))) / 1e6
    r = math.sqrt(area_px / max(a, 1e-9))
    pts = pts * r
    rot = rng.uniform(0, np.pi)
    R = np.array([[math.cos(rot), -math.sin(rot)], [math.sin(rot), math.cos(rot)]])
    pts = pts @ R.T + np.array([cx, cy])
    return pts


def smooth_ring(rng, n):
    v = rng.normal(0, 1, n)
    k = np.ones(5) / 5
    v = np.convolve(np.concatenate([v[-4:], v, v[:4]]), k, mode="same")[4:-4]
    return v / (np.abs(v).max() + 1e-6)


def rot_rect(cx, cy, w, h, ang):
    c, s = math.cos(ang), math.sin(ang)
    pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    return pts @ np.array([[c, -s], [s, c]]).T + np.array([cx, cy])


def poly_mask(pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(pts).astype(np.int32)], 255)
    return m


@dataclass
class Palette:
    ground: Tuple[int, int, int]      # H, S, V
    sand: Tuple[int, int, int]
    gravel: Tuple[int, int, int]
    brick: Tuple[int, int, int]
    bag: Tuple[int, int, int]


def make_palette(rng, shifted=False) -> Palette:
    if not shifted:
        return Palette(
            ground=(rng.uniform(5, 25), rng.uniform(20, 110), rng.uniform(70, 150)),
            sand=(rng.uniform(17, 30), rng.uniform(50, 140), rng.uniform(150, 235)),
            gravel=(rng.uniform(0, 30), rng.uniform(5, 45), rng.uniform(55, 130)),
            brick=(rng.uniform(0, 9), rng.uniform(110, 190), rng.uniform(110, 190)),
            bag=(rng.uniform(0, 30), rng.uniform(0, 35), rng.uniform(190, 250)))
    # held-out look: colours the training distribution never produced
    return Palette(
        ground=(rng.uniform(30, 60), rng.uniform(20, 70), rng.uniform(60, 130)),     # grassy / greenish yard
        sand=(rng.uniform(10, 16), rng.uniform(35, 80), rng.uniform(120, 190)),      # pinkish-brown sand
        gravel=(rng.uniform(95, 115), rng.uniform(5, 30), rng.uniform(60, 120)),     # cool blue-grey stone
        brick=(rng.uniform(10, 16), rng.uniform(60, 110), rng.uniform(120, 200)),    # pale yellow-brown brick
        bag=(rng.uniform(95, 120), rng.uniform(5, 30), rng.uniform(150, 215)))       # grey-blue bags


# ------------------------------------------------------------------ ground and distractors
def draw_ground(rng, pal: Palette) -> np.ndarray:
    base = hsv(*pal.ground)
    img = np.zeros((H, W, 3), np.float32)
    img[:] = base
    n1 = smooth_noise(rng, (H, W), 90)
    n2 = smooth_noise(rng, (H, W), 14)
    img *= (1 + 0.10 * n1 + 0.05 * n2)[..., None]
    # soil patches and tyre tracks
    for _ in range(rng.integers(2, 6)):
        c = hsv(pal.ground[0] + rng.uniform(-4, 4), pal.ground[1] * rng.uniform(0.7, 1.3), pal.ground[2] * rng.uniform(0.7, 1.2))
        cv2.ellipse(img, (int(rng.uniform(0, W)), int(rng.uniform(0, H))), (int(rng.uniform(40, 220)), int(rng.uniform(20, 110))),
                    rng.uniform(0, 180), 0, 360, c, -1)
    img = cv2.GaussianBlur(img, (0, 0), 12)
    for _ in range(rng.integers(0, 4)):
        y = int(rng.uniform(0, H))
        cv2.line(img, (0, y), (W, y + int(rng.uniform(-80, 80))), tuple(int(v * 0.8) for v in base), int(rng.uniform(6, 16)))
    return img


def paste(img, mask, color_fn):
    """Fill mask with colours from color_fn(h, w) -> float32 image of size (H, W, 3)."""
    col = color_fn()
    m = (mask > 0)[..., None]
    img[:] = np.where(m, col, img)


def textured(rng, color, noise_amp=0.07, shade=None, grain=0.04):
    base = np.zeros((H, W, 3), np.float32)
    base[:] = color
    n = smooth_noise(rng, (H, W), 20)
    g = rng.normal(0, 1, (H, W)).astype(np.float32)
    f = 1 + noise_amp * n + grain * g
    if shade is not None:
        f = f * shade
    return np.clip(base * f[..., None], 0, 255)


def cone_shade(mask, strength=0.30):
    """Brighter at the pile centre, darker at the rim."""
    dist = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    mx = dist.max() + 1e-6
    return 1 - strength + strength * (dist / mx) * 1.4


def draw_distractors(img, rng, pal: Palette, occ):
    """Unlabelled look-alikes that a colour threshold would confuse with materials."""
    n = int(rng.integers(3, 9))
    for _ in range(n):
        kind = rng.choice(["white_tarp", "grey_slab", "red_container", "yellow_machine", "wood_pallet", "worker", "cone", "shadow", "puddle", "blue_tarp", "dark_tyres"])
        cx, cy = rng.uniform(60, W - 60), rng.uniform(50, H - 50)
        ang = rng.uniform(0, math.pi)
        if kind in ("white_tarp", "blue_tarp", "grey_slab", "red_container", "yellow_machine", "wood_pallet", "dark_tyres"):
            w, h = rng.uniform(40, 200), rng.uniform(25, 120)
            poly = rot_rect(cx, cy, w, h, ang)
            col = {
                "white_tarp": hsv(rng.uniform(0, 179), rng.uniform(0, 25), rng.uniform(205, 250)),
                "blue_tarp": hsv(105, rng.uniform(120, 220), rng.uniform(90, 200)),
                "grey_slab": hsv(rng.uniform(0, 30), rng.uniform(0, 25), rng.uniform(110, 175)),
                "red_container": hsv(rng.uniform(0, 6), rng.uniform(150, 230), rng.uniform(110, 190)),
                "yellow_machine": hsv(rng.uniform(22, 28), rng.uniform(170, 240), rng.uniform(190, 250)),
                "wood_pallet": hsv(rng.uniform(12, 20), rng.uniform(80, 140), rng.uniform(140, 200)),
                "dark_tyres": hsv(0, 0, rng.uniform(15, 50)),
            }[kind]
            cv2.fillPoly(img, [np.round(poly).astype(np.int32)], col)
            if kind == "wood_pallet":
                for k in range(1, 5):
                    cv2.line(img, tuple(np.round(poly[0] + (poly[1] - poly[0]) * k / 5).astype(int)), tuple(np.round(poly[3] + (poly[2] - poly[3]) * k / 5).astype(int)), (60, 80, 110), 2)
        elif kind == "worker":
            cv2.circle(img, (int(cx), int(cy)), int(rng.uniform(5, 9)), hsv(rng.uniform(0, 179), 200, 230), -1)
        elif kind == "cone":
            cv2.circle(img, (int(cx), int(cy)), int(rng.uniform(4, 7)), hsv(8, 230, 245), -1)
        elif kind == "puddle":
            cv2.ellipse(img, (int(cx), int(cy)), (int(rng.uniform(25, 90)), int(rng.uniform(15, 50))), ang * 57, 0, 360, hsv(105, 40, 85), -1)
        else:  # soft shadow
            ov = img.copy()
            cv2.fillPoly(ov, [np.round(rot_rect(cx, cy, rng.uniform(80, 300), rng.uniform(40, 140), ang)).astype(np.int32)], (0, 0, 0))
            img[:] = cv2.addWeighted(ov, 0.28, img, 0.72, 0)


# ------------------------------------------------------------------ material renderers
def render_pile(img, rng, cls, area_px, pal, cx, cy):
    pts = blob_polygon(rng, cx, cy, area_px, irregular=rng.uniform(0.08, 0.22))
    mask = poly_mask(pts)
    # correct the area exactly (polygon rasterisation error is small but systematic)
    got = int(np.count_nonzero(mask))
    if got and abs(got - area_px) / area_px > 0.02:
        pts = blob_polygon(rng, cx, cy, area_px * area_px / got, irregular=rng.uniform(0.08, 0.22))
        mask = poly_mask(pts)
    p = pal.sand if cls == "sand_pile" else pal.gravel
    color = hsv(p[0] + rng.uniform(-3, 3), p[1] * rng.uniform(0.9, 1.1), p[2] * rng.uniform(0.9, 1.1))
    grain = 0.04 if cls == "sand_pile" else 0.16     # gravel is speckled, sand is smoother
    col = textured(rng, color, noise_amp=0.08, shade=cone_shade(mask), grain=grain)
    img[mask > 0] = col[mask > 0]
    edge = cv2.morphologyEx(mask, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    img[edge > 0] = (img[edge > 0] * 0.8).astype(np.float32)
    return mask


def render_grid_stack(img, rng, cls, area_px, aspect, ang, cx, cy, pal, scale):
    """Rectangular stacks: bags (grid of faces), bricks (coarse cells), rebar (parallel bars)."""
    w = math.sqrt(area_px * aspect)
    h = area_px / w
    poly = rot_rect(cx, cy, w, h, ang)
    mask = poly_mask(poly)
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return mask
    # local coordinates inside the rotated rectangle
    c, s = math.cos(-ang), math.sin(-ang)
    u = (xs - cx) * c - (ys - cy) * s + w / 2
    v = (xs - cx) * s + (ys - cy) * c + h / 2
    if cls == "cement_bags":
        fw, fh = 0.5 / scale, 0.3 / scale                      # bag face in pixels
        iu, iv = (u // fw).astype(int), (v // fh).astype(int)
        base = hsv(pal.bag[0] + rng.uniform(-4, 4), pal.bag[1], pal.bag[2] * rng.uniform(0.92, 1.0))
        tone = rng.normal(1, 0.035, (iu.max() + 2, iv.max() + 2)).astype(np.float32)
        col = np.array(base, np.float32)[None, :] * tone[iu, iv][:, None]
        # printed brand band across each bag and dark seams between bags
        band = (np.abs((v % fh) / fh - 0.5) < 0.17)
        stripe = np.array(hsv(rng.uniform(0, 179), rng.uniform(100, 200), rng.uniform(80, 170)), np.float32)
        col[band] = col[band] * 0.35 + stripe * 0.65
        seam = ((u % fw) < 1.2) | ((v % fh) < 1.2)
        col[seam] *= 0.55
        img[ys, xs] = np.clip(col, 0, 255)
    elif cls == "brick_stack":
        cell = max(5.0, 0.45 / scale)
        iu, iv = (u // cell).astype(int), (v // cell).astype(int)
        base = hsv(pal.brick[0] + rng.uniform(-2, 2), pal.brick[1], pal.brick[2])
        tone = rng.normal(1, 0.10, (iu.max() + 2, iv.max() + 2)).astype(np.float32)
        col = np.array(base, np.float32)[None, :] * tone[iu, iv][:, None]
        seam = ((u % cell) < 1.0) | ((v % cell) < 1.0)
        col[seam] *= 0.6
        img[ys, xs] = np.clip(col, 0, 255)
    else:  # rebar bundle: parallel bars, mixture of dark steel and rust
        pitch = max(3.0, 0.07 / scale)
        iv = (v // pitch).astype(int)
        shade = rng.uniform(0.6, 1.2, iv.max() + 2).astype(np.float32)
        rust = rng.random(iv.max() + 2) < rng.uniform(0.0, 0.5)
        steel = np.array(hsv(rng.uniform(0, 179), rng.uniform(0, 30), rng.uniform(40, 95)), np.float32)
        rustc = np.array(hsv(rng.uniform(5, 14), rng.uniform(140, 220), rng.uniform(80, 150)), np.float32)
        col = np.where(rust[iv][:, None], rustc[None, :], steel[None, :]) * shade[iv][:, None]
        gap = (v % pitch) < 0.8
        col[gap] *= 0.45
        img[ys, xs] = np.clip(col, 0, 255)
    return mask


# ------------------------------------------------------------------ camera model
def camera_effects(img, rng, shifted=False):
    f = img.astype(np.float32)
    f *= rng.uniform(0.62, 1.22) if not shifted else rng.uniform(0.5, 1.3)          # exposure
    f *= np.array([rng.uniform(0.9, 1.1), 1.0, rng.uniform(0.9, 1.1)], np.float32)   # white balance
    yy, xx = np.mgrid[0:H, 0:W]
    vig = 1 - rng.uniform(0, 0.25) * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2
    f *= vig[..., None]
    haze = rng.uniform(0, 0.25 if not shifted else 0.45)
    f = f * (1 - haze) + 200 * haze
    f += rng.normal(0, rng.uniform(1.5, 7.0), f.shape)
    out = np.clip(f, 0, 255).astype(np.uint8)
    if rng.random() < 0.35:
        out = cv2.GaussianBlur(out, (0, 0), rng.uniform(0.6, 1.8))
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, int(rng.integers(55, 93))])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


# ------------------------------------------------------------------ a whole scene
def render_scene(seed: int, shifted: bool = False, classes: Optional[List[str]] = None):
    """Returns (image BGR uint8, scale_m_per_px, items) where items = [{class, quantity, area_px, polygon, ...}]."""
    rng = np.random.default_rng(seed)
    pal = make_palette(rng, shifted)
    scale = float(rng.uniform(0.03, 0.055))
    img = draw_ground(rng, pal)
    draw_distractors(img, rng, pal, None)
    occ = np.zeros((H, W), np.uint8)
    items: List[dict] = []

    n_items = int(rng.integers(1, 6)) if classes is None else len(classes)
    chosen = classes or [str(c) for c in rng.choice(CLASSES, n_items, replace=True)]
    for cls in chosen:
        lo, hi = RANGE[cls]
        qty = float(np.exp(rng.uniform(np.log(lo), np.log(hi))))
        area_px = footprint_m2(cls, qty) / scale ** 2
        # keep objects visible but inside the frame: clip to a sensible pixel range, then re-derive the quantity
        area_px = float(np.clip(area_px, 1800, 90000))
        qty = quantity_from_area(cls, area_px * scale ** 2)
        placed = None
        for _ in range(40):
            cx, cy = rng.uniform(110, W - 110), rng.uniform(90, H - 90)
            trial = np.zeros((H, W), np.uint8)
            tmp = img.copy()
            if cls in ("sand_pile", "aggregate_pile"):
                m = render_pile(tmp, rng, cls, area_px, pal, cx, cy)
            else:
                aspect = rng.uniform(0.9, 2.4) if cls != "rebar_bundle" else rng.uniform(1.8, 5.0)
                m = render_grid_stack(tmp, rng, cls, area_px, aspect, rng.uniform(0, math.pi), cx, cy, pal, scale)
            x, y, w_, h_ = cv2.boundingRect(m)
            if x < 4 or y < 4 or x + w_ > W - 4 or y + h_ > H - 4:
                continue
            if np.count_nonzero(cv2.bitwise_and(cv2.dilate(m, np.ones((9, 9), np.uint8)), occ)) > 0:
                continue
            placed = (tmp, m)
            break
        if placed is None:
            continue
        img, m = placed
        occ = cv2.bitwise_or(occ, m)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cnts, key=cv2.contourArea)
        eps = 0.003 * cv2.arcLength(c, True)
        poly = cv2.approxPolyDP(c, eps, True)[:, 0, :].astype(float)
        drawn = int(np.count_nonzero(m))
        qty = quantity_from_area(cls, drawn * scale ** 2)     # truth is what was actually drawn, not what was requested
        items.append({"class": cls, "material_code": CODE[cls], "unit": UNIT[CODE[cls]], "quantity": round(qty, 3),
                      "area_px": drawn, "polygon": poly.tolist()})
    out = camera_effects(np.clip(img, 0, 255).astype(np.uint8), rng, shifted)
    return out, scale, items


# ------------------------------------------------------------------ dataset writer
def _write_one(args):
    root, split, i, seed, shifted = args
    img, scale, items = render_scene(seed, shifted)
    name = f"{split}_{i:05d}"
    cv2.imwrite(str(root / "images" / split / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    lines = []
    for it in items:
        pts = np.array(it["polygon"]) / np.array([W, H])
        if len(pts) >= 3:
            lines.append(f'{CLASSES.index(it["class"])} ' + " ".join(f"{v:.5f}" for v in pts.flatten()))
    (root / "labels" / split / f"{name}.txt").write_text(chr(10).join(lines))
    (root / "meta" / split / f"{name}.json").write_text(json.dumps(
        {"scale_m_per_px": scale, "items": [{k: v for k, v in it.items() if k != "polygon"} for it in items]}))
    return name


def write_dataset(root: Path, n_train=700, n_val=140, n_test=140, n_shift=140, seed0=1000, workers=4, log=print):
    """YOLO-seg dataset: images/{train,val,test,test_shift}, labels/..., plus meta/*.json with truths."""
    from multiprocessing import Pool
    root = Path(root)
    splits = {"train": (n_train, seed0, False), "val": (n_val, seed0 + 100_000, False),
              "test": (n_test, seed0 + 200_000, False), "test_shift": (n_shift, seed0 + 300_000, True)}
    jobs = []
    for split, (n, s0, shifted) in splits.items():
        for sub in ("images", "labels", "meta"):
            (root / sub / split).mkdir(parents=True, exist_ok=True)
        jobs += [(root, split, i, s0 + i, shifted) for i in range(n)]
    with Pool(workers) as pool:
        for k, _ in enumerate(pool.imap_unordered(_write_one, jobs, chunksize=8), 1):
            if k % 100 == 0:
                log(f"{k}/{len(jobs)}")
    (root / "yard.yaml").write_text(
        f"path: {root.resolve().as_posix()}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n"
        + "".join(f"  {i}: {c}\n" for i, c in enumerate(CLASSES)))
    return root / "yard.yaml"


if __name__ == "__main__":
    import argparse
    from multiprocessing import freeze_support
    freeze_support()
    ap = argparse.ArgumentParser(description="Generate the synthetic yard dataset")
    ap.add_argument("--out", default="data/yard")
    ap.add_argument("--train", type=int, default=700)
    ap.add_argument("--val", type=int, default=140)
    ap.add_argument("--test", type=int, default=140)
    ap.add_argument("--shift", type=int, default=140)
    a = ap.parse_args()
    print(write_dataset(Path(a.out), a.train, a.val, a.test, a.shift))
