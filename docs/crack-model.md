# Crack detection model (Sprint 1)

A trained model that finds concrete cracks in site photos and CCTV footage. This page says what was built, how it was trained, how well it works **as measured**, and where it fails. **Version 2 (2026-11-09)** replaces the first model: same network, retrained on the complete SDNET2018 dataset (section 2). The first model's numbers are kept in section 4.4 for comparison. Every number below was produced by the scripts in `services/inference/training/` on the development machine (Intel i5-7200U, 2 cores, no GPU) and can be reproduced.

## 1. What was built

| Piece | File | What it does |
|---|---|---|
| Training | `services/inference/training/train_cracks.py` | Fine-tunes ImageNet-pretrained MobileNetV3-Large on SDNET2018, evaluates, exports ONNX |
| Photo-level data split | `training/sdnet.py` | Splits by source photograph so near-duplicate neighbouring patches never straddle train and test |
| Runtime measurement | `training/evaluate_runtime.py` | Re-measures the shipped ONNX model through the code path the service uses; picks the default threshold |
| Out-of-domain check | `training/eval_codebrim.py` | Image-level check on CODEBRIM bridge photographs (never trained on) |
| Model | `services/inference/models/crack_cnn.onnx` (16.8 MB) + `crack_cnn.json` | Weights and metadata (threshold, metrics, training settings). The first model is recoverable from git history (commit `408e9c0`, `git show 408e9c0:services/inference/models/crack_cnn.onnx`) |
| Frame scanner | `services/inference/crack_model.py` | Multi-scale sliding windows, per-pixel mean probability, connected regions with box, score and severity. OpenCV only; PyTorch is not needed to run it |
| CCTV monitor | `services/inference/crack_video.py` | Samples a video file / webcam / RTSP stream, requires a crack to persist over several scans, reports each new crack once |
| Integration | `plugins/crack_cnn.py`, `plugins/tiles_and_cracks.py`, migration `004`, `domain/risk.js` | Two plugins in the backend registry ([model-integration.md](model-integration.md)): `crack_cnn` (cracks only) and `tiles_and_cracks` (rust/honeycomb heuristics plus cracks). New defect type `concrete_crack`; it raises the existing "Excessive cracking" hazard (library code `STR-CRACK`) by the same evidence rules as other hazards. **Not active by default** (see section 5, item 7) |
| Tests | `tests/test_crack.py` (21 tests), one API test and one unit test for the new defect type | Stub-model tests plus tests on the real model |

How a frame is analysed: the frame is scanned with square windows of 256, 384 and 512 px (50% overlap). Each window is resized to 224 px and classified. Window probabilities are averaged per pixel into a heat map; areas at or above the threshold become crack regions. For CCTV, a region is reported only after it appears in 3 consecutive scans (default one scan every 2 s).

## 2. Data

SDNET2018 (S. Dorafshan, R. J. Thomas, M. Maguire, Utah State University, CC BY 4.0): 256x256 px patches of concrete **bridge decks, walls and pavements**, labelled cracked / non-cracked. Version 2 uses the **complete** dataset: 56,092 patches (8,484 cracked, 47,608 non-cracked) cut from 230 photographs, 225 of which contribute both classes. (Version 1 used a 4,316-patch subset in which only 13 photographs contributed non-cracked patches.)

Split by photograph (seed 42), never by patch, so neighbouring patches of one photograph cannot sit in both training and test:

| Split | Patches | Cracked | Non-cracked | Photographs | Photographs with clean patches |
|---|---|---|---|---|---|
| train | 39,030 | 6,117 | 32,913 | 160 | 160 |
| validation | 8,532 | 1,196 | 7,336 | 35 | 35 |
| test | 8,530 | 1,171 | 7,359 | 35 | 35 |

The test photographs were used once, after the model and threshold were fixed. Augmentation imitates CCTV: random crops, flips, 90-degree rotations, down-up scaling (blur), sensor noise, colour/brightness jitter, grey-scale, Gaussian blur.

## 3. Training

MobileNetV3-Large (ImageNet weights, torchvision), 224 px input, AdamW lr 4e-4 with one-cycle schedule, batch 32, class-weighted binary cross-entropy, **6 epochs** of 1,219 steps. On this CPU an epoch took 83-93 minutes (the first took 122 minutes because the laptop was on battery and the CPU was throttled to about half speed; loading the 56,092 images took 12 minutes), so the whole run was about 9 hours.

Validation AUC by epoch: 0.930, 0.9495, 0.9509, 0.9504, 0.9549, **0.9557** (best, epoch 6). Training loss fell from 0.87 to 0.63 throughout. The gain per epoch was small after epoch 2 (+0.0008 in the last one), so more epochs would not help much.

## 4. Measured results

### 4.1 Held-out SDNET test photographs (patch level)

