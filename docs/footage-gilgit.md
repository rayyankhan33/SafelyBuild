# First real footage: the Gilgit pilot site (2026-11-15)

What the first real site footage is, what it can and cannot be used for, and what was done with it. Nothing here is a measured accuracy: no frame is labelled by a person yet.

## 1. What it is

333 files (229 JPEG, 104 MP4, about 33 minutes of video) taken by hand on a phone by the project manager on his own site in Gilgit and sent through WhatsApp (`E:\Downloads\firstset.zip` to `fourthset.zip`). The site is a steel-clad building with a long reinforced-concrete perimeter wall built in strip-footing trenches, drainage pipe laying, excavation, formwork and concrete pours, and heavy flooding after rain.

Limits that shape everything else:
- **Recompressed by WhatsApp.** Images are at most 1,280 px, videos 480 to 850 px wide, and none of the 229 images has any capture date, camera or GPS data (one photo carries a printed date stamp, 2026-09-11). The originals on the phone are expected to have all of it: see `training/match_originals.py`.
- **Hand-held.** 97 of 104 videos change view substantially; nothing is a fixed camera. It cannot test the camera-tamper thresholds, the 2 % stock deadband, stock over time, or the temporal crack monitor.
- **People and number plates are visible.** The footage stays in `services/inference/data/gilgit_real/` (git-ignored, never committed). Blur faces and plates before anything leaves the team.

## 2. Grades (first pass, one look per file)

| Grade | Files | Meaning |
|---|---|---|
| useful | 107 | 72 stage and progress frames, 22 concrete surface or crack tests, 9 stock, 4 rust or rebar |
| marginal | 177 | general site views; review before use |
| not useful | 49 | screenshots, notes, machine close-ups, toilet, water only |

Per-file grades, crack-model results and source names: `data/gilgit_real/manifest.csv`.

## 3. What the existing models did on it (sanity checks only)

| Model | Result |
|---|---|
| Crack classifier (threshold 0.85) | Flagged 32 of 333 tiles (about 10 %). On the 22 concrete-surface tiles it flagged 2: one real crack beside a tape measure and one crack in soil. Most other flags are mud, bare ground, flood banks and a corrugated roof seam (not concrete). There is about one real crack in the set, so no recall can be stated. |
| Yard model (`yard_seg` 0.2.0) | Found all three piles (sand or aggregate, weakly on one) and a rebar bundle at low confidence; missed or mislabelled truck loads of wrapped bags (not stacked bags, which is what it was trained on). |
| Classical stage backend (`classical_color`) | 26 % exact and 67 % within one stage against 27 draft labels: about chance for four stages. It was built for fixed zone cameras and synthetic scenes. Draft labels are unverified. |

## 4. Product finding: the stage plan does not cover this site

The platform's stage plan (`apps/api/src/domain/stages.js`) knows footing, column, beam, slab and masonry wall. Of the 72 stage frames, only about 27 fit it (strip footings, pier or column formwork, one slab). The rest show element types the platform cannot label yet:

| Not in the plan | Frames | Natural stages |
|---|---|---|
| Reinforced-concrete wall | 23 | rebar, formwork, concrete, finished |
| Steel building (erection and cladding) | 14 | frame, cladding, windows |
| Drain pipe laying | 6 | trench, pipe placed, backfill |

If the pilot is on a site like this, the stage plan needs these element types (decision for the team; not built).

## 5. Draft stage labels

`data/gilgit_real/stage_draft/` holds 27 frames with a draft element type and stage in the evaluator's format (`labels.json`), plus `draft_notes.json` with a confidence and a note for each. They were made from the pictures and **nobody has verified them**; the project manager or an engineer should confirm or correct each one. Run `python evaluate.py --task stage --backend <name> --data data/gilgit_real/stage_draft` once they are verified.

## 6. Next steps

1. Get the original files (sent as documents or by cable) and run `training/match_originals.py` so the grades and draft labels carry over to the originals with their capture dates.
2. Site records for dating the stages: pour records, delivery notes, a rough schedule of the trench and slab work.
3. Verify the draft labels; label about 100 frames.
4. Fixed-camera footage, a counted stack and the other items in `footage-checklist.md`.
