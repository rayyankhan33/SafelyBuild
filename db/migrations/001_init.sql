-- SafelyBuild schema, migration 001 (Sprint 1).
-- PostgreSQL 15+. Money is NUMERIC in PKR; lengths in metres; volumes in m3; mass in kg.
-- Every table is documented in docs/design.md (ERD). tests/schema.test.js checks that the
-- ERD and this file agree.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ------------------------------------------------------------------ enums
CREATE TYPE user_role        AS ENUM ('admin', 'engineer', 'investor');
CREATE TYPE project_status   AS ENUM ('planning', 'active', 'on_hold', 'completed');
CREATE TYPE element_type     AS ENUM ('footing', 'column', 'beam', 'slab', 'masonry_wall');
CREATE TYPE media_kind       AS ENUM ('image', 'video');
CREATE TYPE inference_kind   AS ENUM ('defects', 'activity', 'materials');
CREATE TYPE inference_status AS ENUM ('pending', 'succeeded', 'failed');
CREATE TYPE severity_level   AS ENUM ('Low', 'Medium', 'High', 'Critical');
CREATE TYPE entry_source     AS ENUM ('manual', 'ai_proposed', 'ai_confirmed', 'ai_simulated');
CREATE TYPE traffic_light    AS ENUM ('low', 'moderate', 'high', 'critical');
CREATE TYPE hazard_source    AS ENUM ('auto_defect', 'manual');
CREATE TYPE hazard_status    AS ENUM ('open', 'mitigating', 'closed');
CREATE TYPE control_kind     AS ENUM ('preventive', 'mitigating');
CREATE TYPE alert_kind       AS ENUM ('budget', 'schedule', 'risk', 'defect', 'system');
CREATE TYPE alert_level      AS ENUM ('info', 'warning', 'critical');

-- ------------------------------------------------------------------ tenancy & users
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  role           user_role NOT NULL,
  pec_number     text,                       -- optional engineer registration number
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_lowercase CHECK (email = lower(email))
);

CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  location         text,
  description      text,
  status           project_status NOT NULL DEFAULT 'planning',
  start_date       date NOT NULL,
  planned_end_date date,                     -- set when the schedule is generated
  budget_pkr       numeric(16,2),            -- set when an estimate is activated
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

-- ------------------------------------------------------------------ standards & reference data
CREATE TABLE standards_refs (
  id      serial PRIMARY KEY,
  code    text NOT NULL UNIQUE,              -- e.g. 'ACI 211.1'
  title   text NOT NULL,
  body    text NOT NULL,                     -- issuing body
  used_for text NOT NULL                     -- what this project uses it for
);

CREATE TABLE material_catalog (
  id      serial PRIMARY KEY,
  code    text NOT NULL UNIQUE,              -- CEMENT, SAND, AGGREGATE, REBAR, BRICK
  name    text NOT NULL,
  unit    text NOT NULL                      -- bag (50 kg), m3, kg, nos
);

-- Estimation constants (wastage, bulking, ...). One row per key, each tied to its origin.
CREATE TABLE estimation_factors (
  key           text PRIMARY KEY,
  value         numeric NOT NULL,
  unit          text,
  description   text NOT NULL,
  standard_id   integer REFERENCES standards_refs(id),   -- NULL => typical industry allowance
  is_code_value boolean NOT NULL DEFAULT false           -- false => editable allowance, not mandated
);

CREATE TABLE productivity_rates (
  element_type  element_type PRIMARY KEY,
  unit          text NOT NULL,                -- m3 or m2 per crew-day
  output_per_day numeric NOT NULL CHECK (output_per_day > 0),
  min_duration_days integer NOT NULL DEFAULT 1,
  sequence_no   integer NOT NULL UNIQUE      -- typical build order
);

CREATE TABLE project_material_rates (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  material_id   integer NOT NULL REFERENCES material_catalog(id),
  rate_pkr      numeric(12,2) NOT NULL CHECK (rate_pkr >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, material_id)
);

