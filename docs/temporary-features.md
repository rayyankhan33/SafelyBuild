# Temporary features

## Test footage (added in sprint 2, to be removed)

**What it is.** In a project, engineers have a "Test footage" tab (administrators and investors do not, and the API refuses them). They upload a video (mp4, mov, avi, webm, mkv) or a single image; the inference service samples frames, runs YOLO-World on them and returns annotated frames and a per-object summary. It exists so the team can see what the model finds in real footage before real cameras are connected.

**Why it must go.** The project's promise is that nobody on site can enter or edit evidence. An upload button is a human path to the vision model. To keep the promise while it exists, it is a sandbox:

- Results live only in `test_runs` / `test_frames` and `storage/testing/`. Nothing is written to `media`, `defects`, `inference_runs` or any observation table, so progress, spend, hazards, risk scores, forecasts, alerts and the investor dashboard cannot be affected. Test `SANDBOX` in TC-API-FOOTAGE checks this.
- Administrators and investors cannot upload, list, view or delete runs (403). Uploads and deletions are audited.
- One run at a time per project; file type checked by magic bytes; size limit `MAX_TEST_UPLOAD_MB` (300).

**Sampling rule (why 3 seconds).** One window per `interval_s` (default 3, allowed 1-10). In each window up to 6 candidate frames are read and the sharpest (Laplacian variance) is analysed, because motion blur costs more accuracy than a late frame. A frame that differs from the last analysed frame by under 2 grey levels is not re-analysed (re-checked at least every 15 s). A detection is "confirmed" only if it overlaps (IoU >= 0.3) a detection of the same label in the previous analysed frame. At most 400 frames per run (hard limit 600); if the footage is longer the interval is widened and the run says so. Measured on the real model: about 0.3 s per analysed frame on CPU, so a 1-hour video at the default takes roughly 20 minutes in the worst case and far less when the scene is static. The model is limited to half the CPU cores (`YOLO_THREADS`) and jobs run one at a time.

**How to remove it** (nothing else depends on it):

1. New migration dropping `test_frames` and `test_runs` (006 stays in history).
2. Delete `apps/api/src/services/testfootage.js`; remove its import and the `failStaleRuns` call in `apps/api/src/server.js`.
3. In `apps/api/src/routes/projects.js` remove the `/test-footage/defaults`, `/projects/:pid/test-runs...` and `/test-frames/:id/image` routes and the multer/os/fs imports they alone use.
4. Remove `putTestFrame` / `removeTestRun` from `apps/api/src/storage.js`, `testUploadMaxBytes` / `testUploadTimeoutMs` from `apps/api/src/config.js`, and delete `storage/testing/`.
5. Delete `apps/web/src/pages/engineer/TestFootage.jsx` and its tab and import in `ProjectPage.jsx`.
6. Delete `services/inference/footage.py`, `services/inference/tests/test_footage.py`, the `/v1/test/*` endpoints and `_footage_params` in `service.py`, and `detect_free` in `yolo_scene.py`.
7. Delete the `TEMPORARY test footage` block in `apps/api/test/api.test.js` and the `/v1/test/` handler and `TEST_*` settings in `apps/api/test/env.js`; run `npm run docs:erd` and `npm run test:all`.
8. Remove FR-42, TC-API-FOOTAGE / TC-INF-FOOTAGE from `srs.md` and `test-plan.md`.
