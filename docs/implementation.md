# Implementation guide

How to run the system, what each main file does, and the technical decisions behind it. Written so any team member can walk through the code line by line.

## 1. Setup (Windows, no Docker needed)

Prerequisites: Node.js 20+ and Python 3.11+. PostgreSQL is provided by `npm run db:start` (real PostgreSQL binaries through the `embedded-postgres` package), or use your own PostgreSQL 15+ and set `DATABASE_URL`.

```bash
npm install
cd services/inference && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt && cd ../..

npm run dev           # one command: database, inference, API, web, demo data (Ctrl+C stops all)
```

The first `npm run dev` builds the demo project: it simulates six weeks of site activity, renders about 270 synthetic camera frames and passes them through the real pipeline (about a minute).

Or start each part yourself, one terminal each:

```bash
npm run db:start        # PostgreSQL on :5432
npm run inference:demo  # image analysis on :8000 with synthetic frames enabled (needed by the seed)
npm run db:seed         # demo project (needs the line above)
npm run api             # API on :4000
npm run web             # web app on http://localhost:5173
npm run test:all        # all tests, writes docs/test-results.md
```

Demo accounts: [demo-accounts.md](demo-accounts.md). Configuration by environment variables (see `.env.example`): `DATABASE_URL`, `JWT_SECRET` (required when `NODE_ENV=production`), `INFERENCE_URL`, `STORAGE_DIR`, `PORT`, `CORS_ORIGIN`, `SITE_UTC_OFFSET_HOURS` (default 5), `MAX_CLOCK_SKEW_MS`, `MAX_FRAMES_PER_CAMERA_PER_DAY`; for the inference service `ENABLE_DEMO_FRAMES`, `BACKEND_DEFECTS`, `BACKEND_STAGE`, `BACKEND_INVENTORY`, `YOLO_WORLD_WEIGHTS`.

Useful scripts: `scripts/camera-sim.mjs` (act as a camera), `scripts/export-training-set.mjs` (frames and predictions for labelling), `scripts/gen-erd.mjs` (`npm run docs:erd`), `services/inference/evaluate.py` (measure a backend).

## 2. Repository map

```
apps/api/src/
  domain/      pure logic: dates, aci211, estimation, schedule, stages, inventory, evm, risk, evidence, narrative, alerts
  services/    projects.js (BOQ, price book, estimate, schedule, site status), ingest.js (cameras, frames),
               rollup.js (replay observations into figures), forecast.js (recompute + dashboards)
  routes/      auth.js, projects.js (user routes), ingest.js (camera route)
  db/          pool.js, migrate.js, seed.js
  http.js      errors, zod parsing, JWT auth, RBAC, audit, login limiter
  inference.js storage.js config.js app.js server.js
apps/api/test/   unit, integration, schema tests (+ env.js: test database and fake inference server)
apps/web/src/    App.jsx, api.js, components.jsx, pages/ (Login, Projects, Investor, ProjectPage, engineer/*)
services/inference/
  service.py       HTTP endpoints          registry.py   backends per task, plug-in loading, model stamp
  scene.py         classical stage + stock  pipeline.py   defects (OpenCV tiles), activity, image decoding
  yolo_scene.py    pretrained zero-shot     evaluate.py   measure a backend on labelled images
  demo_frames.py   synthetic frames         plugins/      drop-in trained models (+ _template.py)
  heuristics.py severity.py detector.py     the original POC code
db/migrations/   001_init.sql (core schema), 002_reference_data.sql, 003_automation.sql (cameras, observations, price book)
scripts/         dev.mjs, dev-db.mjs, camera-sim.mjs, export-training-set.mjs, gen-erd.mjs, run-tests.mjs
docs/            all documentation
```

## 3. Walkthrough: key functions and what breaks without them

| Function | File | What it does | If removed |
|---|---|---|---|
| `ingestFrame` | `services/ingest.js` | Checks type, clock, replay; stores the frame; dispatches analyses; records failures | No evidence enters the system |
| `authenticateCamera` | `services/ingest.js` | Matches the camera key by hash, constant time | Anyone could submit frames |
| `rebuild` (`rebuildProgress`, `rebuildInventory`, `rebuildHazards`) | `services/rollup.js` | Replays all observations into progress, stock, consumption, spend and hazards | Dashboards would show nothing measured |
| `percentOnDate`, `progressHistory` | `domain/stages.js` | Turns agreeing stage observations into % complete with a ratchet | No task progress, so no forecast |
| `dailyStock`, `inventoryHistory` | `domain/inventory.js` | Start/end-of-day stock to consumption and deliveries | No measured spend |
| `deriveHazards` | `domain/risk.js` | Hazards as a pure function of defect evidence, with automatic closure | No hazards, or hazards editable by hand |
| `cameraHealth`, `uncoveredTasks` | `domain/evidence.js` | Detect silent cameras and unwatched tasks | Missing evidence would look like safety |
| `designMix`, `estimate` | `domain/aci211.js`, `estimation.js` | ACI mix and BOQ to PKR | No budget |
| `generateSchedule` | `domain/schedule.js` | Tasks, dates, per-task budgets | No planned value |
| `evaluate`, `forecastBudget`, `forecastSchedule` | `domain/evm.js` | EVM metrics, forecasts, statuses | No predictions or alerts |
| `computeSdi` | `domain/risk.js` | Structural Danger Index | Engineer risk card empty |
| `desiredAlerts`, `diffAlerts` | `domain/alerts.js` | One alert per condition | Duplicate or stuck alerts |
| `buildDashboard` | `services/forecast.js` | Role-based payloads (the investor/engineer split) | Both UIs empty |
| `projectAccess` | `http.js` | Tenancy and membership | Any user could read any project |
| `resolve`, `describe` | `registry.py` | Chooses the backend per task and stamps results | No model could be swapped in |
| `analyze_stage`, `estimate_inventory` | `scene.py` | Classical stage and stock estimates | Zone and yard cameras produce nothing |
| `analyze_defects` | `pipeline.py` | Rust/honeycomb findings | No defects, so no hazards |

## 4. Technical decisions (with trade-offs)

- **Evidence only from cameras.** Costs: needs cameras and calibration; gains: nothing a person types can change the record. Enforced by missing routes, strict zod schemas and database constraints.
- **Replay instead of incremental updates.** `rebuild` recomputes progress, stock, spend and hazards from the raw observations on every ingest. Simple and impossible to drift; at about 270 frames it takes tens of milliseconds. If a project accumulates hundreds of thousands of frames, replay per camera and per day.
- **Dates as `YYYY-MM-DD` strings in the site's time zone (UTC+5).** Avoids shifting a frame to another day; `today()`, frame dates and forecasts agree.
- **Money as NUMERIC and rounded per line.** The total equals the sum of displayed lines. A day's price is frozen the first time it is costed.
- **Classical methods are a baseline, not the answer.** They run the pipeline end to end and provide a number to beat; the registry lets a trained model replace them per task.
- **Inference is a separate process.** Python for vision, Node for the product; a crash in analysis cannot take the API down.
- **Two validation layers.** zod for friendly messages, CHECK constraints for hard guarantees.

## 5. Reproducibility notes

- Seed data is deterministic (fixed random seed) and relative to today's date.
- `docs/erd.md` is generated; run `npm run docs:erd` after changing migrations.
- Migrations 001-003 were edited freely during Sprint 1 because no shared database existed. From now on add `004_*.sql` instead of editing an applied migration, and rebuild the local database with `npm run db:reseed` after pulling (or delete `.pgdata`).
- `npm run db:reseed` empties organisations (and, by cascade, the price book); the seed restores the demo prices.
