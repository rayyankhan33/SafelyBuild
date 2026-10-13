-- Migration 003: evidence comes from cameras, not from people.
--
-- Design rule (see docs/design.md section 10): engineers enter only the initial BOQ/budget, the crews
-- on site and the equipment available. Progress, material use, spend, defects and hazards are
-- derived from camera frames by the system. No endpoint lets a user create, edit or close them.
--
-- Existing engineer-typed rows from Sprint 1 are kept but marked 'legacy_manual' so they can be told
-- apart from image-derived data. Manual hazards are removed.

-- ------------------------------------------------------------------ price book (replaces per-project rates)
CREATE TABLE price_book (
  material_id    integer PRIMARY KEY REFERENCES material_catalog(id),
  rate_pkr       numeric(12,2) NOT NULL CHECK (rate_pkr >= 0),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Indicative demo rates (PKR). SAND/AGGREGATE are per m3 (about 85 and 120 PKR per cubic foot).
INSERT INTO price_book (material_id, rate_pkr)
SELECT id, CASE code WHEN 'CEMENT' THEN 1400 WHEN 'SAND' THEN 3002 WHEN 'AGGREGATE' THEN 4238 WHEN 'REBAR' THEN 270 WHEN 'BRICK' THEN 28 END
FROM material_catalog;
DROP TABLE project_material_rates;

-- ------------------------------------------------------------------ cameras and frames
ALTER TABLE projects ADD COLUMN is_demo boolean NOT NULL DEFAULT false;  -- demo data uses synthetic frames

CREATE TABLE cameras (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  kind                     text NOT NULL CHECK (kind IN ('zone', 'yard', 'overview')),
  element_id               uuid REFERENCES design_elements(id) ON DELETE SET NULL,  -- zone cameras watch one element
  scale_m_per_px           numeric(8,5) CHECK (scale_m_per_px > 0),                  -- yard cameras: calibrated ground scale
  key_hash                 text NOT NULL,                                            -- SHA-256 of the camera secret
  expected_frames_per_day  integer NOT NULL DEFAULT 1 CHECK (expected_frames_per_day >= 1),
  detect_defects           boolean NOT NULL DEFAULT true,   -- run the defect check on this camera's frames (admin setting)
  active                   boolean NOT NULL DEFAULT true,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_frame_at            timestamptz,
  CONSTRAINT zone_needs_element CHECK (kind <> 'zone' OR element_id IS NOT NULL),
  CONSTRAINT yard_needs_scale   CHECK (kind <> 'yard' OR scale_m_per_px IS NOT NULL)
);
CREATE INDEX idx_cameras_project ON cameras (project_id);

ALTER TABLE media ADD COLUMN camera_id uuid REFERENCES cameras(id);
ALTER TABLE media ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE media ALTER COLUMN uploaded_by DROP NOT NULL;
-- replay protection: the same bytes cannot be submitted twice by one camera
CREATE UNIQUE INDEX media_camera_sha ON media (camera_id, sha256) WHERE camera_id IS NOT NULL;
CREATE INDEX idx_media_camera ON media (camera_id, captured_at);

-- every analysis records which model produced it (name@version) and the model's own metadata
-- (weights hash, training-set note, reliability), so any dashboard number can be traced to a model
ALTER TABLE inference_runs ADD COLUMN model_version text;
ALTER TABLE inference_runs ADD COLUMN model_info jsonb;

ALTER TYPE inference_kind ADD VALUE IF NOT EXISTS 'stage';
ALTER TYPE inference_kind ADD VALUE IF NOT EXISTS 'inventory';

-- ------------------------------------------------------------------ what engineers may still enter
ALTER TABLE daily_logs ALTER COLUMN author_id DROP NOT NULL;   -- logs are now created by the system
ALTER TABLE daily_logs DROP COLUMN workers_present, DROP COLUMN weather, DROP COLUMN notes;
ALTER TABLE daily_logs ADD COLUMN crews integer CHECK (crews >= 0);          -- input: crews on site
ALTER TABLE daily_logs ADD COLUMN equipment jsonb NOT NULL DEFAULT '[]';     -- input: [{"type": "...", "count": n}]
ALTER TABLE daily_logs ADD COLUMN site_status_by uuid REFERENCES users(id);
ALTER TABLE daily_logs ADD COLUMN site_status_at timestamptz;

-- ------------------------------------------------------------------ image-derived observations
CREATE TABLE stage_observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inference_run_id uuid NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
  camera_id        uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  element_id       uuid NOT NULL REFERENCES design_elements(id) ON DELETE CASCADE,
  observed_on      date NOT NULL,
  stage            integer NOT NULL CHECK (stage >= 0),
  fraction         numeric(5,4) CHECK (fraction BETWEEN 0 AND 1),   -- continuous measures (masonry coverage)
  backend          text NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_stage_obs ON stage_observations (element_id, observed_on);

CREATE TABLE inventory_observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inference_run_id uuid NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
  camera_id        uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  observed_on      date NOT NULL,
  material_id      integer NOT NULL REFERENCES material_catalog(id),
  quantity         numeric(14,3) NOT NULL CHECK (quantity >= 0),
  unit             text NOT NULL,
  method           text NOT NULL,
  confidence       numeric(4,3)
);
CREATE INDEX idx_inv_obs ON inventory_observations (observed_on, material_id);

