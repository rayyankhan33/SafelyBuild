# SafelyBuild - Software Requirements Specification (Sprint 1)

Version 0.1, Sprint 1. Every requirement has an ID, a verifiable acceptance check and (where automated) the test that proves it. Test IDs refer to `apps/api/test/*.test.js` and `services/inference/tests/test_service.py`; results are in [test-results.md](test-results.md).

## 1. Vision, scope and success criteria

**Product.** SafelyBuild lets an investor who is not an engineer follow a construction project: how far it has got, where the money has gone, whether it will finish on time and on budget, and whether the site is safe. Site engineers use the same system to enter the design, log each day's work, and upload photos; they get the technical detail behind every number.

**Change from the proposal.** The original proposal targeted a regulatory council with an engineer blacklist. That module is removed. Risk scoring, risk matrices, ALARP and bow-tie analysis are kept but presented in plain language to investors. Two modules were added: financial tracking and schedule tracking. See [design.md](design.md#9-design-evolution-from-the-proposal) for the reasoning.

### Scope table

| Module | In Sprint 1 | Deferred / excluded |
|---|---|---|
| Design input | Structured BOQ entry (5 element types) | Drawing/PDF/IFC parsing |
| Cost estimation | ACI 211.1 mix design, wastage, bulking/compaction, PKR rates, contingency, ACI 318 steel check | Labour, plant, formwork, overheads; non-ACI mix methods |
| Financial tracking | Daily material spend from site logs; EVM forecast (EAC, overrun, CPI) | Reading quantities from photos automatically (no model; simulated provider only) |
| Schedule tracking | Baseline schedule from BOQ; daily % progress; SPI forecast, finish date, days early/late; productivity | Critical-path with parallel tasks; resource levelling; progress from photos |
| Defect detection | Rusted rebar and honeycombed concrete (OpenCV heuristics; optional YOLO-World) | Trained YOLO model; crack-width measurement |
| Risk | SDI 0-10, risk matrix 5x5, ALARP zones, bow-tie, hazard library, auto hazards from defects | Computer-vision detection of PPE / falls / excavation hazards |
| Dashboards | Investor (plain language) and engineer (technical) | Mobile apps, push notifications, PDF reports |
| Platform | REST API, PostgreSQL schema, JWT auth, RBAC, audit log | Cloud deployment, S3 storage (interface ready) |

### Success criteria (measurable)

| ID | Criterion | How measured |
|---|---|---|
| SC-1 | A new project can go from empty to a live dashboard (BOQ, estimate, schedule, first logs) through the UI/API without touching the database | Demo + TC-API-SETUP |
| SC-2 | Dashboard figures reproduce exactly from stored records (spend equals sum of logged material costs; task budgets sum to the estimate) | TC-API-LOG, TC-API-SETUP |
| SC-3 | Forecast statuses are correct on hand-computed scenarios (on track, behind, over budget, ahead, insufficient data, completed) | TC-EVM-* |
| SC-4 | Investor view contains no engineering jargon; engineer view shows standards, hazard categories, controls and breakdowns | TC-API-PHOTO (view tests), TC-ALR |
| SC-5 | A failed or unavailable analysis service never loses an upload | TC-API-PHOTO (service down / 500) |
| SC-6 | All suites pass from a clean database | `npm run test:all` |

## 2. Users

| Role | Needs | Access |
|---|---|---|
| Investor | Plain-language progress, spend, forecast, safety; photos | Read-only on projects they are a member of |
| Site engineer | Enter BOQ/rates, estimate, schedule, daily logs, photos; see technical breakdowns, hazards, standards | Read/write on their projects |
| Administrator | Create users, add members, see all projects in the organisation | Whole organisation |

## 3. Functional requirements

| ID | Requirement | Acceptance check | Tests |
|---|---|---|---|
| FR-01 | Users sign in with email and password and receive a time-limited token. Wrong credentials and unknown users get an identical error. After 5 failures in 15 minutes the account/IP pair is blocked. Disabled accounts cannot sign in or use an old token. | Login succeeds with valid data; both failure cases return 401 with the same message; 6th attempt returns 429. | TC-API-AUTH |
| FR-02 | Data is isolated per organisation and per project. Another organisation's project returns 404 (not 403). Engineers and investors only see projects they are members of; admins see their organisation's projects. | Cross-organisation and non-member requests get 404; project list is filtered. | TC-API-RBAC |
| FR-03 | Investors are read-only. Any write endpoint returns 403 for them. | PUT/POST attempts by an investor return 403. | TC-API-RBAC |
| FR-04 | Engineers enter design elements (footing, column, beam, slab, masonry wall) with dimensions, quantity and concrete strength. Missing or non-positive dimensions are rejected with the field named. | Incomplete element returns 422 naming the missing field. | TC-API-SETUP, TC-EST |
| FR-05 | The estimate computes concrete mix per m3 by the ACI 211.1 absolute-volume method (required strength from ACI 318), converts to purchase quantities using loose bulk densities (compaction factor), applies wastage, prices with project rates in PKR and adds contingency. Total equals the sum of line costs plus contingency. Strengths outside the ACI table range are refused, not extrapolated. | Hand-checked 25 MPa mix (water 193, cement about 391, coarse 1072 kg/m3); strength 40 MPa refused. | TC-ACI, TC-EST |
| FR-06 | Steel below the ACI 318 minimum ratio for columns and slabs raises an advisory warning; the estimate still completes. | Warning with code `ACI318_MIN_STEEL`. | TC-EST |
| FR-07 | Activating an estimate sets the project budget. Rate edits affect only later estimates (each estimate stores the factors and rates it used). | Budget equals active estimate total; rate change raises the next estimate. | TC-API-SETUP |
| FR-08 | A baseline schedule is generated from the BOQ (duration = volume / (output per crew-day x crews), minimum duration, Monday-Saturday calendar, finish-to-start in BOQ order). Task budgets sum to the active estimate (with contingency). Regenerating after progress exists requires explicit confirmation. | Task budgets sum to estimate; regeneration returns 409 `would_erase_progress` unless confirmed. | TC-SCH, TC-API-SETUP, TC-API-LOG |
| FR-09 | An engineer records a daily log: workers, weather, notes, cumulative % complete per task and materials used. Dates in the future or before project start are rejected; progress may never decrease over time or exceed a later day's value; unknown tasks are rejected. Re-submitting a day replaces that day's entries. | See tests. | TC-API-LOG |
| FR-10 | Spend = quantity x rate snapshot at entry time; the dashboard's "spent" equals the sum of logged costs. | 4 days x 5 bags x PKR 1400 = PKR 28,000 on the dashboard. | TC-API-LOG |
| FR-11 | Photo upload accepts JPEG, PNG, WebP, BMP identified by file content (not the declared type), up to 15 MB each. Other content is rejected. | Script disguised as an image returns 422. | TC-API-PHOTO |
| FR-12 | Each photo is analysed for rusted rebar and honeycombed concrete; findings (type, score, severity, box, violation flag) are stored. | Findings stored and shown with annotated boxes. | TC-API-PHOTO, inference tests |
| FR-13 | Photos tagged "overview" are compared with the previous overview photo to give a scene-change ratio and an alignment check. | Activity result returned; first overview is "skipped". | TC-API-PHOTO, inference tests |
| FR-14 | Photos tagged "materials" return quantity proposals the engineer must confirm. Sprint 1 has no counting model: default mode returns no proposals; `simulated` mode returns clearly flagged demo values stored with source `ai_simulated`. | Simulated values flagged in API, UI and database. | inference tests |
| FR-15 | If analysis fails (service down, error, timeout) the photo is still stored, the run is recorded as failed, a system alert is opened, and it is resolved after the next success. | Service down and 500 cases. | TC-API-PHOTO |
| FR-16 | Budget forecast (earned-value method): PV, EV, AC, CPI, EAC = BAC/CPI, overrun in PKR and %, a range using the recent cost trend, and a status: on track (overrun up to 2%), at risk (up to 10%), over budget (above 10%), under budget. With fewer than 3 daily logs or no earned value the status is "gathering data" and no forecast is shown. | Hand-computed scenarios. | TC-EVM |
| FR-17 | Schedule forecast: SPI, forecast duration = planned / SPI in working days, forecast finish date, days early/late, status (ahead, on track, at risk, behind), plus completed, not started, insufficient data. If no progress is recorded no date is invented. Forecast is capped at 10x plan. | Hand-computed: SPI 0.8 on a 10-day plan gives finish 19 Oct, 4 days late. | TC-EVM |
| FR-18 | Productivity: ratio of value earned to value planned per logging interval, with a 7-sample recent average labelled good (>=0.95), fair (>=0.75), low. | Productivity series values. | TC-EVM |
| FR-19 | Structural Danger Index 0-10 from three pillars (severity, density, progression) with weights 0.6/0.4/0 for the first inspection day, 0.5/0.3/0.2 below 5 inspection days, 0.4/0.3/0.3 after. Bands: <2.5 low, <5 moderate, <7.5 high, >=7.5 critical with an escalation flag. No inspection in the last 7 days gives no score. | See tests. | TC-RSK |
| FR-20 | Hazards use a 5x5 risk matrix (rating = likelihood x severity), ALARP zones (>=15 intolerable, 5-14 ALARP, <=4 acceptable) and a bow-tie (causes, preventive barriers, consequences, mitigating barriers) from a library of 8 hazards in 6 categories. Engineers can add hazards, change status, likelihood and severity. | Zone boundaries 4/5/14/15; closing a hazard lowers the status. | TC-RSK, TC-API-PHOTO |
| FR-21 | Violation-level defects create or update exactly one open hazard per type; re-detection raises likelihood (never duplicates). | Second detection leaves one hazard. | TC-API-PHOTO |
| FR-22 | Alerts for budget, schedule and safety conditions: one open alert per condition, auto-resolved when it clears, with plain wording for investors and technical wording for engineers. Engineers can acknowledge. | Diff logic. | TC-ALR |
| FR-23 | The investor dashboard shows progress vs plan, money spent, expected final cost and overrun, expected finish and days late/early, safety status, productivity, alerts and photos, in plain words. It contains no SDI/CPI/EAC/ALARP terminology and no engineering internals. | Investor payload has no `risk`, `standards`, `estimate`; alert text has no jargon. | TC-API-PHOTO, TC-ALR |
| FR-24 | The engineer dashboard additionally shows the indices and formulas, SDI breakdown with weights and explanation, risk matrix, hazards with category, zone, standard and controls, defects with annotated photos, the estimate with mixes and warnings, and the standards used. | Engineer payload contains these. | TC-API-PHOTO |
| FR-25 | Every mutation is written to an audit log with the acting user. | Audit rows exist; investors cannot read the log. | TC-API-AUDIT |
| FR-26 | `npm run db:seed` builds a realistic demo project through the same services as the API (no hand-typed dashboard numbers). | Seeded project shows computed statuses. | manual demo |

## 4. Non-functional requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| NFR-01 Security | Passwords hashed (bcrypt); tokens expire (12 h); login rate limit; cross-tenant access hidden as 404; uploads validated by content; storage keys cannot escape the storage directory; JWT secret mandatory in production. | TC-API-AUTH, TC-API-RBAC, TC-API-PHOTO |
| NFR-02 Reliability | Every call to the inference service has a timeout (default 60 s). Its failure never fails an upload. | TC-API-PHOTO |
| NFR-03 Integrity | Business invariants are enforced in the database as well as the application: bounded ratings, ordered dates, non-negative money, one log per project-day, one open alert per key, cascade on project delete. | TC-SCHEMA |
| NFR-04 Reproducibility | Migrations are idempotent; the ERD is generated from the live schema and a test fails on drift; each estimate stores the factors and rates it used. | TC-SCHEMA |
| NFR-05 Explainability | Every displayed number has a documented formula ([design.md](design.md#6-algorithms)); engineer view shows the method; investor view explains in words. | Review |
| NFR-06 Accessibility and usability | Status is never colour alone (icon + label); chart data available as a table; light and dark themes; layouts work at phone width. | Manual review |
| NFR-07 Performance | Dashboard for a project with 36 daily logs responds in under 1 s (measured 260-620 ms, 10 requests); image analysis about 0.04 s per image with the OpenCV backend. | Measured 2026-10-11 |
| NFR-08 Portability | All services run on Windows without Docker or an installed database (`npm run db:start` provides PostgreSQL). Docker files are provided but not yet tested. | README quickstart |

## 5. Known limitations (stated, not hidden)

1. Defect scores come from colour/texture heuristics tuned on 4 sample images, not a trained model. They produce false positives (soil, bricks, formwork). The tile backend flags many tiles per image; the SDI uses image-level density to limit the effect.
2. No model counts materials from photos. Spend is entered by the engineer; the photo workflow and provenance fields are ready for a model.
3. Default material rates and productivity values are demonstration placeholders and must be replaced per project.
4. ACI table values are transcribed for one case (non-air-entrained, slump 75-100 mm, fineness modulus 2.8, max aggregate 19/25/37.5 mm). Verify against a licensed copy of ACI 211.1 and ACI 318 before real use.
5. Cost covers bulk materials only.
