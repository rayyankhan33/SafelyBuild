# SafelyBuild

Construction progress, cost and safety monitoring for investors and site engineers. Engineers enter the design (bill of quantities), log each day's progress, material use and site photos. The system estimates cost with ACI methods, forecasts final cost and finish date, scores site risk, and shows investors a plain-language dashboard while giving engineers the technical detail.

**Status: Sprint 1 (FYP-1 mid evaluation).** Real working pipeline end to end. Two parts are deliberately simple and disclosed: defect detection uses colour/texture heuristics (no trained model yet), and material counting from photos is not implemented (a clearly labelled simulated provider exists for demos). See [docs/srs.md](docs/srs.md) section 5.

| | |
|---|---|
| Investor view | Progress vs plan, money spent, expected final cost and overrun, expected finish date, site safety light, productivity, alerts, photos, all in plain words |
| Engineer view | BOQ and estimate (ACI 211.1 / 318), schedule, daily log with photo analysis, SDI breakdown, risk matrix, hazards with category/ALARP zone/bow-tie, standards used, budget and schedule warnings |
| Stack | React + Vite, Node/Express, PostgreSQL, Python/FastAPI + OpenCV |

## Quick start

See [docs/implementation.md](docs/implementation.md) for details.

```bash
npm install
cd services/inference && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt && cd ../..
npm run db:start        # terminal 1 - local PostgreSQL (leave running)
npm run db:seed         # demo project with ~6 weeks of site records
npm run inference       # terminal 2
npm run api             # terminal 3
npm run web             # terminal 4 -> http://localhost:5173
npm run test:all        # 116 tests, writes docs/test-results.md
```

Demo logins (admin, engineer, investor) and the local-only demo password are at the top of `apps/api/src/db/seed.js`.

## Documents

| Document | Purpose |
|---|---|
| [docs/srs.md](docs/srs.md) | Scope, success criteria, numbered requirements with acceptance checks |
| [docs/design.md](docs/design.md) | Architecture, interfaces, sequence and state diagrams, algorithms, design evolution |
| [docs/erd.md](docs/erd.md) | ER diagram generated from the live database |
| [docs/implementation.md](docs/implementation.md) | Setup, file map, key-function walkthrough, decisions |
| [docs/test-plan.md](docs/test-plan.md), [docs/test-results.md](docs/test-results.md) | Test strategy, failures found, latest run |
| [docs/tool-disclosure.md](docs/tool-disclosure.md) | AI and tool disclosure, privacy |
| [docs/iteration-plan.md](docs/iteration-plan.md), [docs/risks.md](docs/risks.md) | Plan, milestone log, risks |
| [docs/panel-action-register.md](docs/panel-action-register.md) | Panel actions (to be completed by the team) |
| [docs/rubric-conformance.md](docs/rubric-conformance.md) | Mid-evaluation rubric mapping and pre-evaluation checklist |
| [docs/poc-README.md](docs/poc-README.md) | Original proof of concept description |

## Layout

```
apps/api         Node/Express API, domain logic, tests
apps/web         React web app (investor and engineer views)
services/inference  Python image-analysis service (the original POC lives here too)
db               SQL migrations and reference data
scripts          dev database, ERD generator, test runner
docs             all documentation
```

The original Streamlit proof of concept is kept at `services/inference/poc_streamlit_app.py` (needs `requirements-poc.txt`; not re-tested in Sprint 1).
