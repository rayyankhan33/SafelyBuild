# Test plan and early validation

Results of the latest full run are generated into [test-results.md](test-results.md) by `npm run test:all` (needs PostgreSQL: `npm run dev` or `npm run db:start`). Counts below were true on 2026-10-15; re-run before quoting them.

## 1. Strategy

| Level | Tool | What it proves | Tests |
|---|---|---|---|
| Unit (pure domain) | Node test runner | Formulas against hand-calculated values: dates, ACI mix, estimate, schedule, earned value, SDI and ALARP, stages, stock, derived hazards, camera health, alerts, wording | 80 (dates/ACI 10, estimate/schedule 15, EVM/risk/alerts 24, evidence-driven logic 31) |
| Integration (API + real PostgreSQL + fake inference server) | Node test runner, `fetch` | Auth, RBAC, accounts and notifications, no human path to evidence, cameras, ingest security, measurement, failures, multi-day hazards and evidence health, audit | 61 |
| Schema / design consistency | Node test runner | ER diagram equals live schema, migrations repeatable, constraints hold (cameras, replay, manual hazards, ratings, dates, money) | 14 |
| Inference service | pytest + FastAPI TestClient | Detection on real sample photos, stage and stock on synthetic scenes, HTTP errors, plugin registry, evaluation harness; crack model (stub-model logic, CCTV temporal confirmation, registry integration, real-model checks on held-out SDNET patches) | 106 (including parametrised cases) |
| Manual / demo | Browser | UI behaviour, both roles, failure demo | section 4 |

Total automated: **261** (155 Node + 106 Python). On a machine with the optional YOLO weights installed, 2 "backend unavailable" tests skip and 1 opt-in YOLO test is skipped unless `RUN_YOLO_TESTS=1` (3 skipped, 258 run). Integration tests use a separate database (`safelybuild_test`) wiped each run. The inference server is faked in Node so failure modes can be forced; the real Python service is tested separately and used in the demo.

## 2. Case catalogue (by requirement)

| Requirement | Test group | Examples of edge and failure cases |
|---|---|---|
| FR-01 | TC-API-AUTH | wrong password = unknown user message; 6th failed attempt blocked even with the right password; disabled account; garbage token; duplicate email; short password |
| FR-39 to FR-41 | **TC-API-ACCT** | admin and investor refused project creation; every admin notified (a second admin included), creator, investor and another organisation not; refused creation sends nothing; read one / read all / someone else's notification 404; admin deletes accounts, not own (409), not other organisation's (404), unknown or malformed id 404, non-admins 403; deleted user's token 401 and password refused at once; their project and estimate kept with no owner; audit still names them; deleting a user with notifications works; admin adds and removes project members and access ends immediately |
| FR-02, FR-03 | TC-API-RBAC | other organisation gets 404; non-member 404; investor refused on 5 write endpoints; malformed project id gives 404 not 500 |
| FR-04 to FR-08 | TC-EST, TC-ACI, TC-SCH, TC-API-SETUP | missing dimension, zero size, no grade, empty BOQ, contingency 80 %, strength 40 MPa refused, unsupported aggregate, steel below ACI 318 minimum, Sunday start, minimum duration, price-book edits by engineer refused, schedule regeneration needs confirmation |
| FR-09, FR-24, NFR-02 | **TC-API-NOHUMAN**, TC-SCHEMA | the Sprint 1 routes for typed progress, spend, photos and hazards return 404 for engineer and admin; site status refuses `progress`, `materials`, `notes`, `hazards_closed`, `workers_present`; negative crews, blank equipment, future and year-old dates; database refuses manual hazards and closures without a date |
| FR-10 | TC-API-CAM | engineer/investor cannot install cameras; zone camera needs an element of this project; yard camera needs a scale; key format; only the hash stored; listing never contains secrets |
| FR-11, FR-12 | **TC-API-INGEST**, TC-SCHEMA | no key / wrong key / malformed key; engineer or admin session cannot submit; camera key is not a user session; PHP file with image type; empty file; frame 3 days old; frame in the future; garbage and missing `captured_at`; same bytes twice (409) but allowed from a different camera; disabled camera refused |
| FR-13 | TC-API-FAIL | service down (frame saved, run failed, alert opened then cleared); service 500; missing frame file returns an error without cache headers (regression); frames served only to members |
| FR-14 | TC-API-MEASURE, TC-REG | every stage/inventory run stored with `model_version`; response stamps; plugin version appears |
| FR-15 | TC-STG, TC-API-MEASURE | midpoint values; pour coverage; one frame does not move progress; outlier ignored; old frames expire; progress never decreases; unbiased over 1-99 % |
| FR-16, FR-17 | TC-INV, TC-API-MEASURE | consumption on a delivery day; noise deadband; single-frame day; per-material independence; priced from the price book; a later price change does not rewrite history |
| FR-19 | TC-API-MEASURE, TC-API-LIFE | repeated roll-ups give identical rows; rebuilding hazards gives identical hazards |
| FR-20 to FR-22 | TC-EVM | behind and over budget, on plan, ahead, fewer than 3 logs, no progress, before start, completed late, zero budget |
| FR-23, FR-25, FR-26 | TC-RSK, TC-HAZ, TC-API-LIFE | no inspection in window; weights shift; ALARP boundaries 4/5/14/15; hazard opens, raises, closes on the 3rd clean day not the 2nd; a month of silence closes nothing; repeat after closure opens a new hazard; cameras tracked separately; deterministic |
| FR-27, FR-28 | TC-EVD, TC-ALR, TC-API-LIFE | stale after 2 working days, Sunday does not count; never-reported; zone camera idle when its task is not active; uncovered tasks; alert opens, clears, never duplicates |
| FR-29, FR-30 | TC-API-RBAC | investor payload lacks `risk`, `standards`, `estimate`, `inventory`, `site_status`, `metrics` and has no jargon; engineer payload has standards, mixes, categories, stock, crews, camera frames |
| FR-32 | TC-REG (`test_registry.py`), `test_evaluate.py` | plugin loaded but not activated; tried via `?backend=`; activated by environment and by `active.json`; plugin not serving a task; unavailable plugin; unknown backend; malformed backend name; broken plugin fails loudly; unknown task rejected; template not loaded; evaluation of stage, inventory, defects; CLI errors |
| NFR-09 | scene tests | each stage recovered from 3 noise seeds; pour coverage within 4 %; stock within 8 % for each material; materials do not interfere; cone formula; empty yard reads zero |

