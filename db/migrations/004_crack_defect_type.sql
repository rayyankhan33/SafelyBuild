-- Sprint 1: the trained crack model (services/inference/plugins/crack_cnn.py) reports a third defect type.
-- Idempotent: safe to re-run. Hazards for this type come from the existing library entry STR-CRACK.
ALTER TABLE defects DROP CONSTRAINT IF EXISTS defects_defect_type_check;
ALTER TABLE defects ADD CONSTRAINT defects_defect_type_check
  CHECK (defect_type IN ('rusted_rebar', 'honeycombed_concrete', 'concrete_crack'));
