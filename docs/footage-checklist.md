# Footage collection checklist (one page)

Why: every accuracy number in this project so far comes from public datasets, not our cameras. The items below are the real footage and measurements that unblock Sprint 2 (`iteration-plan.md`). Do them in order; each step is useful on its own.

**For every photograph or clip:** keep the camera fixed, note the **camera name, date and time** (the file's own timestamp is fine), and do not edit or crop. Save as JPEG/PNG for stills and MP4 for clips. Check who is in frame and get site permission before sharing; faces and number plates should not be in anything that leaves the site.

## 1. Counted stock (yard camera), the most valuable item
- [ ] **One stack of cement bags** you have counted (write the count, e.g. "200 bags, 8 layers").
- [ ] **One sand pile and one aggregate pile** with a measured or delivered quantity (delivery note in m3 or tonnes, or measured length x width x height).
- [ ] **One brick stack** (counted) and **one rebar bundle** (tag weight or count of bars and length).
- [ ] Photograph each from the **yard camera's real position and angle**, in daylight, at least 5 frames each at different times of day.
- [ ] Write the **camera's ground scale** if known (metres per pixel), or measure a known length in the frame (a pallet, a marked 5 m line on the ground).

## 2. Days of normal frames (yard camera and one zone camera)
- [ ] **3 to 7 consecutive days** from one yard camera and one zone camera (the camera pointed at a slab, wall or column), at the system's normal capture interval.
- [ ] Include **at least one night and one weekend** where nothing is delivered or used (this measures the noise the 2 % stock deadband must hide).
- [ ] Note **real events** with times: deliveries, material used, pours, stage changes. These become the labels.
- [ ] Include different weather if possible: bright, overcast, rain, dust, low sun glare.

## 3. Staged camera faults (about 15 minutes)
- [ ] Cover the lens with a hand or cloth: 3 frames.
- [ ] Smear or spray the lens lightly: 3 frames.
- [ ] Turn the focus ring or defocus: 3 frames.
- [ ] Swing the camera to a different view, then back: 3 frames each.
- [ ] Write down the time of each fault so the frames can be labelled.

## 4. Cracks and look-alikes (CCTV distance)
- [ ] Any wall, slab, beam or column with **visible cracks**: photograph from the **distance the camera normally sits**, and again **close up** (a close-up with a ruler or crack gauge confirms the crack is real).
- [ ] **Look-alikes that are not cracks**: formwork joints, shadows, water stains, rebar ties, cables, dirt, mortar lines. At least as many frames as cracked ones.
- [ ] 2 to 3 **clips of about one minute** of a fixed view with a crack in it.
- [ ] Note: at normal CCTV distance a hairline crack is below one pixel and cannot be detected by any model; only wide cracks, or a camera zoomed on the member, can be tested.

## 5. Rust and honeycomb
- [ ] **Exposed rebar with rust**, and **rusty vs clean-steel** frames side by side.
- [ ] **Honeycombed concrete** (surface voids after formwork removal) and normal surface of the same member.
- [ ] Look-alikes: red paint, mud, brown formwork, shadows.
- [ ] **Teammate's trained rust and honeycomb model files** (not in the repository yet): ask for the `.onnx` or `.pt` file and a note on what it was trained on.

## 6. Labelling (needs an engineer, about 100 frames)
Run `node --env-file-if-exists=.env scripts/export-training-set.mjs <folder>` to pull stored frames out with the model's current guess pre-filled. The engineer then corrects each entry and sets `"verified": true`:
- **Zone frame:** element type and stage (and completed fraction for walls).
- **Yard frame:** stock per material (the counted quantity) and the camera scale.
- **Defect frame:** a box around each defect; an empty list means clean.

Keep the **test frames from different days** than any frames used to tune a threshold. Then `evaluate.py` (stage, inventory, defects) and `evaluate_yard.py` give the first real accuracy numbers.

## Minimum that unblocks the most
Items **1** (one counted stack per material), **2** (a few days, one yard and one zone camera) and a labelled sample of about 100 frames. That alone allows the real-footage evaluation, the stock-constant and deadband calibration, and a first measurement of the yard model on a real yard.
