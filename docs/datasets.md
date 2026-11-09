# Datasets: what we have, what is usable, and what to get

Inventory of `E:\Datasets` and of public datasets for the financial module (material stock from yard cameras), with what each is good for, what has been converted, and the limits. Checked 2026-11-06. Counts marked **(verified)** were read from the dataset page or files; anything else is reported as found and still to be verified.

## 1. What is on the E: drive

| Folder | What it is | Size | Annotations | Use |
|---|---|---|---|---|
| `CODEBRIM.coco` | Concrete **bridge** inspection photographs (CODEBRIM, Mundt et al., CVPR 2019; Roboflow export, CC BY 4.0) | 1,051 images (855 / 90 / 106), mostly 4608x3456 | Boxes (COCO): efflorescence 827, corrosion stain 1,547, crack 2,504, spallation 1,891, exposed bars 1,505 (after dropping 49 "Background" boxes) | **Defects detector (primary).** Converted, see section 2 |
| `SDNET2018` | Concrete deck / pavement / wall **patches**, 256 px (Utah State, CC BY 4.0) | **56,092** patches: 8,484 cracked, 47,608 non-cracked | Image-level (cracked / not) | **Crack classifier.** Version 1 was trained on a 4,316-patch subset; version 2 (2026-11-09) on all 56,092 patches, split per photograph; see 1.1 and `crack-model.md` |
| `Rust - Dataset.zip` | Corrosion vs no corrosion photographs | 1,455 JPEGs | Image-level | **Auxiliary only** (rust texture). Converted, see section 2 |
| `Rust Dataset` / `Rust Dataset.zip` | The same family: 152 very large corrosion photographs (up to 5472 px) in `Corrosion_Data/Largeimage` | 152 images | **None** | Unlabelled pool; needs annotating before use |
| `Rust - Dataset 2.zip` | **Synthetic** grayscale metal-surface defects (scratch, crack, rust, hole), 256 px | 15,000 PNG | Image-level + per-image metadata | **Not used.** Industrial metal, grayscale, synthetic: the wrong domain for concrete and rebar |
| `defects-in-power-distribution-components-DatasetNinja` | Power-line components (cables out of insulators / spacers) | 708 images | Boxes | **Not used.** Unrelated to construction |

### 1.1 Findings that change how the existing models should be trained

1. **SDNET2018 on the E: drive is the full dataset.** `docs/crack-model.md` records that the copy used for `crack_cnn` had 4,316 patches and that only **13 photographs** contributed non-cracked patches, which is why the network learned "dark or textured concrete means crack" and raises false alarms on stains and spalling. The full set has non-cracked patches from **about 230 photographs** (Decks 54, Pavements 104, Walls 72) and 13x more patches. Retraining on it was the most direct fix and has been done (2026-11-09; `python training/train_cracks.py --data E:/Datasets/SDNET2018 --epochs 6`). Result: test AUC 0.84 to 0.94 on the same 35 held-out photographs; false alarms on CODEBRIM bridge photographs fell from 84% to 22% of the clean images at threshold 0.91, but 32% are still flagged at the default 0.85. See `crack-model.md` sections 4.2 and 4.4.
2. **CODEBRIM is the right test for that false-alarm problem**, because it shows cracks next to the things that fooled the model (rust stains, spalling, efflorescence). The previous out-of-domain check used only 18 of its images. **Keep CODEBRIM's `test` split (106 images) out of training for every model** and report only on it.
3. **`Rust - Dataset.zip` leaks.** 44 of its training pictures are near-copies of test pictures, and 148 more are duplicates inside train (stock photos). Accuracy measured on its original split would be inflated; the rebuilt dataset removes them.

## 2. Datasets built from them (`services/inference/data/`, regenerable, not committed)

