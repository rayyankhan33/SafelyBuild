# Iteration plan, work breakdown and milestone log

Owners are **proposed** from the proposal's work division; the team should confirm or change them and record real dates. Status describes what exists in the repository and was verified on 2026-10-12 (evidence column = command or file).

## Iteration plan

| Iteration | Window | Goal |
|---|---|---|
| Sprint 1 (this) | Oct 2026 | Platform: schema, API, automated evidence pipeline, both dashboards, tests, docs |
| Sprint 2 | Nov-Dec 2026 | **Real footage and measured accuracy**: collect and label real site frames, evaluate every backend, integrate the teammate's trained model, calibrate stock constants and the noise deadband, camera-tamper checks. **Total cost** (labour, equipment, overheads; entered once by the engineer; locked rates) and the **completion lifecycle** (D1, D2, D4) |
| Sprint 3 | Feb-Mar 2027 | Fine-tuned models in production use, extra defect and hazard classes, drawing-assisted BOQ, **change control with two approvals (D3)**, crew-count cross-check, investor reports, Docker deployment |
| Sprint 4 | Apr-May 2027 | Pilot on a real site, threshold calibration, final validation |

## Sprint 1 work breakdown

| # | Task | Proposed owner | Status | Evidence |
|---|---|---|---|---|
| 1 | Re-scope after pivot, scope table, SRS (automated-evidence design) | All | Done | docs/srs.md |
| 2 | PostgreSQL schema (30 tables incl. cameras, observations, derived tables), reference data, migrations | Rayyan | Done | `db/migrations`, docs/erd.md, schema tests |
| 3 | Camera registry, key auth, ingest checks (clock, replay, type), failure tolerance | Rayyan | Done | `services/ingest.js`, TC-API-CAM/INGEST/FAIL |
| 4 | Remove every human path to evidence; database constraints | Rayyan | Done | TC-API-NOHUMAN, TC-SCHEMA |
| 5 | Stage-based progress, stock and consumption, replayed roll-up | Rayyan | Done | `domain/stages.js`, `inventory.js`, `services/rollup.js` |
| 6 | Derived hazards with automatic closure; evidence health and alerts | Rayyan | Done | `domain/risk.js`, `evidence.js`, TC-HAZ/EVD |
| 7 | ACI 211.1 estimate, schedule, earned-value forecasts, SDI, risk matrix, ALARP, bow-tie | Rayyan | Done | `domain/*`, TC-ACI/EST/SCH/EVM/RSK |
| 8 | Inference service: classical stage and stock backends, defects, activity | Hadi | Done | `services/inference`, 85 pytest |
| 9 | Backend registry, plug-in template, evaluation harness, training-set export | Hadi | Done | `registry.py`, `evaluate.py`, `scripts/export-training-set.mjs`, TC-REG |
| 10 | Investor dashboard (plain language, evidence note, demo banner) | Atyab | Done (now five pages: `apps/web/src/pages/investor`) | `apps/web/src/pages/investor` |
| 11 | Engineer views (overview, design, schedule, crews & equipment, evidence, read-only risk) | Atyab | Done | `apps/web/src/pages/engineer` |
| 12 | Demo data through the real pipeline with fidelity report | Rayyan | Done | `npm run db:reseed` |
| 13 | Test suite and results log | All | Done (261 tests) | docs/test-results.md |
| 14 | Docker packaging | Atyab | Written, **not run** | docker-compose.yml |
| 15 | **Real-footage evaluation of all backends** | Hadi + teammate | **Not started** (no labelled real photos) | - |
| 16 | **Trained model integrated and measured** | Teammate | **In progress by teammate** for rust/honeycomb (not in repo). **Cracks: done as a plugin** (Rayyan): MobileNetV3 trained on SDNET2018, measured on held-out photographs (AUC 0.88) and on an out-of-domain check that shows many false alarms; opt-in, not active; no real CCTV footage yet | docs/model-integration.md, [crack-model.md](crack-model.md), `plugins/crack_cnn.py`, `tests/test_crack.py` |
| 16b | CCTV video monitor for cracks (temporal confirmation) | Rayyan | Built; verified on synthetic clips only | `services/inference/crack_video.py` |
| 17 | YOLO-World pretrained backend run and measured | Hadi | Installed and smoke-tested 2026-10-13 (nothing found at default threshold; no steel at any threshold); **accuracy not measured, not active** | docs/model-integration.md section 5 |
| 18 | Camera tamper checks (lens covered, out of focus, redirected) | Rayyan | **Built** (FR-45): frame screening in the inference service, flags stored per frame, suspect camera -> critical alert and "not verified"; thresholds **uncalibrated**, synthetic frames only | `health.py`, `domain/evidence.js`, TC-INF-HEALTH, TC-EVD-TAMPER, TC-API-ROBUST |
| 19 | UI automated tests | Atyab | **Not started** | - |
| 20 | Mid report text (R&D, gap analysis) | All | **Team to write** | - |
| 21 | Total cost: engineer-entered locked inception rates, labour/equipment/overhead accrual, breakdown (FR-34, FR-35) | Rayyan | **Built 2026-10-22** (labour crew-rate, equipment hire rate, overhead %; formwork **not** built); `domain/cost.js`, migration 007, TC-COST, TC-API-COST | docs/proposal-revised.md D1, D2 |
| 21b | Yard material-segmentation model for stock estimates (vision half of the financial module): synthetic generator, fine-tuned YOLO11n-seg, `yard_seg` plugin, evaluation against the classical baseline | Rayyan | **Built and measured on synthetic data only** (see [financial-model.md](financial-model.md)); opt-in, not active; no real-yard accuracy | `synth/yard.py`, `train_yard.py`, `evaluate_yard.py`, `plugins/yard_seg.py`, `tests/test_yard.py` |
| 22 | Completion lifecycle: placed / curing / finished / inspected with evidence-cleared warnings (FR-36) | Rayyan + Hadi | **Built** (`domain/lifecycle.js`, dashboards, schedule and progress pages). Not demonstrable on the demo data because no demo task reaches 100 % and the demo zone cameras do not run defect checks; proven by unit tests | TC-LIFE, TC-API-LIFE-D4 |
| 23 | Change control with administrator + investor approval and versioned baselines (FR-37) | Rayyan | **Decided, not built** (Sprint 3) | docs/proposal-revised.md D3 |

