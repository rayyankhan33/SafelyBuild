# Crack detection model (Sprint 1)

A trained model that finds concrete cracks in site photos and CCTV footage. This page says what was built, how it was trained, how well it works **as measured**, and where it fails. Every number below was produced by the scripts in `services/inference/training/` on the development machine (Intel i5-7200U, 2 cores, no GPU) and can be reproduced.

## 1. What was built

| Piece | File | What it does |
|---|---|---|
| Training | `services/inference/training/train_cracks.py` | Fine-tunes ImageNet-pretrained MobileNetV3-Large on SDNET2018, evaluates, exports ONNX |
| Photo-level data split | `training/sdnet.py` | Splits by source photograph so near-duplicate neighbouring patches never straddle train and test |
| Runtime measurement | `training/evaluate_runtime.py` | Re-measures the shipped ONNX model through the code path the service uses; picks the default threshold |
| Out-of-domain check | `training/eval_codebrim.py` | Image-level check on CODEBRIM bridge photographs (never trained on) |
| Model | `services/inference/models/crack_cnn.onnx` (16.8 MB) + `crack_cnn.json` | Weights and metadata (threshold, metrics, training settings) |
| Frame scanner | `services/inference/crack_model.py` | Multi-scale sliding windows, per-pixel mean probability, connected regions with box, score and severity. OpenCV only; PyTorch is not needed to run it |
| CCTV monitor | `services/inference/crack_video.py` | Samples a video file / webcam / RTSP stream, requires a crack to persist over several scans, reports each new crack once |
| Integration | `pipeline.py`, `service.py`, migration `003`, `domain/risk.js` | `backend=crack_cnn` (and `auto`) on `/v1/defects`; new defect type `concrete_crack`; it raises the existing "Excessive cracking" hazard (library code `STR-CRACK`) |
| Tests | `tests/test_crack.py` (22), API tests for the new defect type | Stub-model tests plus tests on the real model |

How a frame is analysed: the frame is scanned with square windows of 256, 384 and 512 px (50% overlap). Each window is resized to 224 px and classified. Window probabilities are averaged per pixel into a heat map; areas at or above the threshold become crack regions. For CCTV, a region is reported only after it appears in 3 consecutive scans (default one scan every 2 s).

## 2. Data

SDNET2018 (S. Dorafshan, R. J. Thomas, M. Maguire, Utah State University, CC BY 4.0): 256x256 px patches of concrete **bridge decks, walls and pavements**, labelled cracked / non-cracked. The copy in this project's `Datasets/SDNET2018` has 4,316 patches (2,156 cracked, 2,160 non-cracked), a subset of the full 56,000-image dataset.

**Property of this copy that shapes everything below:** only 13 source photographs (Decks 7001-7004, Pavements 001-004, Walls 7069-7073) contribute non-cracked patches; the other 42 photographs contribute cracked patches only. The model therefore sees very few distinct "clean" surfaces.

Split by photograph (seed 42), never by patch:

| Split | Patches | Cracked | Non-cracked | Photographs | Photographs with clean patches |
|---|---|---|---|---|---|
| train | 2,540 | 1,464 | 1,076 | 37 | 7 |
| validation | 820 | 372 | 448 | 9 | 3 |
| test | 956 | 320 | 636 | 9 | 3 |

The test photographs were used once, after the model and threshold were fixed. Augmentation imitates CCTV: random crops, flips, 90-degree rotations, down-up scaling (blur), sensor noise, colour/brightness jitter, grey-scale, Gaussian blur.

## 3. Training

MobileNetV3-Large (ImageNet weights, torchvision), 224 px input, AdamW lr 4e-4 with one-cycle schedule, batch 32, class-weighted binary cross-entropy, 8 epochs at about 6.5 minutes each on this CPU. The best epoch by validation AUC was epoch 3 (AUC 0.912); later epochs overfit (training loss kept falling, validation AUC stayed at 0.88-0.91).

## 4. Measured results

### 4.1 Held-out SDNET test photographs (patch level)

Measured through the shipped OpenCV/ONNX path. Default threshold **0.91**, chosen on the validation photographs only (smallest threshold with at least 95% validation specificity: monitoring cameras see mostly crack-free surface, so false alarms are what engineers notice).

| | Accuracy | Precision | Recall | Specificity | F1 | AUC |
|---|---|---|---|---|---|---|
| All test (956 patches) | 0.837 | 0.825 | 0.650 | 0.931 | 0.727 | **0.879** |
| Decks | 0.787 | 0.730 | 0.519 | 0.911 | 0.607 | |
| Pavements | 0.916 | 0.940 | 0.788 | 0.976 | 0.857 | |
| Walls | 0.811 | 0.800 | 0.650 | 0.905 | 0.717 | |

Choosing the threshold is a trade-off, shown on the same test photographs (not used to pick the default):

| Threshold | Recall | Specificity | Precision |
|---|---|---|---|
| 0.30 | 0.938 | 0.462 | 0.467 |
| 0.50 | 0.859 | 0.676 | 0.572 |
| 0.70 | 0.791 | 0.805 | 0.671 |
| 0.80 | 0.741 | 0.866 | 0.736 |
| 0.91 (default) | 0.650 | 0.931 | 0.825 |
| 0.95 | 0.613 | 0.947 | 0.852 |

