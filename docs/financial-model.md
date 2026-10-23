# Financial module: the yard model and total cost

The financial module has two halves that are built very differently:

| Half | What it needs | Built how |
|---|---|---|
| **How much material was used** (spend on materials) | Computer vision on the yard camera | A **fine-tuned pretrained YOLO11 nano segmentation model** (`yard_seg`), trained here on synthetic yard scenes |
| **Labour, equipment, overheads** (rest of the total cost) | Arithmetic on rates the engineer enters once and the daily crew/equipment log | No model: `domain/cost.js` |

## 1. What we did for the model, and why

**Question: new model or grab a YOLO and train it?** We fine-tuned a pretrained YOLO. Training a network from scratch needs tens of thousands of labelled images; we have none. A COCO-pretrained YOLO already knows edges, textures and blobs, so only the five yard classes and their shapes have to be learned.

**Why segmentation, not boxes.** Stock is computed from the *footprint area* of a pile or stack (`scene.py`: cone volume for sand and aggregate, bag face x layers for cement, bricks and kg per m2 of footprint). A bounding box would over-count every irregular pile; an instance mask gives the area directly.

**Why one model for all five materials, not five models.** The five classes are seen by the same camera at the same scale in the same kind of frame, so a single segmenter serves the whole inventory task. (Defects are a different problem and keep their own model; see the main README.)

**Pipeline**

```
synth/yard.py        draws yard scenes from a TRUE state (so every frame has exact labels and true quantities)
train_yard.py        fine-tunes yolo11n-seg.pt  ->  models/yard_seg.pt (+ yard_seg.json: what it was trained on)
evaluate_yard.py     measures it against ground truth, next to the classical colour method  ->  models/yard_seg_eval.json
plugins/yard_seg.py  the backend: mask area -> the same geometry formulas as scene.py -> inventory items
```

Nothing activates the model. It is an opt-in backend: `POST /v1/inventory?backend=yard_seg`, or `BACKEND_INVENTORY=yard_seg`.

## 2. The synthetic data

`synth/yard.py` builds overhead yard scenes at a random ground scale (0.03 to 0.055 m per pixel), with 1 to 5 stacks or piles each and exact polygon labels. Domain randomisation, so the model cannot memorise one flat colour: random ground, material colours and textures, cone shading, speckled gravel, printed bag bands, brick and bar patterns, and unlabelled **look-alikes** (white and blue tarps, grey slabs, red containers, yellow machines, pallets, tyres, workers, cones, shadows, puddles), plus exposure, white balance, vignette, haze, blur, noise and JPEG artefacts. Truth is the formula applied to the area actually drawn.

Dataset: 700 train, 140 validation, 140 test, and 140 **shifted** test frames drawn with colours the training set never produced (green-grey yards, pinkish sand, cool grey stone, pale bricks, grey-blue bags, heavier haze). Seeds are disjoint across splits. Regenerate with `python -m synth.yard --out data/yard` (about 12 minutes on 4 workers); the data is not committed.

## 3. Training (what was actually run)

This machine is a 2-core laptop CPU with no GPU, so the run was scaled down: **40 % of the training set (280 images), 352 px, 15 epochs, batch 8, about 79 minutes.** A full run (all images, 640 px, 25+ epochs) was measured at roughly 15 hours here and should be done on a GPU for the final model.

## 4. Results (synthetic test frames, never seen in training)

Median absolute error of the estimated quantity, when the material is present; recall and precision are "is the material detected at all". "Classical" is today's colour-threshold method (`scene.py`) on the same frames.

