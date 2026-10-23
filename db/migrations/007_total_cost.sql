-- Migration 007: total project cost (financial module, decisions D1 and D2).
--
-- Until now the budget and the spend covered materials only. The lead engineer now enters, ONCE at the
-- start of the project, the labour rate per crew-day, the hire rate of each kind of equipment (with the
-- planned number of units) and the site overhead percentage. After that they are LOCKED: the database
-- refuses updates, and the API has no route to change them. (Changing them later is the change-control
-- workflow, decision D3, which is not built yet.)
--
-- Planned cost per task is split so the dashboards can show where the baseline budget goes.

CREATE TABLE cost_rate_equipment (
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  equipment_type text NOT NULL CHECK (equipment_type = lower(btrim(equipment_type)) AND length(equipment_type) BETWEEN 1 AND 80),
  rate_pkr       numeric(12,2) NOT NULL CHECK (rate_pkr >= 0),       -- hire cost per unit per working day
  planned_units  integer NOT NULL CHECK (planned_units >= 0),
  PRIMARY KEY (project_id, equipment_type)
);

CREATE TABLE cost_rates (
  project_id     uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  crew_rate_pkr  numeric(12,2) NOT NULL CHECK (crew_rate_pkr >= 0),  -- labour cost per crew per working day
  overhead_pct   numeric(5,2) NOT NULL CHECK (overhead_pct BETWEEN 0 AND 100),
  set_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  set_at         timestamptz NOT NULL DEFAULT now()
);

-- Locking. cost_rates is the lock: once a project has its row, nothing about its rates can change.
CREATE FUNCTION cost_rates_are_locked() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cost rates are locked once set (change control is required to alter them)' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER cost_rates_no_update BEFORE UPDATE ON cost_rates
  FOR EACH ROW EXECUTE FUNCTION cost_rates_are_locked();
CREATE TRIGGER cost_rate_equipment_no_update BEFORE UPDATE ON cost_rate_equipment
  FOR EACH ROW EXECUTE FUNCTION cost_rates_are_locked();

CREATE FUNCTION equipment_rates_after_lock() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cost_rates WHERE project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'cost rates are locked once set (no new equipment rates)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER cost_rate_equipment_lock BEFORE INSERT ON cost_rate_equipment
  FOR EACH ROW EXECUTE FUNCTION equipment_rates_after_lock();

-- planned_cost_pkr stays the TOTAL task budget (what earned value uses); these are the parts of it.
ALTER TABLE schedule_tasks
  ADD COLUMN planned_labour_pkr    numeric(14,2) NOT NULL DEFAULT 0 CHECK (planned_labour_pkr >= 0),
  ADD COLUMN planned_equipment_pkr numeric(14,2) NOT NULL DEFAULT 0 CHECK (planned_equipment_pkr >= 0),
  ADD COLUMN planned_overhead_pkr  numeric(14,2) NOT NULL DEFAULT 0 CHECK (planned_overhead_pkr >= 0);
