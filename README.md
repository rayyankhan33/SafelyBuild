# SafelyBuild

Construction progress, cost and safety monitoring for investors and site engineers, **measured from fixed-camera images that nobody on site can edit**.

An engineer enters only the initial design/budget (bill of quantities), the crews on site and the equipment available. Everything else is measured automatically: how far each part of the building has got, how much material was used (and so how much money was spent), and which defects and hazards exist. The system forecasts final cost and finish date with earned-value maths and shows investors a plain-language dashboard, while giving engineers the technical detail: standards, scores, hazard categories, suggested measures and warnings.

**Status: Sprint 1 (FYP-1 mid evaluation).** The platform and the automated pipeline work end to end and are tested (261 automated tests). **Read the limits first:** the demo project uses *synthetic* camera frames; the image methods are validated only on those; accuracy on real site footage is not yet measured; a trained model from the team is expected to plug in (see [docs/model-integration.md](docs/model-integration.md)). Details in [docs/srs.md](docs/srs.md) section 5.

| | |
|---|---|
| Investor view | Progress vs plan, money spent, expected final cost and overrun, expected finish date, safety light, productivity, alerts, camera photos, all in plain words |
| Engineer view | BOQ and ACI 211.1/318 estimate, schedule, crews and equipment, evidence (camera health, frames, which model measured them), read-only risk: danger index, risk matrix, hazards with category / ALARP zone / bow-tie, standards, warnings |
| Tamper resistance | Frames only from registered cameras (secret key, clock check, replay protection); no route to enter or edit progress, spend, defects or hazards; hazards close only after the cameras show the area clean on 3 consecutive days |
| Stack | React + Vite, Node/Express, PostgreSQL, Python/FastAPI + OpenCV, pluggable model backends |

## Quick start

See [docs/implementation.md](docs/implementation.md) for details.

```bash
npm install
cd services/inference && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt && cd ../..
npm run dev             # starts everything -> http://localhost:5173  (Ctrl+C stops it)
npm run test:all        # 261 tests (database must be running), writes docs/test-results.md
```

`npm run dev` starts PostgreSQL, the image-analysis service, the API and the web app in order, builds the demo project on first run (about a minute), and prefixes every log line with the service name. Each part can also be run alone (see implementation.md).

Demo logins and what to check in each view: [docs/demo-accounts.md](docs/demo-accounts.md).

**Crack detection on CCTV footage** (trained model, not active in the app until you choose it; see [docs/crack-model.md](docs/crack-model.md)):

```bash
cd services/inference
.venv/Scripts/python crack_video.py --source site_cam.mp4 --every 2 --out annotated.mp4 --events events.json
# use it inside the app:  set BACKEND_DEFECTS=crack_cnn before starting the inference service
```

## Documents

| Document | Purpose |
|---|---|
| [docs/proposal-revised.md](docs/proposal-revised.md) | Revised proposal: problem, scope, modules, timeline after the pivot and the new financial and schedule modules (open decisions marked) |
| [docs/srs.md](docs/srs.md) | Scope, success criteria, numbered requirements with acceptance checks, known limitations |
| [docs/design.md](docs/design.md) | Architecture, interfaces, sequence and state diagrams, algorithms, the evidence and tamper model |
| [docs/model-integration.md](docs/model-integration.md) | **For the model-training teammate**: contract, plug-in steps, evaluation, training-data export |
| [docs/crack-model.md](docs/crack-model.md) | **Trained crack model** (SDNET2018): data, training, measured results, CCTV video monitor, limits, how to activate |
| [docs/erd.md](docs/erd.md) | ER diagram generated from the live database |
| [docs/implementation.md](docs/implementation.md) | Setup, file map, key-function walkthrough, decisions |
| [docs/test-plan.md](docs/test-plan.md), [docs/test-results.md](docs/test-results.md) | Test strategy, 14 failures found, latest run |
| [docs/tool-disclosure.md](docs/tool-disclosure.md) | AI and tool disclosure, privacy |
| [docs/iteration-plan.md](docs/iteration-plan.md), [docs/risks.md](docs/risks.md) | Plan, milestone log, risks |
| [docs/panel-action-register.md](docs/panel-action-register.md) | Panel actions (to be completed by the team) |
| [docs/rubric-conformance.md](docs/rubric-conformance.md) | Mid-evaluation rubric mapping and pre-evaluation checklist |
| [docs/poc-README.md](docs/poc-README.md) | Original proof of concept description |

## Layout

```
apps/api            Node/Express API, domain logic, tests
apps/web            React web app (investor and engineer views)
services/inference  Python image-analysis service: backend registry, classical and pretrained backends, plug-ins (incl. the trained crack model), evaluation, CCTV video monitor
db                  SQL migrations and reference data
scripts             dev launcher, dev database, camera simulator, training-set export, ERD generator, test runner
docs                all documentation
```

The original Streamlit proof of concept is kept at `services/inference/poc_streamlit_app.py` (needs `requirements-poc.txt`; not re-tested).