-- one row per project, material and day: stock seen in the yard, and the change since the previous day
CREATE TABLE inventory_daily (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  observed_on   date NOT NULL,
  material_id   integer NOT NULL REFERENCES material_catalog(id),
  start_qty     numeric(14,3) NOT NULL,                 -- stock in the day's first yard frame
  stock_qty     numeric(14,3) NOT NULL,                 -- stock in the day's last yard frame
  used_qty      numeric(14,3) NOT NULL DEFAULT 0,       -- start - end of the same day (beyond the noise deadband)
  delivered_qty numeric(14,3) NOT NULL DEFAULT 0,       -- today's start - yesterday's end
  PRIMARY KEY (project_id, observed_on, material_id)
);

-- material spend and task progress are now derived; engineer-typed history is flagged
ALTER TABLE material_usage ALTER COLUMN source DROP DEFAULT;
ALTER TABLE material_usage ALTER COLUMN source TYPE text USING (CASE WHEN source::text = 'manual' THEN 'legacy_manual' ELSE source::text END);
ALTER TABLE material_usage ALTER COLUMN source SET DEFAULT 'image_estimate';
ALTER TABLE material_usage ADD CONSTRAINT material_usage_source_chk CHECK (source IN ('image_estimate', 'legacy_manual', 'ai_confirmed', 'ai_simulated', 'ai_proposed'));
DROP TYPE entry_source;

ALTER TABLE task_progress ADD COLUMN source text NOT NULL DEFAULT 'legacy_manual' CHECK (source IN ('image_stage', 'legacy_manual'));
ALTER TABLE task_progress ALTER COLUMN source SET DEFAULT 'image_stage';

-- ------------------------------------------------------------------ hazards: automatic only
DELETE FROM hazards WHERE source = 'manual';
ALTER TABLE hazards ADD CONSTRAINT hazards_auto_only CHECK (source = 'auto_defect');
ALTER TABLE hazards ADD COLUMN camera_id uuid REFERENCES cameras(id);
ALTER TABLE hazards ADD COLUMN clean_days integer NOT NULL DEFAULT 0;    -- consecutive clean inspection days
ALTER TABLE hazards ADD COLUMN last_clean_on date;
ALTER TABLE hazards ADD COLUMN closed_on date;
-- a hazard can only be closed by the system after evidence of cleanliness
ALTER TABLE hazards ADD CONSTRAINT hazards_closed_has_date CHECK (status <> 'closed' OR closed_on IS NOT NULL) NOT VALID;
