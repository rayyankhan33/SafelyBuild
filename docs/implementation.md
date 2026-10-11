# Implementation guide

How to run the system, what each main file does, and the technical decisions behind it. Written so any team member can walk through the code line by line.

## 1. Setup (Windows, no Docker needed)

Prerequisites: Node.js 20+ and Python 3.11+. PostgreSQL is provided by `npm run db:start` (real PostgreSQL binaries through the `embedded-postgres` package), or use your own PostgreSQL 15+ and set `DATABASE_URL`.

```bash
npm install
cd services/inference && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt && cd ../..

npm run db:start      # terminal 1: PostgreSQL on :5432 (leave running)
npm run db:migrate    # create schema and reference data
npm run db:seed       # demo project (needs the inference service for photos)
npm run inference     # terminal 2: image analysis on :8000
npm run api           # terminal 3: API on :4000
npm run web           # terminal 4: web app on http://localhost:5173
npm run test:all      # all tests, writes docs/test-results.md
```

Demo accounts (admin, engineer, investor) are defined at the top of `apps/api/src/db/seed.js`; the demo password is `DEMO_PASSWORD` there. Local demo use only.

Configuration is by environment variables (see `.env.example`): `DATABASE_URL`, `JWT_SECRET` (required when `NODE_ENV=production`), `INFERENCE_URL`, `STORAGE_DIR`, `PORT`, `CORS_ORIGIN`, `MATERIAL_PROVIDER` (inference service: `none` or `simulated`).

Optional YOLO-World backend: `pip install -r services/inference/requirements-yolo.txt` (large; downloads about 338 MB on first use). Not exercised in Sprint 1.

## 2. Repository map

```
apps/api/src/
  domain/      pure logic: dates, aci211, estimation, schedule, evm, risk, narrative, alerts
  services/    projects.js (setup, estimate, schedule, logs), media.js (photos), forecast.js (recompute + dashboards)
  routes/      auth.js, projects.js
  db/          pool.js, migrate.js, seed.js
  http.js      errors, zod parsing, JWT auth, RBAC, audit, login limiter
  inference.js storage.js config.js app.js server.js
apps/api/test/   unit, integration, schema tests
apps/web/src/    App.jsx, api.js, components.jsx, pages/ (Login, Projects, Investor, ProjectPage, engineer/*)
services/inference/  service.py, pipeline.py, heuristics.py, severity.py, detector.py (YOLO-World), POC files
db/migrations/   001_init.sql (schema), 002_reference_data.sql
scripts/         dev-db.mjs, gen-erd.mjs, run-tests.mjs
docs/            SRS, design, ERD, test plan and results, disclosure, plans, risks
```

## 3. Walkthrough: key functions and what breaks without them

| Function | File | What it does | If removed |
|---|---|---|---|
| `designMix` | `domain/aci211.js` | ACI 211.1 absolute-volume mix per m3 | No quantities, so no estimate or budget |
| `estimate` | `domain/estimation.js` | BOQ to quantities and PKR | Budget (BAC) cannot be set |
| `generateSchedule` | `domain/schedule.js` | Tasks, dates, per-task budgets | No planned value, so no progress or forecast |
| `evaluate` | `domain/evm.js` | PV/EV/AC series and metrics | Dashboards have no numbers |
| `forecastBudget`, `forecastSchedule` | `domain/evm.js` | EAC, overrun, finish date, statuses | No predictions or alerts |
| `computeSdi` | `domain/risk.js` | Structural Danger Index | Engineer risk card empty; safety status from hazards only |
| `hazardFromDefect`, `syncHazards` | `domain/risk.js`, `services/media.js` | Turn detected defects into hazards without duplicates | Defects would not reach the hazard register |
| `desiredAlerts`, `diffAlerts` | `domain/alerts.js` | One alert per condition | Alerts would duplicate on every recompute or never clear |
| `upsertLog` | `services/projects.js` | Validated daily log in one transaction | No progress or spend data |
| `ingestPhoto` | `services/media.js` | Store, analyse, record failures | No photo evidence or defects |
| `recompute` | `services/forecast.js` | Re-run everything and persist forecast, SDI, alerts | Stale dashboards |
| `buildDashboard` | `services/forecast.js` | Role-based payloads (the investor/engineer split) | Both UIs empty |
| `projectAccess` | `http.js` | Tenancy and membership | Any user could read any project |
| `analyze_defects` | `services/inference/pipeline.py` | Rust/honeycomb findings per photo | Photos cannot be analysed |
| `activity_change` | `services/inference/pipeline.py` | Scene-change measure between two photos | No activity signal |

## 4. Technical decisions (with trade-offs)

- **Dates as `YYYY-MM-DD` strings in UTC.** Avoids time-zone shifts that would move a log to another day. Cost: custom date helpers (`domain/dates.js`).
- **Money as NUMERIC and rounded per line.** The total equals the sum of displayed lines.
- **Recompute on every write and dashboard read.** Simple and always consistent for the data sizes involved (about 300 ms for 36 days). If projects grow to years of logs, cache forecasts per day.
- **Tiles instead of detection for the default backend.** Needs no model download; coarse (3x3), so findings are areas, not objects. YOLO-World gives boxes when installed.
- **Inference is a separate process.** Python for vision, Node for the product; a crash in analysis cannot take the API down (FR-15).
- **Zod validation at the edge, CHECK constraints in the database.** Two layers: friendly messages for users, hard guarantees for data.

## 5. Reproducibility notes

- Seed data is deterministic (fixed random seed) and relative to today's date.
- `docs/erd.md` is generated; run `npm run docs:erd` after changing migrations.
- Never edit an applied migration on a shared database: add `003_*.sql`. (During Sprint 1 the migrations were edited freely because no shared database existed; run `npm run db:reseed` after pulling.)
