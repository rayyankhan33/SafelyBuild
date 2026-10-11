# Iteration plan, work breakdown and milestone log

Owners are **proposed** from the proposal's work division; the team should confirm or change them and record real dates. Status describes what exists in the repository and was verified on 2026-10-11 (evidence column = command or file).

## Iteration plan

| Iteration | Window | Goal |
|---|---|---|
| Sprint 1 (this) | Oct 2026 | Core pipelines, schema, basic UI for both roles, tests, docs |
| Sprint 2 | Nov-Dec 2026 | Labelled data and measured detection accuracy; material counting model; crack width; engineer confirm/dismiss of defects; UI tests |
| Sprint 3 | Feb-Mar 2027 | Fine-tuned model in the pipeline; PDF/drawing assisted BOQ; reports for investors; Docker deployment |
| Sprint 4 | Apr-May 2027 | Pilot on real site data; threshold calibration; final validation |

## Sprint 1 work breakdown

| # | Task | Proposed owner | Status | Evidence |
|---|---|---|---|---|
| 1 | Re-scope after pivot, scope table, SRS | All | Done | docs/srs.md |
| 2 | PostgreSQL schema (26 tables), reference data, migrations | Rayyan | Done | `db/migrations`, docs/erd.md, schema tests |
| 3 | Move POC into inference service; FastAPI endpoints; activity detection | Hadi | Done | `services/inference`, 22 pytest |
| 4 | ACI 211.1 mix design and estimate | Rayyan | Done | `domain/aci211.js`, `estimation.js`, TC-ACI/EST |
| 5 | Schedule generator | Rayyan | Done | `domain/schedule.js`, TC-SCH |
| 6 | Earned-value budget and schedule forecasts | Rayyan | Done | `domain/evm.js`, TC-EVM |
| 7 | SDI, risk matrix, ALARP, bow-tie, hazard library | Rayyan | Done | `domain/risk.js`, TC-RSK |
| 8 | Auth, RBAC, tenancy, audit | Rayyan | Done | TC-API-AUTH/RBAC/AUDIT |
| 9 | Photo upload, analysis orchestration, failure handling | Rayyan / Hadi | Done | TC-API-PHOTO |
| 10 | Investor dashboard | Atyab | Done | `apps/web/src/pages/Investor.jsx` |
| 11 | Engineer views (overview, design, schedule, log, risk) | Atyab | Done | `apps/web/src/pages/engineer` |
| 12 | Demo data generator | Rayyan | Done | `npm run db:reseed` |
| 13 | Test suite and results log | All | Done (116 tests) | docs/test-results.md |
| 14 | Docker packaging | Atyab | Written, **not run** | docker-compose.yml |
| 15 | Measured detection accuracy on labelled data | Hadi | **Not started** (no labelled set) | - |
| 16 | Material counting from photos | Hadi | **Not started** (simulated only) | - |
| 17 | UI automated tests | Atyab | **Not started** | - |
| 18 | Mid report text (R&D, gap analysis) | All | **Team to write** | - |

Recovery plan for items 15-17: weekly demonstrable milestones in Sprint 2: week 1 collect and label 100 photos; week 2 baseline precision/recall report; week 3 first trained model behind `/v1/defects`; week 4 material count prototype.

## Milestone log

| Date | Milestone | Verified by live demo? |
|---|---|---|
| 2026-09-07 | POC committed (Streamlit, YOLO-World zero-shot, heuristics, SQLite) - see `git log` | Team to confirm demo status |
| 2026-10-11 | Sprint 1 platform built: API, database, inference service, web app, demo data, 116 tests | Yes: `npm run test:all`, demo checklist in test-plan.md |

Add a row for every claimed milestone with a live-demo confirmation. Do not mark anything done that cannot be shown running.