| Dataset | Built by | Content |
|---|---|---|
| `data/codebrim_det` | `training/build_codebrim_yolo.py --scheme native` | YOLO detection, 5 native classes, 1,051 images resized to 1280 px, 8,274 boxes, 30 images with no boxes kept as negatives; the dataset's own splits; no photograph in two splits |
| `data/codebrim_platform` | `... --scheme platform --reuse-images data/codebrim_det` | Same images, platform vocabulary: `concrete_crack` 2,504, `rusted_rebar` 3,052 (corrosion stain + exposed bars), `spalling` 1,891; efflorescence left unlabelled as a hard negative; 110 negatives. **The rust mapping is an assumption** (both indicate corroding reinforcement): an engineer should confirm it. **No honeycomb source exists in this data** |
| `data/corrosion_cls` | `training/build_corrosion_cls.py` | ImageFolder, `corrosion` / `no_corrosion`, 1,259 images after removing 196 near-duplicates (train 486/433, val 86/76, test 96/82), resized to 512 px. Auxiliary: not reinforcing steel |
| `data/yard_real/piles` | `training/boxes_to_masks.py --no-sam` from Roboflow *Piled Materials* | YOLO segmentation, yard classes `sand_pile` (1) and `aggregate_pile` (2); 1,037 images (train 720 / val 211 / test 106) with 1,211 hand-drawn polygons passed through unchanged (no SAM); 18 near-duplicates that spanned two splits removed (17 from train, 1 from val; `stats.json`). Pile outlines checked by eye on a contact sheet. Real photographs, **not** the project's camera, and no cement, brick or rebar |
| `data/yard_real/site` | `training/boxes_to_masks.py` (`--hamming 2`, SAM-B for box labels) from Roboflow *Construction Project Monitoring* | YOLO segmentation, `aggregate_pile`, `cement_bags`, `brick_stack`, `rebar_bundle`; **230 images** (train 136 / val 46 / test 48), 734 outlines. Of 686 source images, 255 were skipped as near-copies of a picture in a more protected split (test over val over train), and the rest of the scenes come from a handful of building sites. Hand-drawn polygons were kept as drawn; the box labels were turned into masks by SAM and checked by eye on contact sheets (stacks, heaps and bundles are outlined correctly). Test: 46 aggregate, 31 cement, 18 brick, 17 rebar frames. Sand and gravel are one class here (`Aggregates`) |

Verification done: labels drawn over the images and inspected (they sit on the rust stains, exposed bars and cracks); both YOLO datasets and the ImageFolder load in the training libraries; the converters have unit tests (`tests/test_datasets.py`: class mapping, normalisation and clipping, background dropped, the `NOCORROSION` / `CORROSION` substring trap, duplicate grouping, no leakage).

**Not built, and why:** the 152 large corrosion photographs have no annotations, and generating labels with the project's own colour heuristics would only teach a model the heuristic. They need hand annotation (a few hours in CVAT or Roboflow) or can be used as extra positives for `corrosion_cls` after checking.

## 3. Which model can use what

| Model (platform task) | Usable now | Gap |
|---|---|---|
| **Defects** (crack, rust, spalling) | CODEBRIM (detector), SDNET2018 full (classifier), `corrosion_cls` (auxiliary) | No honeycombed-concrete data; everything is close-up inspection photography, not CCTV |
| **Inventory / yard** (financial module) | `yard_real/piles` (sand and gravel piles, real photographs); synthetic scenes for the rest | No real cement-stack, brick-stack or rebar-bundle data: see section 4.3 |
| **Stage** (zone cameras: formwork, rebar, concrete) | Nothing on the E: drive | Public candidates below (SODA, ConRebSeg); none confirmed to label formwork |
| Activity | Not a trained model | None |

## 4. Public datasets for the financial module (yard material stock)

The financial model must see **cement bag stacks, sand and aggregate piles, brick stacks and rebar bundles** and turn their footprint into a quantity. No public dataset covers all five, none has ground-truth quantities or a ground scale, and almost all are **bounding boxes**, not masks.

### 4.1 Verified in the browser (Roboflow Universe, all CC BY 4.0, all object detection with boxes)

