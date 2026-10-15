-- Migration 006: TEMPORARY test-footage feature.
--
-- Engineers can upload a video or image and see what the vision model detects in sampled frames. These
-- tables are a sandbox: NOTHING in progress, spend, hazards, risk scores or forecasts reads them, and
-- nothing here is written to media, defects or the observation tables. The feature is planned to be
-- removed once real cameras are connected, to keep the project's promise that no person can supply
-- evidence. To remove it: drop these two tables, delete apps/api/src/services/testfootage.js, the
-- /test-runs and /test-frames routes, apps/web/src/pages/engineer/TestFootage.jsx and its tab, and
-- services/inference/footage.py with its /v1/test endpoints (docs/temporary-features.md lists all).

CREATE TABLE test_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  filename     text NOT NULL,
  size_bytes   bigint NOT NULL,
  status       text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  error        text,
  job_id       text,                          -- id of the job in the inference service
  params       jsonb NOT NULL,                -- prompts, interval, confidence, frame cap (and the effective interval)
  video        jsonb NOT NULL DEFAULT '{}',   -- fps, frames, duration, size as read from the file
  progress     jsonb NOT NULL DEFAULT '{}',
  summary      jsonb NOT NULL DEFAULT '{}',   -- per-label detection and confirmation counts, notes
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX idx_test_runs_project ON test_runs (project_id, created_at DESC);

CREATE TABLE test_frames (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  i            integer NOT NULL,              -- order of the sampled frame
  t_s          numeric(10,2) NOT NULL,        -- position in the footage, seconds
  sharpness    numeric(12,1),
  reused       boolean NOT NULL DEFAULT false,-- true: model not re-run, detections carried over from the previous analysed frame
  ms           integer NOT NULL DEFAULT 0,    -- model time for this frame
  detections   jsonb NOT NULL DEFAULT '[]',   -- [{label, conf, bbox, confirmed}]
  storage_key  text NOT NULL,                 -- annotated JPEG under storage/testing/
  UNIQUE (run_id, i)
);
