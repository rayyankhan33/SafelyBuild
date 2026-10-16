# Plugging in a trained model

For whoever is training the image models. You can deliver a model without touching anything outside `services/inference/`: the registry loads it, the API stamps every result with its name and version, and nothing uses it until it is made active.

## 1. What the platform needs from a model

Three tasks. A model may serve one, two or all three.

| Task | Called with | Must return | Used for |
|---|---|---|---|
| `stage` | `img` (BGR uint8, OpenCV), `element_type` in `footing, column, beam, slab, masonry_wall` | `{"stage": int, "fraction": float or null, "evidence": {...}, "backend": str, "reliability": str}` | Construction progress per element |
| `inventory` | `img`, `scale_m_per_px` (calibrated ground scale of that camera) | `{"items": [{"material_code", "quantity", "unit", "area_px", "method", "confidence"}], "backend", "reliability", "scale_m_per_px"}` | Material stock, hence consumption and spend |
| `defects` | `data` (raw image bytes), `min_violation`, `conf` | `{"backend", "image_size": [w, h], "findings": [{"defect_type", "score", "severity", "is_violation", "bbox", "confidence", "backend"}], "coverage"}` | Hazards and the Structural Danger Index |

### Output meanings (these are what downstream code depends on)

**stage**
- `stage = 0` means nothing built yet. Stage numbers are per element type and must match `STAGE_PLAN` in `apps/api/src/domain/stages.js`:

| Element | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| footing | excavation | rebar fixed | formwork | concrete poured |
| column | rebar cage | formwork | concrete poured | - |
| beam, slab | formwork | rebar | concrete poured | - |

- `fraction` matters for the **last stage only** ("concrete poured"): the share of the element already covered by concrete, 0 to 1. Report `null` or omit to mean fully covered. The platform maps it to progress between the pour-start bound and 100 %. A model that can directly regress "percent complete within the stage" can use this field.
- For `masonry_wall` there are no stages: return `fraction` = built share of the wall (0 to 1) and `stage = round(fraction * 100)`.
- Progress is accepted only when at least 2 frames in the last 3 days agree, and it never decreases, so a single wrong frame cannot move it.

**inventory**
- `material_code` in `SAND, AGGREGATE, CEMENT, BRICK, REBAR`; units: `SAND`/`AGGREGATE` m3, `CEMENT` bag (50 kg), `BRICK` nos, `REBAR` kg.
- Report one item per material you can measure; omit materials you cannot (do not return zero for "unknown": zero means "none visible").
- Consumption is the difference between the first and last frame of a day, so **consistent bias is much less harmful than noise**. A model that is 10 % low but stable works; one that jitters by 10 % does not. The platform ignores changes below 2 % of stock.

**defects**
- `defect_type` in `rusted_rebar, honeycombed_concrete, concrete_crack` (`concrete_crack` was added with migration `004_crack_defect_type.sql` and maps to hazard library entry `STR-CRACK`; adding a type requires a hazard-library entry and a migration; talk to the backend owner).
- `severity` in `Low, Medium, High, Critical`; `is_violation` true at or above the requested `min_violation`.
- `bbox` = `[x1, y1, x2, y2]` in the pixel coordinates of the image **as decoded by `pipeline.decode_image`** (long side capped at 1280 px).

## 2. Adding your model (5 steps)

1. Copy `services/inference/plugins/_template.py` to `plugins/<your_model>.py`.
2. Put weights in `services/inference/models/` (git-ignore large files; the weights hash is recorded automatically).
3. Implement the functions for the tasks you serve and fill `BACKEND = registry.Backend(...)`: `name`, `version` (bump on every retrain), `tasks`, `available()` (return False while weights are missing), `info()` (weights hash, training-set note, metrics) and `reliability` (`"unvalidated"` until you have measured it).
4. Try it **without activating it**: `POST /v1/stage?backend=<your_model>&element_type=slab` (same for `/v1/inventory`, `/v1/defects`), or run the evaluation harness (section 3).
5. Activate only after the numbers are good: `services/inference/models/active.json`, e.g. `{"stage": "my_model", "inventory": "my_model"}`, or environment variables `BACKEND_STAGE`, `BACKEND_INVENTORY`, `BACKEND_DEFECTS`. Restart the inference service.

Rules enforced by the platform (and tested in `tests/test_registry.py`):
- A plugin is **never activated silently**; the default backends stay active until configuration says otherwise.
- A plugin that does not define `BACKEND` fails start-up loudly. One that lists an unknown task is rejected.
- A backend that is missing, unavailable or does not serve a task returns 501 with the reason, never a crash.
- Every response includes `model: {backend, version, source, reliability, weights_sha256, ...}`; the API stores `model_version` (`name@version`) with every analysis, so any dashboard figure can be traced to the model that produced it and re-run later.