-- ------------------------------------------------------------------ design (BOQ) & estimate
CREATE TABLE design_elements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label          text NOT NULL,
  element_type   element_type NOT NULL,
  quantity       integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  length_m       numeric(8,3) NOT NULL CHECK (length_m > 0),
  width_m        numeric(8,3) CHECK (width_m > 0),
  height_m       numeric(8,3) CHECK (height_m > 0),   -- depth for footings/beams
  thickness_m    numeric(8,3) CHECK (thickness_m > 0),
  concrete_fc_mpa integer CHECK (concrete_fc_mpa BETWEEN 15 AND 60),  -- NULL for masonry
  rebar_kg_per_m3 numeric(7,2) CHECK (rebar_kg_per_m3 >= 0),          -- NULL => default by type
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cost_estimates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  total_pkr         numeric(16,2) NOT NULL,
  contingency_pct   numeric(5,2) NOT NULL DEFAULT 0,
  factors_snapshot  jsonb NOT NULL,           -- factors + rates used, for reproducibility
  warnings          jsonb NOT NULL DEFAULT '[]',   -- e.g. ACI 318 minimum-steel notes
  is_active         boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE estimate_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id  uuid NOT NULL REFERENCES cost_estimates(id) ON DELETE CASCADE,
  element_id   uuid REFERENCES design_elements(id) ON DELETE SET NULL,
  material_id  integer NOT NULL REFERENCES material_catalog(id),
  quantity     numeric(14,3) NOT NULL,
  unit         text NOT NULL,
  rate_pkr     numeric(12,2) NOT NULL,
  cost_pkr     numeric(16,2) NOT NULL
);

-- ------------------------------------------------------------------ schedule
CREATE TABLE schedule_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  element_id     uuid REFERENCES design_elements(id) ON DELETE SET NULL,
  name           text NOT NULL,
  seq            integer NOT NULL,
  planned_start  date NOT NULL,
  planned_end    date NOT NULL,
  planned_cost_pkr numeric(16,2) NOT NULL DEFAULT 0,   -- budget at completion for this task
  CHECK (planned_end >= planned_start)
);

CREATE TABLE task_dependencies (
  task_id        uuid NOT NULL REFERENCES schedule_tasks(id) ON DELETE CASCADE,
  depends_on_id  uuid NOT NULL REFERENCES schedule_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

-- ------------------------------------------------------------------ daily logs & evidence
CREATE TABLE daily_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  log_date       date NOT NULL,
  author_id      uuid NOT NULL REFERENCES users(id),
  workers_present integer CHECK (workers_present >= 0),
  weather        text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, log_date)
);

CREATE TABLE task_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_log_id    uuid NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES schedule_tasks(id) ON DELETE CASCADE,
  percent_complete numeric(5,2) NOT NULL CHECK (percent_complete BETWEEN 0 AND 100),  -- cumulative
  UNIQUE (daily_log_id, task_id)
);

CREATE TABLE material_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_log_id  uuid NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  material_id   integer NOT NULL REFERENCES material_catalog(id),
  quantity      numeric(14,3) NOT NULL CHECK (quantity >= 0),
  rate_pkr      numeric(12,2) NOT NULL,         -- rate snapshot at entry time
  cost_pkr      numeric(16,2) NOT NULL,
  source        entry_source NOT NULL DEFAULT 'manual',
  confidence    numeric(4,3),
  media_id      uuid,                           -- evidence photo (FK added below)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  daily_log_id  uuid REFERENCES daily_logs(id) ON DELETE SET NULL,
  kind          media_kind NOT NULL DEFAULT 'image',
  tag           text NOT NULL DEFAULT 'general' CHECK (tag IN ('general', 'overview', 'material')),
  storage_key  text NOT NULL UNIQUE,           -- path/key in object storage
  sha256        text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  captured_at   timestamptz,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE material_usage
  ADD CONSTRAINT material_usage_media_fk FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL;