| Dataset | Images | Classes | Use for us |
|---|---|---|---|
| [cement_bag_detection](https://universe.roboflow.com/sush-lls0i/cement_bag_detection-izeat) | 532 | bag | Cement bags: best of the cement sets (reported mAP@50 88.4 %) |
| [Piled Materials](https://universe.roboflow.com/dataset-piled-materials/piled-materials) | 1,095 | Rock, Sand | Sand and gravel piles |
| [CountBars](https://universe.roboflow.com/steel-bar/countbars) | 2,796 | bar | Rebar (bar ends for counting, not stacked footprint) |
| [rebar](https://universe.roboflow.com/project-5sgou/rebar-1hzmu) | 1,244 | 4 (names not shown) | Rebar, "steel rod counting" export |
| [Constrcution-materials (IAAC)](https://universe.roboflow.com/iaac/constrcution-materials) | 409 | wood, brick, concrete, rubber | Bricks, small |
| [Cement_Bag_count](https://universe.roboflow.com/bagcounting/cement_bag_count) | 120 | 1 | Too small |
| [thesis](https://universe.roboflow.com/thesis-vq4ob/thesis-2i2t8) | 85 | wood, construction-objects, gravel, hollow blocks, sand | Too small |
| [pile-detection](https://universe.roboflow.com/yolodatagen/pile-detection) | 49 | anchor, pile of gravel | Too small |
| [bag_count](https://universe.roboflow.com/bagcount-nus8m/bag_count) | 31 | cement_bag | Too small |
| [pile_of_bricks_1](https://universe.roboflow.com/public-dkuh4/pile_of_bricks_1) | **0** | bricks | Empty |

Downloading needs a Roboflow sign-in ("Fork Dataset" then export as YOLOv8 or COCO). I cannot sign in or create accounts for you; your Roboflow account (the CODEBRIM set came from it) can do this in a few minutes. Descriptions are empty on all of these, so image source and label quality are unknown until you look at the samples.

### 4.2 From papers

Read from search results and the paper pages; the dataset pages themselves were not opened, so class lists and licences may differ from what is shown here.

| Dataset | Content | Access | Fit |
|---|---|---|---|
| [SODA](https://arxiv.org/abs/2202.09554) (Duan et al., Automation in Construction 2022) | 19,846 images, 286,201 objects, 15 classes including **brick, rebar, wood, board, scaffold** | A download link was not found on the paper page | Best coverage of site materials; boxes; worth requesting from the authors |
| [Rebar counting, Data in Brief 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11295459) | 874 drone images (1500x900) of rebar, one class, VOC boxes; 3.57 GB | [FigShare](https://doi.org/10.6084/m9.figshare.23633703.v4); article CC BY-NC (dataset licence not shown) | Rebar only; non-commercial note |
| [ConRebSeg](https://arxiv.org/abs/2407.09372) | 14,805 images with segmentation labels (exposed rebar, persons, cars, trucks) | DOI 10.11583/DTU.26213762; paper CC BY-NC-ND | Exposed rebar on construction and repair, also a lead for the stage model |
| [RAAMAC Construction Material Library](https://raamac.cee.illinois.edu/material-classification) | 3,000+ 200x200 patches, 20 material classes, image-level | Direct zip links on the page, no registration; no licence stated | Material texture classification, not stock |
| [CODD](https://data.mendeley.com/datasets/wds85kt64j) (Mendeley, CC BY 4.0) | 3,129 images, bricks, concrete, tiles, wood, stones... with boxes and polygons | Download button | **Recycling-facility waste**, not site stock: low fit |
| [Material recognition, arXiv 2006.16344](https://arxiv.org/abs/2006.16344) | 1,231 images, 11 material classes | Host not shown | Class list and download not confirmed |
| [Synthetic aggregate stockpiles, arXiv 2603.03654](https://arxiv.org/abs/2603.03654) | Synthetic stockpiles with instance labels | Release not stated | Thesis; ask the author |

### 4.3 What the five Roboflow downloads turned out to be (checked 2026-11-06)

Downloaded to `E:/Datasets/roboflow/<name>/` (each zip unpacked one folder down). Labels were drawn over sample images and the box counts measured before anything was converted.

| Dataset | Images (train/val/test) | What it really contains | Verdict for the yard model |
|---|---|---|---|
| `piled_materials` (Sand, Rock) | 766 / 220 / 109 | **Polygon** outlines of whole sand piles and gravel / crushed-stone piles in real outdoor photographs | **Used.** The polygons are already masks: kept as drawn, no SAM. Built as `data/yard_real/piles` |
| `cement_bag_detection` (bag) | 372 / 107 / 53 | A **person carrying one bag on the head**, often tiny in a warehouse frame; stacks of bags are not labelled | Not used: it would teach "a person with a bag", not a stack |
| `construction_materials` (brick, concrete, rubber, wood) | 286 / 82 / 41 | Loose pieces scattered on a dark **conveyor belt**, polygon labels | Not used: no stacks, wrong scene (a recycling line) |
| `countbars` (bar) | 1,968 / 549 / 279 | **Close-ups of bar ends**, a median of 60 and up to 188 boxes per image, for counting | Not used for footprints. Could train a bar-end counter for a future rebar-count feature |
| `rebar_5sgou` | 992 / 173 / 79 | Bundles photographed from the end, 222 boxes per image on median (up to 1,318); the `data.yaml` class names are README text, the real classes are only ids 0, 1, 2 (probably end shapes or colours) | Not used: same as `countbars` |

So of the 6,076 downloaded images **1,037 are usable**, all of them for two of the five yard classes. There is still **no real data for cement-bag stacks, brick stacks or rebar bundles seen from a yard camera**; the yard model keeps learning those from the synthetic scenes (`synth/yard.py`). Search for a stacked-cement or brick-pile dataset again, or photograph your own.

`training/boxes_to_masks.py` now does two things: it keeps polygons that are already in the source, and it can turn box labels into masks with a box-prompted Segment Anything model. Because the only useful set was polygon-labelled, SAM was not run for the yard model. `models/sam_b.pt` stays on disk; on this 2-core CPU it takes about 53 seconds per image (about 30 hours for 2,000 images), so a box dataset would need MobileSAM, a GPU or a sample. After conversion `dedupe_splits` removes near-duplicate pictures that sit in two splits (perceptual hash, Hamming 4; the test copy wins over val, val over train). *Piled Materials* had 11 such groups (8 train/val, 2 test/train, 1 test/val); all are gone, which the output verifies.

### 4.4 Second search for cement, brick and rebar stock (2026-11-06)

Checked on the Universe pages (overview and the 12-image sample dialog); the full image browser is behind Roboflow's bot check, which I did not try to bypass.

| Dataset | Verdict |
|---|---|
| **[Construction Project Monitoring](https://universe.roboflow.com/ai-in-civil/construction-project-monitoring-zdwrn)** (AI IN CIVIL, CC BY 4.0, 686 images, 6 versions) | **Best find, download it.** Real construction-site photographs with 13 classes, including `Cement_Bags`, `Concrete_Brick`, `Steel_Rebars` and `Aggregates`. The samples show stacked cement bags beside a mixer, a large brick stack and aggregate piles (some outlined as polygons, the rest as boxes). Small, and photographed from various angles, but it is the only set seen so far with the three missing classes in a yard. Export a version with no augmentation as YOLOv8 into `E:/Datasets/roboflow/construction_project_monitoring/`. Box labels go through SAM, polygons are kept |
| [cement_packed11](https://universe.roboflow.com/diamond-lvzkx/cement_packed11) (CC BY 4.0, 3,045 images, instance segmentation) | Not used: cement-plant CCTV of single bags moving on a conveyor, not stacks |
| `building` by vinoth (Bricks, Cement Bags, M Sand, River Sand) | Empty: 0 images |
| [cement-brvsx](https://universe.roboflow.com/hi-ppzyt/cement-brvsx) (classes Cement_Bag, scattered_bags, stacked per search snippet) | Not verified: page blocked by the bot check |
| [Construction_Material_dataset](https://universe.roboflow.com/weapon-detection-dqph4/construction_material_dataset) (1,652 images per snippet) | Not verified: page blocked by the bot check |
| Construction waste (Cityeyelab), Construction Site Material Detection (ff) | Not opened; the second is tiny |

Rebar bundles seen from the side still have no suitable public set; ConRebSeg (section 4.2) is exposed rebar in shotcrete work, not stored bundles.

### 4.5 First measurement of the yard model on real photographs (2026-11-06)

`evaluate_real.py` scores `yard_seg` on the held-out real `test` split of a built dataset (footprint overlap and area, per class, only for classes that dataset labels; see its docstring). Result of the current synthetic-only weights on `data/yard_real/piles` test (106 real photographs of sand and gravel piles; `models/yard_seg_real_eval.json`):

| Class | Frames | Recall | Pooled IoU | Median predicted / true area |
|---|---|---|---|---|
| sand_pile | 55 | 1.8 % | 0.00 | 0.05 |
| aggregate_pile | 53 | 13.2 % | 0.00 | 0.04 |
| pile (sand + aggregate merged) | 106 | 12.3 % | 0.00 | 0.04 |

**The synthetic-only model does not transfer to real photographs.** It finds about one pile in eight and, when it does, covers about 4 % of the true footprint. At a very low confidence threshold it labels these piles as rebar bundles, cement bags and brick stacks instead. The same code on synthetic test frames finds the right materials, so this is the domain gap and not an evaluation fault. The synthetic scores in `yard_seg_eval.json` (3 to 5 % median error) must not be read as field accuracy. This is the baseline any fine-tuning on real data has to beat.

Same weights on the held-out real `test` frames of `data/yard_real/piles` and `data/yard_real/site` together (`models/yard_seg_real_eval.json`):

| Class | Test frames | Recall | Precision | Pooled IoU | Median predicted / true area |
|---|---|---|---|---|---|
| pile (sand + aggregate merged) | 152 | 11.8 % | 94.7 % | 0.001 | 0.06 |
| cement_bags | 31 | 90.3 % | 65.1 % | 0.000 | **15.9** |
| brick_stack | 18 | 0 % | none | 0.000 | none |
| rebar_bundle | 17 | 100 % | 35.4 % | 0.012 | **13.6** |

Reading it: piles are almost never found. For cement and rebar the model "finds" the material on almost every frame but with a footprint **14 to 16 times too large** and no overlap with the real stack, so it is reacting to site texture, not to the stack. Bricks are never found. A quantity computed from these masks would be off by an order of magnitude. Aggregate piles are under-measured (0.06) and bags and rebar over-measured (14 to 16): the errors have opposite signs, so no single scale factor can correct them.

## 5. Honest limits and what to do

- **These datasets teach recognition, not measurement.** None has a known quantity, a camera scale or a delivery record. They can improve how well the model finds a pile or a stack; the number of bags or cubic metres still depends on the geometry constants and a calibrated yard, which need your own camera and a counted stack.
- **Boxes vs masks.** The yard model uses mask footprints. Box datasets can train a detector (box area over-states an irregular pile) or be turned into masks by a box-prompted Segment Anything model. That needs the SAM weights (about 375 MB), a download that needs your approval.
- **Domain gap.** Stock photographs and drone images are not your fixed yard camera at its angle and scale. Mix them with synthetic scenes (`synth/yard.py`) for training, and evaluate only on frames from the real camera.
- **Licences.** The Roboflow sets are CC BY 4.0 (cite them). Several academic ones are non-commercial or no-derivatives; check before any commercial use.
- **Evaluation discipline.** Keep one split that is never trained on (CODEBRIM `test`, and a held-out set of real yard frames).

Recommended order: (1) retrain the crack classifier on full SDNET2018 and evaluate on CODEBRIM `test`; (2) train the defects detector on `codebrim_platform` (a GPU is advisable: about 1,000 images at 1280 px); (3) fine-tune `yard_seg` on `data/yard_real/piles` mixed with the synthetic scenes (`--combine` writes the data.yaml), keeping `piles` test as the held-out check for sand and gravel; (4) collect real yard frames with known quantities for the evaluation that matters.