Measured through the shipped OpenCV/ONNX path on the 35 test photographs (8,530 patches) that were never used for training or for picking the threshold. The ONNX file reproduces the PyTorch result (test AUC 0.9436 against 0.9435).

**Default threshold 0.85**, the value with the best F1 on the validation photographs (from the training script). At it, on the test photographs: recall **0.704**, precision 0.849, specificity **0.980** (147 of 7,359 clean patches flagged, 2.0%), F1 0.769, accuracy 0.942, AUC **0.9435**.

The repository's earlier rule, "smallest threshold with at least 95% specificity on the validation photographs", gives 0.67 and is stored in `metrics_runtime`: recall 0.774, precision 0.715, specificity 0.951, F1 0.743. Which one to use is a product choice: 0.85 gives about 1 false alarm per 50 clean patches and finds 70% of cracks; 0.67 gives about 1 in 20 and finds 77%.

By surface (test photographs; threshold 0.67 rule, OpenCV path):

| | Precision | Recall | Specificity | F1 | AUC |
|---|---|---|---|---|---|
| All test (8,530 patches) | 0.715 | 0.774 | 0.951 | 0.743 | **0.9436** |
| Decks | 0.648 | 0.689 | 0.942 | 0.668 | 0.905 |
| Pavements | 0.677 | 0.748 | 0.960 | 0.711 | 0.955 |
| Walls | 0.777 | 0.837 | 0.945 | 0.806 | 0.947 |

Choosing the threshold is a trade-off, shown on the same test photographs (not used to pick the default):

| Threshold | Recall | Specificity | Precision |
|---|---|---|---|
| 0.30 | 0.916 | 0.790 | 0.410 |
| 0.50 | 0.835 | 0.910 | 0.595 |
| 0.70 | 0.764 | 0.956 | 0.736 |
| 0.80 | 0.725 | 0.975 | 0.823 |
| 0.85 (default; PyTorch run) | 0.704 | 0.980 | 0.849 |
| 0.90 | 0.664 | 0.986 | 0.882 |
| 0.95 | 0.609 | 0.993 | 0.928 |

Robustness (PyTorch evaluation, same test patches degraded, threshold 0.85):

| Test patches | AUC | Recall | Specificity | F1 |
|---|---|---|---|---|
| Clean | 0.9435 | 0.704 | 0.980 | 0.769 |
| 0.4x down-scaling | 0.9427 | 0.689 | 0.982 | 0.765 |
| Heavy JPEG (quality 25) | 0.9349 | 0.662 | 0.981 | 0.743 |
| Darkened plus noise | 0.9044 | 0.553 | 0.988 | 0.679 |

Dark, noisy footage is the weak spot: 45% of cracks are missed. The test set is 35 photographs from one dataset, so these figures still carry error bars; do not quote them to three decimals.

### 4.2 Out-of-domain check: CODEBRIM bridge photographs (1,051 images)

CODEBRIM (bridge inspection photographs, never trained on) has 1,051 images on disk: 629 contain a labelled crack and 422 do not (their labelled defects are efflorescence, corrosion stains, exposed bars, spalling). Run exactly as the service runs it (downscale to 1280 px, multi-scale scan); an image counts as flagged if any crack region is found. Version 1 of this check used only the 18 images that were then on disk; the full dataset has since been extracted, so the numbers below are not comparable with that earlier table.

| Threshold | Cracked images found (of 629) | Clean images wrongly flagged (of 422) |
|---|---|---|
| 0.50 | 93.5% (588) | 81.8% (345) |
| 0.70 | 85.9% (540) | 58.8% (248) |
| 0.85 (default) | 72.7% (457) | 32.2% (136) |
| 0.91 | 64.5% (406) | 22.5% (95) |

**This is still the most important result on this page.** Even after retraining on the complete SDNET, about 1 in 3 CODEBRIM photographs without a labelled crack are flagged at the default threshold. Many of those images show stains, spalling or exposed rebar, and some may carry fine unlabelled cracks, so the true false-alarm rate is uncertain, but the model clearly still reacts to concrete that does not look like SDNET. It is much less affected than version 1 (section 4.4): at threshold 0.91, version 1 flagged 83.9% of the clean images and version 2 flags 22.5%.

### 4.3 Speed

The ONNX model has the same size (16.8 MB) and architecture as before, so frame-scan speed is unchanged from version 1: about 1 s to scan a 1280x720 frame with 3 window scales on this 2-core CPU (15 frames in 14.9 s, measured for version 1). The 1,051-image CODEBRIM run took about 40 minutes (about 2.3 s per photograph, which includes decoding larger images). A scan every 2-5 s per camera is realistic on this machine; a GPU or fewer scales would allow more. The first request loads the model.

### 4.4 Comparison with version 1

Both models were scored on the **same** 35 test photographs (8,530 patches) through the same OpenCV path, with the repository's rule for the threshold (smallest threshold with at least 95% validation specificity). Version 1 is the 2,540-patch model; it reported AUC 0.879 on its own 9-photograph test set, which was a much smaller and easier sample.