## 3. Failures found and what they taught us

Real findings, kept as evidence of failure-case discussion. Items 7-12 are from the automation rework.

| # | What went wrong | How found | Resolution |
|---|---|---|---|
| 1 | Two unit-test expectations were wrong (10 % overrun is "at risk" by the documented rule; plan curve shown before project start). Code was right | First unit run | Tests fixed |
| 2 | Spend total expected as 20 x 5 x 1400 instead of 4 x 5 x 1400 | First integration run | Arithmetic slip in the test |
| 3 | Photo endpoint set `Cache-Control: max-age` before reading the file; a missing file produced a 500 the browser cached | Manual browser test | Read first, then set headers; regression test |
| 4 | Demo project finished before today; everything read "behind" | First seeded dashboard | Larger demo BOQ |
| 5 | Task order followed element type, putting all columns before any beams | Reading the seeded schedule | Schedule follows BOQ order |
| 6 | No Node or PostgreSQL on the dev machine; PostgreSQL download blocked | Setup | Node via winget; PostgreSQL binaries via npm |
| 7 | **Measured work done was 27 % below the simulated truth and spend 17 % below**, which flipped a normal project to "over budget". Causes: stages were reported at the lower edge of their range, and a delivery day hid that day's consumption | Seed now prints measured vs true | Midpoint reporting, pour coverage, start/end-of-day yard frames: work done -1.0 %, spend -1.6 % (synthetic) |
| 8 | Defect heuristic ran on every synthetic frame and raised 11 hazards from flat colour regions | Reading the seeded hazards | Defect check became a per-camera admin setting |
| 9 | Cameras flagged overdue every Sunday and for finished tasks | Reading the seeded alerts | Overdue counts working days only; simulation keeps zone cameras reporting until the task is measured complete |
| 10 | `TRUNCATE ... CASCADE` on organisations also emptied the price book (it references users), so the next seed failed | Seed failure | Seed restores the price book after a reset |
| 11 | `stageAtProgress(14.9)` returned stage 1: the completion tolerance leaked into every stage bound | New unit test | Tolerance only at completion |
| 12 | Lifecycle test expected a hazard to stay open after 2 clean days; earlier tests had already sent a clean frame from the same camera today, which the system correctly counted | Integration run | Test uses its own camera. Behaviour was right |
| 13 | Stale inference service kept running old code after a code change, so measurements looked wrong | Per-task fidelity output | Restart; the seed prints per-task truth vs measured to make this visible |
| 14 | **An open alert kept its original wording**, so when the set of silent cameras changed the alert still named the old set (and a numbers-based alert would show stale figures). A new integration test exposed it the day after it was written, when the date rolled over | Integration run | `diffAlerts` now returns `toUpdate`; open alerts are refreshed whenever their wording changes; unit test added |

## 4. Manual demo checklist

1. `npm run dev` (builds the demo project from synthetic frames on first run, about 1 minute).
2. Investor: dashboard with progress, spend, forecast, safety light, plain sentences, charts with table views, evidence note, demo banner, photos.
3. Engineer: tabs Overview, Design & estimate, Schedule, Crews & equipment, Evidence, Risk & safety. Note there is no screen to enter progress, materials or hazards.
4. Evidence tab: camera health, latest frames and what was measured; Risk tab: read-only hazards with automatic closing.
5. **Tamper demo:** try `PUT /api/projects/:pid/logs/<date>` or `POST .../hazards` as the engineer (404); post a frame with an engineer token (401); post the same frame twice with a camera key (409); post a frame with an old timestamp (422).
6. **Failure demo:** stop the inference service, send a frame with `scripts/camera-sim.mjs`: saved, analysis failed, system alert; restart, send again: alert clears.
7. **Silence demo:** stop sending from a camera for two working days: overdue alert; safety marked "not verified" in the investor view.

## 5. Gaps (honest)

- **No real site footage has been processed.** Accuracy on real images is unmeasured for every backend. The synthetic fidelity numbers show the pipeline logic is sound, not that the vision is accurate on real sites. The evaluation harness exists to measure this as soon as labelled real photos are available.
- The synthetic frames are nearly noise-free; real noise will be larger and the 2 % stock deadband will need re-tuning.
- The pretrained YOLO-World backend runs (smoke-tested on the 4 sample photos, opt-in test `RUN_YOLO_TESTS=1`) but found nothing useful with the current prompts (see model-integration.md section 5); no accuracy has been measured and it is not active.
- No automated browser (UI) tests; the front end is verified manually.
- Docker files exist but were not run.
- Camera tampering other than silence (lens covered, camera turned away) is not detected.
