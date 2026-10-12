"""
train_cracks.py - train the crack / no-crack patch classifier on SDNET2018 and export it to ONNX.

    python training/train_cracks.py --data "<path>/SDNET2018" --epochs 8

What it does
  1. Indexes SDNET2018 and splits it per photograph (see sdnet.py for why).
  2. Fine-tunes an ImageNet-pretrained MobileNetV3 (CPU friendly) with augmentations that mimic
     CCTV footage: blur, down-/up-scaling, sensor noise, colour and brightness changes, grey-scale.
  3. Picks the best epoch by validation ROC-AUC and the decision threshold by validation F1.
  4. Evaluates once on the held-out test photographs (clean, and degraded to look like CCTV).
  5. Exports models/crack_cnn.onnx (input: RGB float 0..1 NCHW, output: crack probability) and
     models/crack_cnn.json (threshold, input size, metrics). The inference service needs only
     OpenCV to run it; PyTorch is a training-time dependency (requirements-train.txt).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import random
import sys
import time

import cv2
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models
from torchvision.transforms import v2

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sdnet  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
MODELS_DIR = HERE.parent / "models"
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


# --------------------------------------------------------------------------- data
def load_rgb(path: str, side: int = 256) -> np.ndarray:
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise IOError(f"cannot read {path}")
    if img.shape[0] != side or img.shape[1] != side:
        img = cv2.resize(img, (side, side), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def subset(items, limit=None):
    """Deterministic random subset (debug runs); the full list when limit is falsy."""
    if not limit or limit >= len(items):
        return list(items)
    return random.Random(0).sample(list(items), limit)


def load_split(items):
    x = np.stack([load_rgb(s.path) for s in items])  # N,256,256,3 uint8
    y = np.array([s.label for s in items], dtype=np.float32)
    return x, y


class RandomRot90(nn.Module):
    def forward(self, x):
        return torch.rot90(x, random.randint(0, 3), (1, 2))


class RandomResolutionLoss(nn.Module):
    """Down-scale then up-scale: a patch seen from further away / a low-resolution camera."""

    def __init__(self, p=0.35, lo=0.35, hi=0.8):
        super().__init__()
        self.p, self.lo, self.hi = p, lo, hi

    def forward(self, x):
        if random.random() > self.p:
            return x
        h, w = x.shape[-2:]
        f = random.uniform(self.lo, self.hi)
        small = v2.functional.resize(x, [max(8, int(h * f)), max(8, int(w * f))], antialias=True)
        return v2.functional.resize(small, [h, w], antialias=True)


class RandomNoise(nn.Module):
    def __init__(self, p=0.25, sigma=0.04):
        super().__init__()
        self.p, self.sigma = p, sigma

    def forward(self, x):
        if random.random() > self.p:
            return x
        return (x + torch.randn_like(x) * random.uniform(0.01, self.sigma)).clamp(0, 1)


def train_transform(size: int):
    return v2.Compose([
        v2.RandomResizedCrop(size, scale=(0.5, 1.0), ratio=(0.85, 1.18), antialias=True),
        v2.RandomHorizontalFlip(),
        RandomRot90(),
        RandomResolutionLoss(),
        v2.ColorJitter(brightness=0.4, contrast=0.4, saturation=0.4, hue=0.05),
        v2.RandomGrayscale(0.25),
        v2.RandomApply([v2.GaussianBlur(5, (0.1, 1.6))], p=0.3),
        v2.ToDtype(torch.float32, scale=True),
        RandomNoise(),
    ])


def eval_transform(size: int):
    return v2.Compose([v2.Resize([size, size], antialias=True), v2.ToDtype(torch.float32, scale=True)])


class PatchDataset(Dataset):
    def __init__(self, x: np.ndarray, y: np.ndarray, tf):
        self.x, self.y, self.tf = x, y, tf

    def __len__(self):
        return len(self.y)

    def __getitem__(self, i):
        img = torch.from_numpy(self.x[i]).permute(2, 0, 1).contiguous()  # uint8 CHW
        return self.tf(img), torch.tensor(self.y[i])


# --------------------------------------------------------------------------- model
class ExportWrapper(nn.Module):
    """RGB float 0..1 NCHW in -> crack probability (N,) out. Normalisation lives in the graph."""

    def __init__(self, net: nn.Module):
        super().__init__()
        self.net = net
        self.register_buffer("mean", torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(IMAGENET_STD).view(1, 3, 1, 1))

    def forward(self, x):
        return torch.sigmoid(self.net((x - self.mean) / self.std)).reshape(-1)


def build_model(arch: str, pretrained: bool) -> nn.Module:
    if arch == "mobilenet_v3_large":
        net = models.mobilenet_v3_large(weights=models.MobileNet_V3_Large_Weights.IMAGENET1K_V2 if pretrained else None)
    elif arch == "mobilenet_v3_small":
        net = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None)
    else:
        raise ValueError(arch)
    net.classifier[-1] = nn.Linear(net.classifier[-1].in_features, 1)
    return net


class Normalised(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net
        self.register_buffer("mean", torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(IMAGENET_STD).view(1, 3, 1, 1))

    def forward(self, x):
        return self.net((x - self.mean) / self.std).reshape(-1)  # logits


# --------------------------------------------------------------------------- metrics
def roc_auc(y: np.ndarray, p: np.ndarray) -> float:
    pos, neg = p[y == 1], p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order))
    allv = np.concatenate([pos, neg])[order]
    # average ranks for ties
    i = 0
    r = np.empty(len(allv))
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1] == allv[i]:
            j += 1
        r[i:j + 1] = (i + j) / 2 + 1
        i = j + 1
    ranks[order] = r
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def confusion(y, p, thr):
    pred = (p >= thr).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum())
    tn = int(((pred == 0) & (y == 0)).sum()); fn = int(((pred == 0) & (y == 1)).sum())
    return tp, fp, tn, fn


def prf(tp, fp, tn, fn):
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    acc = (tp + tn) / max(1, tp + fp + tn + fn)
    spec = tn / (tn + fp) if tn + fp else 0.0
    return {"accuracy": acc, "precision": prec, "recall": rec, "specificity": spec, "f1": f1}


def metrics_at(y, p, thr):
    tp, fp, tn, fn = confusion(y, p, thr)
    m = prf(tp, fp, tn, fn)
    m.update({"threshold": float(thr), "tp": tp, "fp": fp, "tn": tn, "fn": fn, "auc": roc_auc(y, p)})
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}


def best_f1_threshold(y, p):
    best_t, best_f = 0.5, -1.0
    for t in np.linspace(0.05, 0.95, 91):
        f = prf(*confusion(y, p, t))["f1"]
        if f > best_f + 1e-9:
            best_t, best_f = float(t), f
    return best_t


@torch.no_grad()
def predict(net, x_uint8: np.ndarray, size: int, batch=64) -> np.ndarray:
    net.eval()
    tf = eval_transform(size)
    out = []
    for i in range(0, len(x_uint8), batch):
        xb = torch.stack([tf(torch.from_numpy(a).permute(2, 0, 1).contiguous()) for a in x_uint8[i:i + batch]])
        out.append(torch.sigmoid(net(xb)).numpy())
    return np.concatenate(out)


# CCTV-like degradations applied to the *test* patches only (never trained on in this exact form).
def degrade(x: np.ndarray, kind: str, seed=0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    out = np.empty_like(x)
    for i, a in enumerate(x):
        if kind == "lowres":  # 0.4x then back: roughly a camera 2.5x further away
            s = cv2.resize(a, (102, 102), interpolation=cv2.INTER_AREA)
            out[i] = cv2.resize(s, (256, 256), interpolation=cv2.INTER_LINEAR)
        elif kind == "jpeg":  # heavy CCTV compression
            ok, buf = cv2.imencode(".jpg", cv2.cvtColor(a, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 25])
            out[i] = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
        elif kind == "dark_noisy":  # dusk + sensor noise
            f = a.astype(np.float32) * 0.45 + rng.normal(0, 10, a.shape)
            out[i] = np.clip(f, 0, 255).astype(np.uint8)
        else:
            raise ValueError(kind)
    return out


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="SDNET2018 root (contains Decks/Pavements/Walls)")
    ap.add_argument("--site-data", help="folder with cracked/ and clean/ crops from your own site or CCTV footage; added to training")
    ap.add_argument("--arch", default="mobilenet_v3_large", choices=["mobilenet_v3_large", "mobilenet_v3_small"])
    ap.add_argument("--img", type=int, default=224)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=4e-4)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--threads", type=int, default=0, help="torch CPU threads (0 = all)")
    ap.add_argument("--limit", type=int, default=0, help="debug: use only N samples per split")
    ap.add_argument("--no-pretrained", action="store_true")
    ap.add_argument("--out", default=str(MODELS_DIR))
    args = ap.parse_args()

    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    if args.threads:
        torch.set_num_threads(args.threads)
    out_dir = pathlib.Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)

    samples = sdnet.index_sdnet(args.data)
    split = sdnet.split_by_photo(samples, seed=args.seed)
    if args.site_data:
        site = sdnet.index_site_folder(args.site_data)
        print(f"adding {len(site)} site crops ({sum(s.label for s in site)} cracked) to the training split")
        split["train"] = split["train"] + site
    info = sdnet.describe(split)
    print(json.dumps(info, indent=2))
    t0 = time.time()
    split = {k: subset(v, args.limit) for k, v in split.items()}
    data = {k: load_split(v) for k, v in split.items()}
    meta_test = split["test"]
    print(f"loaded images in {time.time() - t0:.0f}s")

    net = Normalised(build_model(args.arch, pretrained=not args.no_pretrained))
    xtr, ytr = data["train"]
    pos_weight = torch.tensor((ytr == 0).sum() / max(1, (ytr == 1).sum()), dtype=torch.float32)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    loader = DataLoader(PatchDataset(xtr, ytr, train_transform(args.img)), batch_size=args.batch,
                        shuffle=True, drop_last=True, num_workers=0)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-2)
    total = args.epochs * len(loader)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=total, pct_start=0.15)

    best = {"auc": -1.0, "state": None, "epoch": -1}
    history = []
    for ep in range(1, args.epochs + 1):
        net.train()
        t0, run = time.time(), 0.0
        for step, (xb, yb) in enumerate(loader, 1):
            opt.zero_grad(set_to_none=True)
            loss = loss_fn(net(xb), yb)
            loss.backward()
            opt.step(); sched.step()
            run += loss.item()
            if step % 20 == 0:
                print(f"  epoch {ep} step {step}/{len(loader)} loss {run / step:.4f} ({(time.time() - t0) / step:.2f}s/step)", flush=True)
        pv = predict(net, data["val"][0], args.img)
        yv = data["val"][1]
        auc = roc_auc(yv, pv)
        thr = best_f1_threshold(yv, pv)
        mv = metrics_at(yv, pv, thr)
        history.append({"epoch": ep, "train_loss": round(run / len(loader), 4), "val_auc": round(auc, 4), "val_f1": mv["f1"],
                        "val_threshold": round(thr, 2), "seconds": round(time.time() - t0)})
        print(f"epoch {ep}/{args.epochs}: train loss {run / len(loader):.4f}  val AUC {auc:.4f}  val F1 {mv['f1']:.4f} @thr {thr:.2f}  [{time.time() - t0:.0f}s]", flush=True)
        if best["state"] is None or auc > best["auc"]:
            best = {"auc": auc, "state": {k: v.detach().clone() for k, v in net.state_dict().items()}, "epoch": ep}

    net.load_state_dict(best["state"])
    print(f"best epoch {best['epoch']} (val AUC {best['auc']:.4f})")

    # ---- threshold from validation only; test photographs are touched once, here
    pv = predict(net, data["val"][0], args.img); yv = data["val"][1]
    thr = best_f1_threshold(yv, pv)
    xte, yte = data["test"]
    results = {"val": metrics_at(yv, pv, thr)}
    pt = predict(net, xte, args.img)
    results["test"] = metrics_at(yte, pt, thr)
    results["test_at_0.5"] = metrics_at(yte, pt, 0.5)
    results["test_by_surface"] = {}
    for surface in sdnet.SURFACES:
        idx = np.array([i for i, s in enumerate(meta_test) if s.surface == surface])
        if len(idx):
            results["test_by_surface"][surface] = metrics_at(yte[idx], pt[idx], thr)
    full_idx = {s.group for s in meta_test if s.label == 0}
    idx = np.array([i for i, s in enumerate(meta_test) if s.group in full_idx])
    results["test_fully_labelled_photos_only"] = metrics_at(yte[idx], pt[idx], thr)
    results["test_degraded"] = {}
    for kind in ("lowres", "jpeg", "dark_noisy"):
        results["test_degraded"][kind] = metrics_at(yte, predict(net, degrade(xte, kind), args.img), thr)
    print(json.dumps(results, indent=2))

    # ---- export
    net.eval()
    wrapper = ExportWrapper(net.net).eval()
    onnx_path = out_dir / "crack_cnn.onnx"
    dummy = torch.rand(1, 3, args.img, args.img)
    torch.onnx.export(wrapper, dummy, str(onnx_path), input_names=["image"], output_names=["crack_probability"],
                      dynamic_axes={"image": {0: "batch"}, "crack_probability": {0: "batch"}},
                      opset_version=17, dynamo=False)
    # parity check: ONNX through OpenCV (what the service uses) vs PyTorch
    cvnet = cv2.dnn.readNetFromONNX(str(onnx_path))
    sample = xte[: min(32, len(xte))]
    tf = eval_transform(args.img)
    ref = predict(net, sample, args.img)
    got = []
    for a in sample:
        blob = cv2.dnn.blobFromImage(cv2.resize(a, (args.img, args.img), interpolation=cv2.INTER_AREA), 1 / 255.0, (args.img, args.img), swapRB=False)
        cvnet.setInput(blob)
        got.append(float(cvnet.forward().reshape(-1)[0]))
    diff = float(np.max(np.abs(ref - np.array(got))))
    print(f"ONNX/OpenCV vs PyTorch max |diff| on {len(sample)} patches: {diff:.4f}")

    meta = {
        "name": "crack_cnn",
        "task": "crack / no-crack classification of a square surface patch",
        "architecture": args.arch,
        "input": {"size": args.img, "color": "RGB", "range": "0..1", "layout": "NCHW", "normalisation": "ImageNet mean/std inside the graph"},
        "output": "probability that the patch contains a crack",
        "threshold": round(thr, 2),
        "training": {"dataset": "SDNET2018 (CC BY 4.0, Utah State University)", "split": "per photograph, seed %d" % args.seed,
                     "epochs": args.epochs, "best_epoch": best["epoch"], "batch": args.batch, "lr": args.lr,
                     "pretrained": not args.no_pretrained, "split_sizes": info, "history": history},
        "metrics": results,
        "onnx_vs_torch_max_abs_diff": round(diff, 5),
    }
    (out_dir / "crack_cnn.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB) and crack_cnn.json")


if __name__ == "__main__":
    main()