CREATE TABLE inference_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id       uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind           inference_kind NOT NULL,
  backend        text,
  status         inference_status NOT NULL DEFAULT 'pending',
  result         jsonb,                          -- raw service response
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE defects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inference_run_id uuid NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
  media_id        uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  defect_type     text NOT NULL CHECK (defect_type IN ('rusted_rebar', 'honeycombed_concrete')),
  score           numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  severity        severity_level NOT NULL,
  is_violation    boolean NOT NULL,
  confidence      numeric(5,4),
  bbox            integer[] NOT NULL CHECK (array_length(bbox, 1) = 4),
  detected_on     date NOT NULL
);

-- ------------------------------------------------------------------ risk
CREATE TABLE hazard_library (
  id                   serial PRIMARY KEY,
  code                 text NOT NULL UNIQUE,
  category             text NOT NULL,
  title                text NOT NULL,
  description          text NOT NULL,
  causes               jsonb NOT NULL,           -- bow-tie left side
  consequences         jsonb NOT NULL,           -- bow-tie right side
  preventive_controls  jsonb NOT NULL,           -- barriers before the top event
  mitigating_controls  jsonb NOT NULL,           -- barriers after the top event
  default_likelihood   integer NOT NULL CHECK (default_likelihood BETWEEN 1 AND 5),
  default_severity     integer NOT NULL CHECK (default_severity BETWEEN 1 AND 5),
  standard_id          integer REFERENCES standards_refs(id)
);

CREATE TABLE hazards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  library_id    integer REFERENCES hazard_library(id),
  defect_id     uuid REFERENCES defects(id) ON DELETE SET NULL,
  source        hazard_source NOT NULL,
  category      text NOT NULL,
  title         text NOT NULL,
  notes         text,
  likelihood    integer NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  severity      integer NOT NULL CHECK (severity BETWEEN 1 AND 5),
  risk_rating   integer GENERATED ALWAYS AS (likelihood * severity) STORED,
  status        hazard_status NOT NULL DEFAULT 'open',
  identified_on date NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE risk_scores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  score_date      date NOT NULL,
  sdi             numeric(3,1) NOT NULL CHECK (sdi BETWEEN 0 AND 10),   -- Structural Danger Index
  severity_part   numeric(4,3) NOT NULL,
  density_part    numeric(4,3) NOT NULL,
  progression_part numeric(4,3) NOT NULL,
  weights         jsonb NOT NULL,
  status          traffic_light NOT NULL,
  explanation     text NOT NULL,
  UNIQUE (project_id, score_date)
);

-- ------------------------------------------------------------------ forecasts & alerts
CREATE TABLE forecasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  as_of         date NOT NULL,
  budget        jsonb NOT NULL,                  -- AC, EV, CPI, EAC, overrun, status, ...
  schedule      jsonb NOT NULL,                  -- PV, EV, SPI, forecast finish, days late, ...
  UNIQUE (project_id, as_of)
);

CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            alert_kind NOT NULL,
  level           alert_level NOT NULL,
  dedupe_key      text NOT NULL,                 -- one open alert per key
  technical_msg   text NOT NULL,                 -- engineer wording
  plain_msg       text NOT NULL,                 -- investor wording
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz
);
CREATE UNIQUE INDEX alerts_one_open_per_key ON alerts (project_id, dedupe_key) WHERE resolved_at IS NULL;

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ indexes
CREATE INDEX idx_members_user       ON project_members (user_id);
CREATE INDEX idx_elements_project   ON design_elements (project_id);
CREATE INDEX idx_tasks_project      ON schedule_tasks (project_id, seq);
CREATE INDEX idx_logs_project_date  ON daily_logs (project_id, log_date);
CREATE INDEX idx_usage_log          ON material_usage (daily_log_id);
CREATE INDEX idx_media_project      ON media (project_id, created_at);
CREATE INDEX idx_defects_project    ON defects (project_id, detected_on);
CREATE INDEX idx_hazards_project    ON hazards (project_id, status);
CREATE INDEX idx_alerts_project     ON alerts (project_id, created_at DESC);
CREATE INDEX idx_audit_project      ON audit_log (project_id, created_at DESC);