Heavy imports (torch, ultralytics) must be inside functions so the service still starts without them.

## 3. Measuring a model

```bash
services/inference/.venv/Scripts/python services/inference/evaluate.py --task stage     --backend my_model --data path/to/set
services/inference/.venv/Scripts/python services/inference/evaluate.py --task inventory --backend my_model --data path/to/set --out result.json
services/inference/.venv/Scripts/python services/inference/evaluate.py --task defects   --backend my_model --data path/to/set
```

`path/to/set` holds the images and a `labels.json`:

```json
stage      [{"file": "a.png", "element_type": "slab", "stage": 2}, {"file": "w.png", "element_type": "masonry_wall", "fraction": 0.6}]
inventory  [{"file": "y.png", "scale_m_per_px": 0.1, "stock": {"SAND": 80.0, "CEMENT": 600}}]
defects    [{"file": "d.jpg", "boxes": [{"defect_type": "rusted_rebar", "bbox": [10, 20, 200, 180]}]}]
```

Output (JSON): `stage` gives accuracy, within-one-stage rate, confusion counts and masonry error; `inventory` gives per-material MAPE and **bias** (mean signed error); `defects` gives precision, recall and F1 at IoU 0.3 plus image-level accuracy. Run the same command with `--backend classical_color` or `--backend opencv_tiles` to get the baseline to beat. Only flip `reliability` to `"validated"` after this has been run on **held-out real site photos**.

## 4. Getting real data

- Real frames arrive through cameras (or `scripts/camera-sim.mjs` to replay photos). Synthetic demo frames are excluded from exports.
- `node --env-file-if-exists=.env scripts/export-training-set.mjs <outDir>` copies every stored real frame and writes `labels.stage.json`, `labels.inventory.json`, `labels.defects.json` with the **current models' predictions pre-filled and `"verified": false`**. A labeller corrects them and sets `"verified": true`. Use only verified entries for training and for `evaluate.py`.
- `--include-demo` exports the synthetic frames too (useful only for testing the tooling).

## 5. Things to know about the current baselines

- `classical_color` (stage, inventory) is hand-written colour/geometry logic. It recovers simulated truth on synthetic frames (see `tests/test_scene.py`) and is expected to be weak on real, cluttered sites. It exists to run the pipeline end to end and to be beaten.
- `opencv_tiles` (defects) is the POC's colour/texture heuristic, tuned on four photos, with known false positives.
- `crack_cnn` (defects, cracks only) is the first trained-model plugin: MobileNetV3 trained on SDNET2018, ONNX weights committed in `models/` (exception in `models/.gitignore`). Measured on held-out SDNET photographs (AUC 0.88) but with a large false-alarm rate on photographs unlike SDNET, so it is **not active**; to use it set `BACKEND_DEFECTS=crack_cnn`. Full numbers, training and retraining with your own site crops: [crack-model.md](crack-model.md). It is a worked example of a plugin that serves one task and ships its own weights.
- `yolo_world` is a zero-shot pretrained detector (no training, text prompts only). Weights are not bundled and never downloaded automatically (see `requirements-yolo.txt`). **Smoke test on this machine (2026-10-13), not an accuracy measurement:** on the four sample photos (close-ups of rusted rebar and honeycomb) it found nothing at the default confidence 0.20; at 0.05 it made 8 "concrete" detections and no steel detections at all, even on the two rusted-rebar photos; speed was about 1 s per photo on CPU after warm-up. Conclusion: with these prompts it is not reliable for this domain and is **not** the active backend. It stays available (`?backend=yolo_world`) as a comparison point and as a template for how a heavy model is wired in.
- Camera geometry: yard cameras need a calibrated `scale_m_per_px` (set by an administrator when the camera is registered). Pile-volume formulas assume a cone with the angle of repose in `scene.py`; if your model estimates volume directly, return it as `SAND`/`AGGREGATE` m3 and ignore these constants.

## 6. Questions to settle with the backend owner

1. Which stage vocabulary will the model use? If it differs from the table above, the table in `stages.js` and `scene.STAGE_EVIDENCE` change together.
2. Will it predict from a single frame or use short clips? The platform currently feeds single frames.
3. Which defect classes beyond rust and honeycomb? Each needs a hazard-library entry (category, causes, barriers, standard).
4. Input resolution and colour order the model expects: the service passes BGR arrays resized so the long side is at most 1280 px.