| | Version 2 (this model) | Version 1 |
|---|---|---|
| Test AUC (same 8,530 patches) | **0.9436** | 0.8348 |
| Validation AUC | 0.9558 | 0.8483 |
| Threshold by the rule | 0.67 | 0.99 (cap; never reached 95% specificity) |
| Recall at that threshold | 0.774 | 0.630 |
| Clean patches flagged | 4.9% (362 of 7,359) | 9.2% (675) |
| Precision | 0.715 | 0.522 |
| F1 | 0.743 | 0.571 |
| CODEBRIM, threshold 0.91: cracked images found | 64.5% | 94.1% |
| CODEBRIM, threshold 0.91: clean images wrongly flagged | 22.5% | 83.9% |
| CODEBRIM, threshold 0.85: cracked images found / clean images wrongly flagged | 72.7% / 32.2% | 96.5% / 90.8% |

At version 1's stored threshold of 0.91 (0.9 in the table) it flagged 22% of clean SDNET patches on this test set. Any overlap between version 1's small training subset and these test photographs would have flattered version 1, and it still scored lower.

## 5. Limits and what they mean for the product

1. **Domain gap.** Trained only on close-up photographs of bridge decks, walls and pavements. About 1 in 3 CODEBRIM photographs without a labelled crack are still flagged at the default threshold (section 4.2). Expect false alarms on site photos until the model is fine-tuned on site imagery (section 6). The investor dashboard should not present these detections as confirmed cracks; the engineer must confirm (planned Sprint 2 confirm/dismiss feature).
2. **CCTV scale.** SDNET patches are close-ups. At typical CCTV distance a hairline crack is below one pixel and cannot be seen by any model; only wide cracks, or a camera zoomed on the member, are detectable. No real CCTV footage was available, so the video monitor is verified only on synthetic clips built from still photographs (it proves the plumbing, not field accuracy).
3. **No crack width.** Severity is from model confidence only (Low below 0.6, Medium below 0.8, High above). "Critical" is never produced because the model cannot justify the strongest alarm. The 0.3 mm PEC/ACI 224R width check remains deferred.
4. **Coarse boxes.** Regions are unions of 256-512 px windows, not crack outlines.
5. **One source dataset.** The 225 photographs with clean patches all come from SDNET2018, so the model has seen one camera style and one set of surfaces. The threshold is more stable than in version 1 (validation picked 0.85; the rule-based value is 0.67), but it was still tuned on SDNET, not on site footage.
6. The model is a binary classifier on windows, not a detector: it cannot separate cracks from joints, formwork lines, shadows or rust, which also look like dark lines.
7. Because of the false alarms above the crack backends are **not active** (the registry never activates a plugin silently). With version 1, the crack model flagged crack regions on the rust/honeycomb sample photos; that was not re-checked with version 2. To use it anyway: set `BACKEND_DEFECTS=tiles_and_cracks` (or `crack_cnn`) before starting the inference service, or write `{"defects": "tiles_and_cracks"}` to `services/inference/models/active.json`. Try it first without activating: `POST /v1/defects?backend=crack_cnn`.

## 6. How to improve it (the next step, needs the team)

The biggest gain is data from the target domain, not a bigger network.

1. Collect 200-500 crops (256-512 px) from the actual cameras/sites. Sort them into `site_data/cracked/` and `site_data/clean/`; include many crack-free look-alikes (formwork joints, stains, shadows, dirt, rust, brick lines). Name files `<camera>_<n>.jpg`.
2. Retrain: `python training/train_cracks.py --data <SDNET2018> --site-data site_data --epochs 6`.
3. Re-measure with `evaluate_runtime.py` and, if possible, on a held-out set of site frames, and replace the model file. Keep the old numbers in this document (section 4.4 shows how).

Also worth doing: crack-width estimation from calibrated imagery, an engineer confirm/dismiss action, and a ridge-detector step to outline cracks and reject blob-like false positives.

## 7. Reproduce

```bash
cd services/inference
.venv/Scripts/python -m pip install -r requirements-train.txt   # PyTorch CPU build: see the comment in that file
.venv/Scripts/python training/train_cracks.py --data "<path>/SDNET2018" --epochs 6 --out runs/crack_full   # complete SDNET2018: about 9 hours on this CPU (plug the laptop in; on battery it throttles)
.venv/Scripts/python training/evaluate_runtime.py --data "<path>/SDNET2018" --model runs/crack_full/crack_cnn.onnx   # same-split comparison of any two models; add --update-json to store it in the model json
.venv/Scripts/python training/eval_codebrim.py --data "<path>/CODEBRIM.coco"
.venv/Scripts/python -m pytest tests -q
```

Training is seeded (42) but PyTorch on CPU is not bit-for-bit deterministic across machines, so a re-run may differ slightly.
