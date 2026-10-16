# SafelyBuild - Software Requirements Specification

Version 0.2 (Sprint 1, revised for the automated-evidence design). Every requirement has an ID, a verifiable acceptance check and the automated test that proves it. Test groups refer to `apps/api/test/*.test.js` and `services/inference/tests/*.py`; results are in [test-results.md](test-results.md).

## 1. Vision, scope and success criteria

**Product.** SafelyBuild lets an investor who is not an engineer follow a construction project: how far it has got, where the money has gone, whether it will finish on time and on budget, and whether the site is safe. **Everything about site conditions is measured automatically from fixed-camera images. No one on site can type it in, edit it or delete it**, so the record cannot be falsified.

**What a person still enters.** Only four things:

| Input | Who | Why it cannot come from images |
|---|---|---|
| Initial BOQ and budget (design elements, concrete strengths) | Engineer | It is the plan to measure against |
| Crews on site (per day) | Engineer | Context for productivity; not reliably visible |
| Equipment available (per day) | Engineer | Same |
| Cameras, price book, users | Administrator | Installation and market prices |

**Changes from the proposal.** The regulator/blacklist module is gone. Risk scoring, risk matrices, ALARP and bow-tie are kept and shown in plain language to investors. Financial and schedule tracking were added and are image-driven. See [design.md](design.md#10-the-evidence-model-and-tamper-resistance) and [section 9](design.md#9-design-evolution-from-the-proposal).

### Scope table

| Module | Built and tested | Deferred / excluded |
|---|---|---|
| Initial budget | BOQ entry (5 element types), ACI 211.1 mix design, ACI 318 margin and steel check, wastage, compaction (loose vs rodded density), PKR price book | Labour, plant, formwork, overheads; drawing/IFC parsing |
| Evidence ingest | Camera registration, per-camera secret, clock check, replay protection, failure tolerance, model-version stamping | Camera hardware drivers, video streams |
| Progress (schedule tracking) | Zone cameras report the visible construction stage; progress from agreeing frames; pour coverage; baseline schedule; SPI forecast, finish date, days early/late | Critical path with parallel tasks |
| Spend (financial tracking) | Yard cameras estimate stock; start-vs-end-of-day gives consumption; priced from the price book; EVM forecast, overrun | Labour and equipment cost |
| Defects | Rusted rebar / honeycomb via OpenCV heuristics, per-camera setting. **Cracks via a trained model** (`crack_cnn` / `tiles_and_cracks` plugins, opt-in; [crack-model.md](crack-model.md)) | Trained rust/honeycomb model (teammate in progress), crack width, crack accuracy on real CCTV footage |
| Risk and hazards | SDI 0-10, risk matrix, ALARP, bow-tie, hazards derived automatically and closed automatically | Detection of PPE, falls, excavation hazards |
| Evidence health | Overdue cameras and uncovered tasks flagged; safety marked "not verified" | Camera tamper detection (e.g. lens covered) |
| Model plug-in | Backend registry, drop-in plugin, evaluation harness, training-set export | The trained model itself |
| Dashboards | Investor (plain language) and engineer (technical) | Mobile apps, push alerts, PDF reports |

### Success criteria (measurable)

| ID | Criterion | How measured |
|---|---|---|
| SC-1 | No endpoint lets a user create, edit or close progress, spend, defects or hazards | TC-API-NOHUMAN (404 on removed routes, strict schema, database constraints) |
| SC-2 | Frames can only enter through an authenticated camera, once, with a sane clock | TC-API-INGEST |
| SC-3 | Measured figures reproduce from stored observations (replay gives identical results) | TC-API-MEASURE, TC-API-LIFE |
| SC-4 | Image-derived progress and spend agree with the simulated truth within 5 % on synthetic frames (measured: work done -1.0 %, spend -1.6 %) | Seed fidelity report |
| SC-5 | Forecast statuses are correct on hand-computed scenarios | TC-EVM |
| SC-6 | A failed analysis service never loses a frame, and a quiet camera is never read as "safe" | TC-API-FAIL, TC-API-LIFE |
| SC-7 | A trained model can replace a backend without changing any other code | TC-REG |
| SC-8 | All suites pass from a clean database | `npm run test:all` |

**Important limit on SC-4.** It is measured on synthetic frames, where the methods are known to work. Accuracy on real site footage is **unmeasured**; measuring it is the next milestone ([model-integration.md](model-integration.md)).

## 2. Users

| Role | Needs | Access |
|---|---|---|
| Investor | Plain-language progress, spend, forecast, safety; photos | Read-only on projects they belong to |
| Site engineer (the project's lead engineer) | Create projects; enter BOQ/budget, crews and equipment; see technical detail, standards, hazards, warnings | Create projects; BOQ, estimate, schedule, crews and equipment on their projects; read everything else |
| Administrator | Manage accounts (create and delete), add members to projects, install cameras, maintain the price book; is notified when an engineer creates a project. **Does not create projects** | Whole organisation |
| Camera | Submit frames | Only `POST /api/ingest/frame`, with its own key |

## 3. Functional requirements

| ID | Requirement | Acceptance check | Tests |
|---|---|---|---|
| FR-01 | Email and password sign-in with a time-limited token; identical error for wrong password and unknown user; 5 failures per 15 minutes per email and address are blocked; disabled accounts cannot sign in or use old tokens | Wrong credentials 401 with the same message; 6th attempt 429 | TC-API-AUTH |
| FR-02 | Data is isolated per organisation and project; another organisation's project returns 404; non-members get 404; admins see their organisation | Cross-tenant and non-member requests 404 | TC-API-RBAC |
| FR-03 | Investors are read-only on every endpoint. Engineers cannot touch cameras, price book or users. **Only engineers create projects; administrators and investors cannot.** | 403 on writes; admin and investor project creation 403 | TC-API-RBAC, TC-API-CAM, TC-API-ACCT |
| FR-04 | Engineers enter design elements with dimensions, quantity and concrete strength; missing or non-positive dimensions are rejected naming the field | 422 with field | TC-API-SETUP |
| FR-05 | The estimate computes concrete mix per m3 by the ACI 211.1 absolute-volume method (required strength from ACI 318), purchase quantities from loose bulk density (compaction factor), wastage, price-book prices in PKR and contingency; strengths outside the ACI table are refused, not extrapolated | Hand-checked 25 MPa mix (water 193, cement about 391, coarse 1072 kg/m3) | TC-ACI, TC-EST |
| FR-06 | Steel below the ACI 318 minimum for columns and slabs raises an advisory warning | Warning `ACI318_MIN_STEEL` | TC-EST |
| FR-07 | Prices come from the admin-only price book; activating an estimate sets the budget; each estimate stores the prices it used, and later price changes do not rewrite past estimates or past spend | Engineer price edits 403; spend unchanged after price change | TC-API-SETUP, TC-API-MEASURE |
| FR-08 | A baseline schedule is generated from the BOQ in BOQ order (duration from volume and output per crew-day, Monday-Saturday calendar); task budgets sum to the estimate; regenerating over measured progress needs explicit confirmation | Budgets sum; 409 `would_erase_progress` | TC-SCH, TC-API-SETUP, TC-API-MEASURE |
| FR-09 | The only daily engineer input is crews on site and equipment available. Any other field (progress, materials, notes, hazards...) is refused; future dates, dates before project start, negative counts and blank equipment names are refused | 422 for each extra field and bad value | TC-API-NOHUMAN |
| FR-10 | Only administrators install cameras. A zone camera watches one element of the project; a yard camera needs a calibrated ground scale. The secret key is shown once and only its SHA-256 is stored; camera lists never include it | Key format, hash in DB, 403 for others | TC-API-CAM |
| FR-11 | Frames enter only through `POST /api/ingest/frame` authenticated by a camera key. A logged-in user (including an admin) cannot submit frames; a camera key cannot be used as a user session; disabled cameras are refused | 401 cases | TC-API-INGEST |
| FR-12 | Frame integrity: type decided from file content; camera clock must be within 10 minutes of the server; the same bytes cannot be submitted twice by one camera; a per-camera daily cap | 422 `clock_skew`, 409 `duplicate_frame` | TC-API-INGEST, TC-SCHEMA |
| FR-13 | If analysis fails (service down, error, timeout) the frame is still stored, the run is recorded as failed, a system alert is opened and later resolved | Down and 500 cases | TC-API-FAIL |
| FR-14 | Every analysis records the model that produced it (backend name, version, weights hash, reliability) | `model_version` on every run | TC-API-MEASURE, TC-REG |
| FR-15 | Progress per task comes from zone-camera stages. A stage counts only when at least 2 frames in the last 3 days show it; middle stages report the midpoint of their range; once concrete is visible, pour coverage maps linearly to 100 %; progress never decreases; masonry progress is the measured wall fraction | One frame does not move progress; outliers ignored; unbiased over 1-99 % | TC-STG, TC-API-MEASURE |
| FR-16 | Material stock comes from yard-camera frames. Consumption of a day is the stock in its first frame minus its last frame (changes inside a 2 % deadband are noise); a rise of more than 15 % between yesterday's last and today's first frame is a delivery | Delivery day still shows consumption | TC-INV, TC-API-MEASURE |
| FR-17 | Daily spend is measured consumption times the price-book price; no endpoint accepts spend | Spend equals measured quantity times price | TC-API-MEASURE |
| FR-18 | Cameras flagged for defect checks are analysed for rusted rebar and honeycombed concrete (and, when the crack backend is made active, cracks: defect type `concrete_crack`, hazard "Excessive cracking"); findings (type, score, severity, box, violation flag) are stored | Findings stored and drawn on frames | TC-API-LIFE, inference tests |
| FR-19 | The roll-up replays all observations: progress, stock, consumption, spend and hazards are recomputed identically however often it runs | Identical snapshots after repeated runs | TC-API-MEASURE, TC-API-LIFE |
| FR-20 | Budget forecast by earned value: PV, EV, AC, CPI, EAC = BAC/CPI, overrun in PKR and %, a range from the recent cost trend, status on track (overrun up to 2 %), at risk (up to 10 %), over budget, under budget. Fewer than 3 logged days or no earned value gives "gathering data" | Hand-computed scenarios | TC-EVM |
| FR-21 | Schedule forecast: SPI, forecast duration = planned / SPI in working days, finish date, days early/late, status ahead / on track / at risk / behind (also completed, not started, insufficient data); no date is invented when nothing is measured | SPI 0.8 on a 10-day plan gives finish 19 Oct, 4 days late | TC-EVM |
| FR-22 | Productivity: value earned per value planned for each interval, with a 7-sample average labelled good / fair / low; crews on site are shown beside it | Productivity series | TC-EVM |
| FR-23 | Structural Danger Index 0-10 from severity, density and progression pillars with history-dependent weights; bands low / moderate / high / critical with an escalation flag; no analysed frame in 7 days means no score | See tests | TC-RSK |
| FR-24 | Hazards are a projection of defect evidence. There is no endpoint to create, edit or close one; the database refuses manual hazards and closures without a closing date | 404 on removed routes; DB constraint errors | TC-API-NOHUMAN, TC-SCHEMA |
| FR-25 | A hazard closes only after the same camera is analysed free of the defect on 3 consecutive days. Days with no frames change nothing. A later violation opens a new hazard and the old one stays in the history | Closes on day 3, not before; silence does not close | TC-HAZ, TC-API-LIFE |
| FR-26 | Hazards carry a category, likelihood x severity rating (5x5 matrix), ALARP zone (>=15 intolerable, 5-14 ALARP, <=4 acceptable), bow-tie causes/barriers/consequences and the governing standard, from a library of 8 hazards in 6 categories | Zone boundaries 4/5/14/15 | TC-RSK |
| FR-27 | Evidence health: a camera that should be reporting and has missed 2 working days is flagged overdue; tasks with no zone camera are flagged; safety is marked "not verified" while any gap exists | Sundays do not count; alerts open and clear | TC-EVD, TC-API-LIFE |
| FR-28 | Alerts for budget, schedule, safety and evidence conditions: one open alert per condition, auto-resolved, investor and engineer wording | Diff logic | TC-ALR |
| FR-29 | The investor dashboard shows progress vs plan, money spent, expected final cost and overrun, expected finish and days late/early, safety light, productivity, evidence note, alerts and photos in plain words, with no SDI/CPI/EAC/ALARP terms and no engineering sections | Payload lacks `risk`, `standards`, `estimate`, `inventory` | TC-API-RBAC, TC-ALR |
| FR-30 | The engineer dashboard adds the indices and formulas, SDI breakdown, risk matrix, hazards with category/zone/standard/controls and clean-day count, defects on annotated frames, estimate and mixes, standards used, stock history, crews and equipment, camera health and the latest frames with what was measured | Payload contents | TC-API-RBAC |
| FR-31 | Every mutation and every ingest is written to an audit log. Each entry records the actor as a user id and as text, so the trail still names the person after their account is deleted | Rows exist; investors cannot read; name survives deletion | TC-API-AUDIT, TC-API-ACCT |
| FR-39 | **When an engineer creates a project, every active administrator of the organisation receives an in-app notification** (creator, project name, location, start date), created in the same transaction as the project. Nobody else is notified; another organisation's admins are not notified; a refused creation sends nothing. Each user sees only their own notifications and can mark one or all as read | Admin unread count rises by one per admin; creator, investor and other organisations see nothing; marking another user's notification is 404 | TC-API-ACCT |
| FR-40 | **Administrators can delete accounts in their own organisation**, not their own account and not another organisation's. A deleted account's sign-in and tokens stop working immediately. Projects, estimates, frames and alerts it created are kept (no longer attributed to a user); its memberships and notifications are removed; the deletion is audited with the person's name, email and role | 403 for non-admins; 409 on self; 404 cross-organisation; token 401 after deletion; project kept with `created_by` null | TC-API-ACCT |
| FR-41 | Administrators add and remove the people who can see each project (they see every project in their organisation themselves). Removal takes effect at once | Member sees the project only while listed | TC-API-ACCT |
| FR-42 | **Temporary:** engineers (only) can upload a video or image to a sandbox where the model's detections on sampled frames are shown. Results never feed progress, spend, hazards, risk or forecasts; investors are refused; one run at a time; uploads are audited. To be removed (docs/temporary-features.md) | Investor 403; evidence tables, dashboard unchanged after a run; bad file type 422; second run 409 | TC-API-FOOTAGE, TC-INF-FOOTAGE |
| FR-43 | **The three roles do not overlap.** Only engineers write project content (BOQ, estimate, schedule, crews/equipment, warning acknowledgement) and use the test-footage tool; only administrators install cameras, edit the price book, manage people and read the audit log; investors write nothing and see plain-language Budget, Progress, Safety and Photos pages built for them. Each role has its own pages | Admin 403 on every engineer write and on test footage; engineer 403 on cameras, prices, people, audit; investor 403 on staff lists; investor payload has no ratings or codes | TC-API-ROLES |
| FR-32 | Analysis backends are pluggable per task (defects, stage, inventory). A plugin module is discovered at start-up, is never activated silently, can be tried with `?backend=`, can be selected by environment or `models/active.json`, and is refused with a clear reason if missing, unavailable or not serving the task. A harness measures any backend on labelled images | Plugin tests; evaluation tests | TC-REG, evaluate tests |
| FR-33 | `npm run db:seed` builds a demo project by simulating site truth, rendering synthetic frames and passing them through the real pipeline; the project is flagged `is_demo` and the UI says so; the seed prints measured vs true spend and work done | Fidelity line; UI banner | manual demo |

## 3a. Decided but not yet built (Sprint 2-3)

The team decided on 2026-10-13 that the system must cover total cost, lock inception rates, require approval by both the administrator and an investor for changes, and track completion beyond "placed". These are **requirements, not features of the current code**; the current code covers materials only and has no inception labour/equipment inputs, no change control and no completion lifecycle. See [proposal-revised.md](proposal-revised.md).

| ID | Requirement | Planned |
|---|---|---|
| FR-34 | The engineer (the project's lead engineer; no separate role) enters labour rates, equipment hire rates, planned crews and equipment, and formwork, overhead and contingency lines once at inception; they are locked afterwards | Sprint 2 |
| FR-35 | Labour (crews x rate) and equipment (units x hire rate) accrue each day as actual cost; forecasts and the investor dashboard use total cost with a breakdown | Sprint 2 |
| FR-36 | Each element shows placed / curing / finished / inspected states; a task shown as done carries a warning for each step not yet evidenced; warnings clear only on evidence (elapsed curing time from the measured pour date, images for finished, automated visual inspection) | Sprint 2 |
| FR-37 | A change to the budget, rates or baseline needs approval by the administrator and by an investor member of the project (one recorded investor approval), creates a new baseline version, and keeps all earlier versions and approvals | Sprint 3 |
| FR-38 | Crew counts are cross-checked against worker counts from the cameras and large disagreement raises an alert | Sprint 3 |

## 4. Non-functional requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| NFR-01 Security | Passwords hashed (bcrypt); tokens expire (12 h); login rate limit; cross-tenant access hidden as 404; camera keys hashed, constant-time compare; uploads validated by content; storage keys cannot escape the storage directory; JWT secret mandatory in production | TC-API-AUTH, TC-API-INGEST, TC-API-RBAC |
| NFR-02 Tamper resistance | No human path to create, edit or delete progress, spend, defects, hazards or frames; enforced by missing routes, strict input schemas and database constraints, not by UI hiding | TC-API-NOHUMAN, TC-SCHEMA |
| NFR-03 Reliability | Every call to the inference service has a timeout; its failure never loses a frame | TC-API-FAIL |
| NFR-04 Integrity | Invariants enforced in the database: bounded ratings, ordered dates, non-negative money, one log per project-day, one open alert per key, one copy of a frame per camera, cascade on project delete; every reference to a user survives that user's deletion (nullable references become NULL, membership and notifications are removed) | TC-SCHEMA |
| NFR-05 Reproducibility and traceability | Idempotent migrations; ER diagram generated from the live schema with a drift test; roll-up replay; every analysis stamped with model and version; estimates store their inputs | TC-SCHEMA, TC-API-MEASURE |
| NFR-06 Explainability | Every displayed figure has a documented formula and an engineer-view method note | Review |
| NFR-07 Accessibility | Status never by colour alone (icon + label); chart data as tables; light and dark themes; phone-width layouts | Manual review |
| NFR-08 Performance | Engineer dashboard 87-434 ms over 270 frames / 36 days (10 requests); stage analysis 12 ms and stock analysis 45 ms per frame (classical backend) | Measured 2026-10-12 |
| NFR-09 Measurement quality | Documented, measured error of image-derived numbers. On synthetic frames: work done -1.0 %, spend -1.6 % vs simulated truth; stock estimates read up to about 5 % low per material (consistent bias). **On real footage: unmeasured** | Seed fidelity report; evaluate.py |
| NFR-10 Portability | Runs on Windows without Docker or an installed database; Docker files provided but untested | README quick start |

## 5. Known limitations (stated, not hidden)

1. **No real site footage has been processed.** The demo uses synthetic drawings. The classical stage and stock methods are validated only on those; they are expected to be much weaker on cluttered real sites. A pretrained zero-shot backend (YOLO-World) is wired in and runs, but a smoke test on the four sample photos found almost nothing useful, so it is not active and its real-world accuracy is unmeasured. A trained model from the team is expected to replace both.
2. Rust and honeycomb scores come from colour/texture heuristics tuned on 4 sample photos; false alarms are expected.
   Crack detection is a trained model (SDNET2018) with measured held-out accuracy (AUC 0.88 on unseen photographs). It is **not active by default** because it raises many false alarms on photographs unlike SDNET (stains, spalling, textured concrete) and has not been tested on real CCTV footage; severity reflects confidence only, not crack width. See [crack-model.md](crack-model.md) section 5.
3. Stock from images assumes cone-shaped piles, stack heights and packing densities (documented constants) and a calibrated ground scale per yard camera. A delivery arriving mid-day hides that day's consumption. Quantities are noisy on real images; the 2 % deadband was chosen for the near-noiseless synthetic frames and must be re-tuned.
4. Spend covers bulk materials only. Default prices and productivity are placeholders.
5. Camera tampering (lens covered, camera redirected) is not yet detected; only silence is.
5a. Crew counts and equipment are typed by engineers and are the one input that affects cost; they are not yet cross-checked against the cameras. Curing cannot be verified from images, only timed. Automated visual inspection is not a structural test.
6. ACI table values are transcribed for one case (non-air-entrained, slump 75-100 mm, fineness modulus 2.8, max aggregate 19/25/37.5 mm); verify against licensed copies.