| Material | Split | Recall | Precision | Median abs error | Mean bias | Classical median abs error |
|---|---|---|---|---|---|---|
| Cement bags | test | 0.97 | 0.99 | 3.2 % | +5.3 % | 34 % (recall 0.10) |
| Sand | test | 1.00 | 1.00 | 2.2 % | +1.7 % | 79 % (recall 0.19) |
| Aggregate | test | 1.00 | 1.00 | 2.6 % | +1.5 % | 1,462 % |
| Bricks | test | 1.00 | 0.97 | 2.9 % | +3.0 % | 27 % |
| Rebar | test | 0.98 | 0.98 | 5.0 % | +0.5 % | 81 % |
| Cement bags | **shifted** | 0.99 | **0.81** | 4.5 % | **+50.7 %** | 64 % |
| Sand | shifted | 0.95 | 1.00 | 2.1 % | -1.8 % | 78 % |
| Aggregate | shifted | 1.00 | 0.88 | 2.1 % | +29.5 % | 29,366 % |
| Bricks | shifted | **0.71** | 0.98 | 3.6 % | -3.2 % | 87 % |
| Rebar | shifted | 0.98 | 0.98 | 3.7 % | +0.2 % | 73 % |

Full numbers: `models/yard_seg_eval.json`.

## 5. How to read this honestly

- **The model learned the task on this synthetic distribution.** Median errors are 2 to 5 % and the classical method collapses once colours are randomised and look-alikes appear. That is the point of the comparison: a colour threshold only works on the frames it was tuned for.
- **It degrades on colours it never saw.** On the shifted set, cement and aggregate precision drop (81 % and 88 %): look-alikes are mistaken for stock, and the mean bias rises (+51 % cement, +30 % aggregate) because a single false detection adds a whole phantom stack. Pale bricks are missed 29 % of the time. Expect this kind of failure on real yards, probably worse.
- **This is not evidence of real-world accuracy.** The ground truth uses the same geometry formulas as the estimator, so these numbers measure how well the model *sees* a pile or stack. They say nothing about whether a real sand pile is a cone of 34 degrees or whether real bags stack 8 high. That needs a real yard with measured deliveries.
- **A missed detection looks like consumption.** If the model misses a stack on the end-of-day frame, stock appears to fall and spend is over-stated; a phantom stack does the opposite. The 2 % deadband does not protect against this. Real-yard evaluation must report this separately.
- **Reliability stays `unvalidated`** and the model stays opt-in until it has been measured on real photographs and, ideally, a known delivery.

## 6. Total cost (labour, equipment, overheads)

Decisions D1 and D2, built as agreed:

| Item | Entered by | When | How it accrues |
|---|---|---|---|
| Labour: cost of one crew per working day | Lead engineer | Once, at inception | crews logged that day x crew rate |
| Equipment: hire rate per unit per day and planned units, per type | Lead engineer | Once, at inception | units logged that day x hire rate (type matched ignoring case) |
| Overheads: percentage of direct cost | Lead engineer | Once, at inception | % of that day's materials + labour + equipment |
| Materials | nobody | - | measured from the yard cameras at the price book (price frozen when first used) |

- **Locked:** a second submission is refused (409) and the database rejects updates and new equipment rows (`cost_rates_are_locked` trigger). Changing a rate later is the change-control workflow (D3), not built yet.
- **Baseline:** when the schedule is generated, each task's budget becomes materials + labour (planned crews x rate x working days) + equipment (planned units x rate x working days) + overheads. The total is what earned value uses, so CPI, EAC and the investor figures cover the whole cost. Regenerate the schedule after setting the rates.
- **Without rates** a project stays materials-only and says so in plain words on the investor pages.
- **Equipment with no rate** is not costed and the engineer sees a warning (rates cannot be added later without change control).
- **Not built:** formwork (area from the BOQ), a cross-check of the logged crews against worker counts from the cameras (FR-38), and rates for trades.
- **Limit to state in the report:** crews and equipment per day are the engineer's own log, not image evidence, so labour and equipment cost are *reported* costs. The materials cost, which is the large and manipulable one, stays camera-measured.

## 7. What to do next

1. Get real yard photographs with known quantities (a measured delivery, a counted bag stack) and run `evaluate_yard.py`-style measurement on them. Everything above is provisional until then.
2. Train the final model on a GPU with all the data at 640 px, and add real labelled frames to the synthetic set.
3. Decide whether a missed stack should be handled (for example, ignore an end-of-day drop of more than a stack when the start-of-day frame is clean).
4. Add formwork and the crew cross-check if the report needs full D1 coverage.
