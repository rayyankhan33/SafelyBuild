# Iteration plan, work breakdown and milestone log

Owners are **proposed** from the proposal's work division; the team should confirm or change them and record real dates. Status describes what exists in the repository and was verified on 2026-10-12 (evidence column = command or file).

## Iteration plan

| Iteration | Window | Goal |
|---|---|---|
| Sprint 1 (this) | Oct 2026 | Platform: schema, API, automated evidence pipeline, both dashboards, tests, docs |
| Sprint 2 | Nov-Dec 2026 | **Real footage and measured accuracy**: collect and label real site frames, evaluate every backend, integrate the teammate's trained model, calibrate stock constants and the noise deadband, camera-tamper checks |
| Sprint 3 | Feb-Mar 2027 | Fine-tuned models in production use, extra defect and hazard classes, drawing-assisted BOQ, investor reports, Docker deployment |
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
| 10 | Investor dashboard (plain language, evidence note, demo banner) | Atyab | Done | `apps/web/src/pages/Investor.jsx` |
| 11 | Engineer views (overview, design, schedule, crews & equipment, evidence, read-only risk) | Atyab | Done | `apps/web/src/pages/engineer` |
| 12 | Demo data through the real pipeline with fidelity report | Rayyan | Done | `npm run db:reseed` |
| 13 | Test suite and results log | All | Done (230 tests) | docs/test-results.md |
| 14 | Docker packaging | Atyab | Written, **not run** | docker-compose.yml |
| 15 | **Real-footage evaluation of all backends** | Hadi + teammate | **Not started** (no labelled real photos) | - |
| 16 | **Trained model integrated and measured** | Teammate | **In progress by teammate** for rust/honeycomb (not in repo). **Cracks: done as a plugin** (Rayyan): MobileNetV3 trained on SDNET2018, measured on held-out photographs (AUC 0.88) and on an out-of-domain check that shows many false alarms; opt-in, not active; no real CCTV footage yet | docs/model-integration.md, [crack-model.md](crack-model.md), `plugins/crack_cnn.py`, `tests/test_crack.py` |
| 16b | CCTV video monitor for cracks (temporal confirmation) | Rayyan | Built; verified on synthetic clips only | `services/inference/crack_video.py` |
| 17 | YOLO-World pretrained backend run and measured | Hadi | Installed and smoke-tested 2026-10-13 (nothing found at default threshold; no steel at any threshold); **accuracy not measured, not active** | docs/model-integration.md section 5 |
| 18 | Camera tamper checks (lens covered, redirected) | Rayyan | **Not started** | design.md section 10 |
| 19 | UI automated tests | Atyab | **Not started** | - |
| 20 | Mid report text (R&D, gap analysis) | All | **Team to write** | - |

Recovery plan for items 15-19: weekly demonstrable milestones in Sprint 2. Week 1: collect and label 100 real frames (zone, yard) with `export-training-set.mjs`. Week 2: baseline report from `evaluate.py` for every backend. Week 3: the teammate's model measured with the same harness and activated if it beats the baseline. Week 4: calibrate stock constants and the deadband on real frames; first tamper check.

## Milestone log

| Date | Milestone | Verified by live demo? |
|---|---|---|
| 2026-09-07 | POC committed (Streamlit, YOLO-World zero-shot, heuristics, SQLite) - see `git log` | Team to confirm demo status |
| 2026-10-11 | First platform cut: API, database, inference service, web app, 116 tests (engineer-typed data entry) | Yes: `npm run test:all` |
| 2026-10-12 | Automated-evidence redesign: cameras only, no human path to evidence, derived hazards, plug-in model registry, 230 tests; measured fidelity on synthetic frames: work done -1.0 %, spend -1.6 % | Yes: `npm run test:all`, `npm run dev` demo, tamper demo in test-plan.md |

Add a row for every claimed milestone with a live-demo confirmation. Do not mark anything done that cannot be shown running.
