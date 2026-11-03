-- Migration 008: robustness of the evidence stream (sprint 2).
--
--  * inventory_daily.note   a large one-day stock drop that was NOT costed (pending the next day's frames, or rejected
--                           because the next day showed the stack was only missed by the model)
--  * camera_health_checks   one row per frame: image-quality measurements and tamper flags (lens covered, out of focus,
--                           redirected). Evidence, written by the ingest pipeline only.
--  * projects.planned_crews the number of crews the baseline schedule was generated with, so the baseline can be
--                           regenerated consistently (for example when the cost rates are set)

ALTER TABLE inventory_daily ADD COLUMN note text CHECK (note IN ('pending_confirmation', 'rejected_drop'));

CREATE TABLE camera_health_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id   uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  metrics     jsonb NOT NULL DEFAULT '{}',
  flags       text[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY['covered', 'blurred', 'redirected']::text[])
);
CREATE INDEX idx_health_checks_camera ON camera_health_checks (camera_id, checked_at DESC);

ALTER TABLE projects ADD COLUMN planned_crews integer CHECK (planned_crews BETWEEN 1 AND 20);

-- Tamper screening can be switched off for a camera whose view is not one continuous scene (for example the demo's
-- stand-in inspection camera). On a real site it stays on.
ALTER TABLE cameras ADD COLUMN check_tamper boolean NOT NULL DEFAULT true;