## Sprint 2 status (updated 2026-11-03)

Sprint 2 goal: real footage and measured accuracy, plus total cost and the completion lifecycle. Everything that can be done without real footage or a further decision is done; the rest is marked with what it is waiting for.

**Done in sprint 2**

| Item | Where |
|---|---|
| Total cost: labour (crew rate), equipment (hire rate), overheads (%), locked at inception; baseline, earned value and both dashboards use the total (D1, D2; FR-34, FR-35) | `domain/cost.js`, migration 007, TC-COST, TC-API-COST |
| Trained yard material model, synthetic data generator, evaluation against the classical baseline (synthetic only) | `docs/financial-model.md` |
| Completion lifecycle with evidence-cleared warnings (D4; FR-36) | `domain/lifecycle.js`, TC-LIFE |
| Camera tamper screening (FR-45) | `health.py`, TC-INF-HEALTH |
| Missed-stack protection for stock (FR-46) | `domain/inventory.js`, TC-INV-DROP |
| Rates workflow: saving the rates rebuilds the baseline | TC-API-ROBUST |
| Role separation, test-footage tool (temporary), crack models as opt-in plugins | earlier |

**Blocked: needs real footage or real measurements (cannot be finished from the repository)**

| Item | Waiting for |
|---|---|
| 15. Real-footage evaluation of every backend | 100 or more labelled real frames (zone and yard). Tooling is ready: `scripts/export-training-set.mjs`, `evaluate.py`, `evaluate_yard.py` |
| Yard model accuracy on a real yard; calibrating repose angle, bag layers, bricks and rebar per m2, camera ground scale | Real yard photos with known quantities (a counted bag stack, a measured delivery) |
| Calibrating the 2 % stock deadband, the 50 % large-drop rule and the camera-screening thresholds | Real footage from the same cameras over several days |
| Crack model on real CCTV footage and its false alarms | Real CCTV footage |
| 16. Teammate's trained rust and honeycomb model measured and activated | The model files from the teammate (not in the repository) |
| Final yard model on a GPU (all data, 640 px, more epochs) | A GPU machine (about 15 hours on this laptop) |
| 14. Docker packaging run | Docker is not installed on this machine |
| Stage model for zone cameras (site-object segmenter) to replace colour heuristics | Real labelled zone frames; same approach as the yard model |

**Blocked: needs your decision**

| Item | Decision needed |
|---|---|
| ~~Formwork costing (rest of D1)~~ | **Decided 2026-11-03: costed as equipment hire** (a "formwork set" with a daily hire rate); area-based costing from the BOQ is not built and not planned |
| 23. Change control with administrator + investor approval (D3, FR-37) | Sprint 3 in the plan; also the only way to add a missing equipment rate or correct a locked rate |
| Crew-count cross-check against camera worker counts (FR-38) | Sprint 3; needs a worker-counting model |
| Remove the temporary test-footage tool | When real cameras are connected (checklist in `temporary-features.md`) |

**Not started, outside what can be built without the team**

| Item | Note |
|---|---|
| 19. UI automated tests | No browser test runner is set up; the screens were checked by hand |
| 20. Mid report text (R&D, gap analysis) | The team's own words |
| Panel action register, commits under each member's identity, verifying the ACI tables against the standard | Team |

Recovery plan for items 15-19: weekly demonstrable milestones in Sprint 2. Week 1: collect and label 100 real frames (zone, yard) with `export-training-set.mjs`. Week 2: baseline report from `evaluate.py` for every backend. Week 3: the teammate's model measured with the same harness and activated if it beats the baseline. Week 4: calibrate stock constants and the deadband on real frames; first tamper check.

## Milestone log

| Date | Milestone | Verified by live demo? |
|---|---|---|
| 2026-09-07 | POC committed (Streamlit, YOLO-World zero-shot, heuristics, SQLite) - see `git log` | Team to confirm demo status |
| 2026-10-11 | First platform cut: API, database, inference service, web app, 116 tests (engineer-typed data entry) | Yes: `npm run test:all` |
| 2026-10-12 | Automated-evidence redesign: cameras only, no human path to evidence, derived hazards, plug-in model registry, 261 tests; measured fidelity on synthetic frames: work done -1.0 %, spend -1.6 % | Yes: `npm run test:all`, `npm run dev` demo, tamper demo in test-plan.md |

Add a row for every claimed milestone with a live-demo confirmation. Do not mark anything done that cannot be shown running.
