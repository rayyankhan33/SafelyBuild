-- Migration 009: model-based completion forecast beside the earned-value one.
--
--  * forecasts.schedule_model   the answer of the inference service's /v1/schedule/forecast for that day:
--                               {baseline, ml, blend, model_version, generated_at}. NULL when the service was
--                               unreachable or the forecast has not been computed; the earned-value forecast in
--                               forecasts.schedule never depends on it.
--
-- Nullable with no default, so existing rows are untouched.

ALTER TABLE forecasts ADD COLUMN schedule_model jsonb;
