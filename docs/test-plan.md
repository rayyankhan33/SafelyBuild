# Test plan and early validation (Sprint 1)

Results of the latest full run are generated into [test-results.md](test-results.md) by `npm run test:all` (needs PostgreSQL: `npm run db:start`). The numbers below were true on 2026-10-11; re-run before quoting them.

## 1. Strategy

| Level | Tool | What it proves | Count |
|---|---|---|---|
| Unit (pure domain) | Node test runner | Formulas against hand-calculated values: dates, ACI mix, estimate, schedule, earned value, SDI, risk matrix, alert rules, wording | 48 |
| Integration (API + real PostgreSQL + fake inference server) | Node test runner, `fetch` | Auth, RBAC, tenancy, workflows, validation, photo pipeline, failures, audit | 37 |
| Schema / design consistency | Node test runner | ERD equals live schema, migrations repeatable, DB constraints hold | 11 |
| Inference service | pytest + FastAPI TestClient, real sample photos | Detection on real images, synthetic edge images, HTTP errors; crack model (stub-model logic, CCTV temporal confirmation, service integration, real-model checks on held-out SDNET patches) | 44 |
| Manual / demo | Browser | UI behaviour, charts, photos, both roles | see section 4 |

The integration tests use a separate database (`safelybuild_test`) that is wiped each run. The inference server is faked in Node so that failure modes (down, 500) can be forced; the real Python service is tested separately and used in the manual demo.

## 2. Case catalogue (by requirement)

| Requirement | Test group | Examples of edge and failure cases |
|---|---|---|
| FR-01 | TC-API-AUTH | wrong password = unknown user message; 6th failed attempt blocked even with the right password; disabled account; garbage token; duplicate email 409; short password 422 |
| FR-02, FR-03 | TC-API-RBAC | other organisation gets 404; non-member 404; investor blocked on 4 write endpoints; malformed project id gives 404 not 500 |
| FR-04 to FR-08 | TC-EST, TC-ACI, TC-SCH, TC-API-SETUP | missing dimension, zero/negative size, no grade, empty BOQ, contingency 80%, missing rate, zero rate, strength 40 MPa refused, unsupported aggregate size, steel below ACI 318 minimum, Sunday start, minimum duration, more crews |
| FR-09, FR-10 | TC-API-LOG | future date, date before project start, unknown task, decreasing progress, progress above a later day, re-submitting a day, regenerate schedule after progress (409) |
| FR-11 to FR-15 | TC-API-PHOTO + pytest | PHP script with image content type, empty upload, empty bytes, tiny image, 3000x4000 image downscaled, clean grey wall, pure rust colour, brightness change is not activity, different viewpoint flagged, service down, service 500, bad parameters |
| FR-16 to FR-18 | TC-EVM | behind and over budget, on plan, ahead, fewer than 3 logs, no progress after 3 days, before start, completed late, zero budget |
| FR-19 to FR-22 | TC-RSK, TC-ALR | no inspection in window, density counting, weights shift, worsening vs steady, hazard rating bounds, ALARP boundaries 4/5/14/15, alert dedupe and resolve |
| FR-23, FR-24 | TC-API-PHOTO | investor payload lacks engineering sections; engineer payload has standards, mixes, categories, controls |
| NFR-03, NFR-04 | TC-SCHEMA | invalid ratings, reversed dates, negative money, duplicate log day, duplicate open alert, cascade delete, ERD drift |

## 3. Failures found and what they taught us

These are real findings from building Sprint 1, kept here as evidence of discussion of failure cases.

| # | What went wrong | How found | Resolution |
|---|---|---|---|
| 1 | Two of my own test expectations were wrong (a 10% overrun is "at risk", not "over budget" by the documented rule; plan curve is drawn for the whole planned period even before the project starts). The code was right. | First run of the unit tests | Fixed the tests, kept the documented rule |
| 2 | Spend total expected as 20 x 5 x 1400 instead of 4 x 5 x 1400 | First run of integration tests | Arithmetic slip in the test; fixed |
| 3 | Photo endpoint set `Cache-Control: max-age` before reading the file. When the file was missing, the browser cached the 500 error and kept showing "Image unavailable" after the server was fixed | Manual testing in the browser | Read the file first, then set headers; regression test added (`regression: a missing photo file...`) |
| 4 | Demo project was planned to finish before today because the BOQ was too small, so everything showed "behind" | Looking at the first seeded dashboard | Larger demo BOQ (101 working days) |
| 5 | Task order followed element type, putting all columns before any beams | Reading the seeded schedule | Schedule now follows BOQ order; test updated; UI text explains it |
| 6 | The dev machine had no Node or PostgreSQL and the PostgreSQL download was blocked | Environment setup | Node via winget; PostgreSQL binaries via the `embedded-postgres` npm package (`npm run db:start`) |

## 4. Manual demo checklist

1. `npm run db:start`, `npm run db:reseed`, `npm run inference`, `npm run api`, `npm run web`.
2. Sign in as the investor: dashboard shows progress, spend, forecast, safety light, plain sentences, four charts (each with a "Show table" view), alerts and photos.
3. Sign in as the engineer: Overview shows technical lines; Risk tab shows SDI breakdown, matrix, hazards with bow-tie and standards; click "View photo" to see boxes drawn on the image.
4. Failure demo: stop the inference service, upload a photo in Daily log: the photo is saved, analysis shows "failed", a system alert appears; restart the service, upload again, the alert clears.
5. Edge demo: save a log with progress lower than the previous day (rejected with the reason); log for a future date (rejected).
6. Live computation demo: add a day's log with extra cement and watch spend, forecast and status change.

## 5. Gaps (honest)

- No automated browser (UI) tests; the front end is verified manually.
- Rust and honeycomb accuracy has not been measured against labelled data; heuristics were tuned on 4 images. A labelled evaluation set is a Sprint 2 task. Crack accuracy is measured on held-out SDNET photographs and an 18-image CODEBRIM check ([crack-model.md](crack-model.md)); there is no test on real CCTV footage.
- Docker compose files exist but were not run (Docker not installed on the development machine).
- Load testing beyond one project with 36 days of data has not been done.