Robustness (PyTorch evaluation, same test patches degraded, threshold 0.87): AUC 0.885 after 0.4x down-scaling, 0.860 after heavy JPEG (quality 25), 0.830 after darkening plus noise (clean: 0.879). The test set is 9 photographs, so these figures have wide error bars; do not quote them to two decimals.

### 4.2 Out-of-domain check: CODEBRIM bridge photographs (18 images)

CODEBRIM images present on disk: 7 contain a labelled crack, 11 do not (their labelled defects are efflorescence, corrosion stains, spalling). Run exactly as the service runs (downscale to 1280 px, multi-scale scan); an image counts as flagged if any crack region is found.

| Threshold | Cracked images found | Clean images wrongly flagged |
|---|---|---|
| 0.50 | 7 of 7 | 11 of 11 |
| 0.70 | 7 of 7 | 10 of 11 |
| 0.91 (default) | 7 of 7 | 7 of 11 |

**This is the most important result on this page.** The model finds the cracks, but on photographs that do not look like SDNET it also flags stained, spalled, efflorescent and heavily textured concrete (and some of those images may carry fine unlabelled cracks, so the true false-alarm rate is uncertain). Because SDNET's clean patches are mostly smooth, the network learned a partly wrong rule: "dark or textured concrete means crack". Heat maps show boxes that are coarse (window-sized) and a real crack's surroundings lighting up. In a synthetic CCTV clip built from a cracked CODEBRIM photo the monitor boxed part of the real crack and also one dark shadow; on the clean clip it reported nothing.

### 4.3 Speed

About 1 s to scan a 1280x720 frame with 3 window scales on this 2-core CPU (15 frames in 14.9 s); 16.8 MB model; first request loads it. A scan every 2-5 s per camera is realistic on this machine; a GPU or fewer scales would allow more.

## 5. Limits and what they mean for the product

1. **Domain gap.** Trained only on close-up photographs of smooth, clean bridge/pavement surfaces. Expect false alarms on site photos until the model is fine-tuned on site imagery (section 6). The investor dashboard should not present these detections as confirmed cracks; the engineer must confirm (planned Sprint 2 confirm/dismiss feature).
2. **CCTV scale.** SDNET patches are close-ups. At typical CCTV distance a hairline crack is below one pixel and cannot be seen by any model; only wide cracks, or a camera zoomed on the member, are detectable. No real CCTV footage was available, so the video monitor is verified only on synthetic clips built from still photographs (it proves the plumbing, not field accuracy).
3. **No crack width.** Severity is from model confidence only (Low below 0.6, Medium below 0.8, High above). "Critical" is never produced because the model cannot justify the strongest alarm. The 0.3 mm PEC/ACI 224R width check remains deferred.
4. **Coarse boxes.** Regions are unions of 256-512 px windows, not crack outlines.
5. **Very few clean photographs** (7 in training) make the threshold noisy: validation picked 0.91, but the F1-optimal value on the test photographs would have been about 0.8.
6. The model is a binary classifier on windows, not a detector: it cannot separate cracks from joints, formwork lines, shadows or rust, which also look like dark lines.
7. In the demo project the crack model flags 4 regions on the rust/honeycomb sample photos and so raises an "Excessive cracking" hazard there. That is a false alarm of the kind described above. Set `CRACK_DETECTION=off` to remove crack analysis from automatic mode (the explicit `crack_cnn` backend still works).

## 6. How to improve it (the next step, needs the team)

The biggest gain is data from the target domain, not a bigger network.

1. Collect 200-500 crops (256-512 px) from the actual cameras/sites. Sort them into `site_data/cracked/` and `site_data/clean/`; include many crack-free look-alikes (formwork joints, stains, shadows, dirt, rust, brick lines). Name files `<camera>_<n>.jpg`.
2. Retrain: `python training/train_cracks.py --data <SDNET2018> --site-data site_data --epochs 6`.
3. Re-measure with `evaluate_runtime.py` and, if possible, on a held-out set of site frames, and replace the model file. Keep the old numbers in this document.

Also worth doing: crack-width estimation from calibrated imagery, an engineer confirm/dismiss action, and a ridge-detector step to outline cracks and reject blob-like false positives.

## 7. Reproduce

```bash
cd services/inference
.venv/Scripts/python -m pip install -r requirements-train.txt   # PyTorch CPU build: see the comment in that file
.venv/Scripts/python training/train_cracks.py --data "<path>/SDNET2018" --epochs 8 --out models   # about 1 hour on CPU
.venv/Scripts/python training/evaluate_runtime.py --data "<path>/SDNET2018" --update-json
.venv/Scripts/python training/eval_codebrim.py --data "<path>/CODEBRIM.coco"
.venv/Scripts/python -m pytest tests -q
```

Training is seeded (42) but PyTorch on CPU is not bit-for-bit deterministic across machines, so a re-run may differ slightly.
