// Input for the model-based completion forecast (inference service /v1/schedule/forecast, docs/handoff-schedule-assistant.md part A).
//
// The earned-value forecast in evm.js stays the headline number. This module only reshapes what evaluate()
// already computed into the service's input: progress = EV / BAC per log date, the plan = PV / BAC per day.
// Time is calendar days since the project start, because the Python package works in calendar days.
// Pure functions: every number can be reproduced in a unit test.

import { diffDays } from './dates.js';

const PLAN_STEP_DAYS = 7;     // the plan curve is sent weekly (plus its last day): enough for interpolation
const MAX_OBSERVATIONS = 1500;

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {object} project            {start_date, planned_end_date}
 * @param {object} ev                 evaluate() result: {metrics: {bac, planned_percent}, series: {planned, actual}}
 * @param {string} asOf               status date YYYY-MM-DD
 * @param {object} [opts]
 * @param {number} [opts.paceFactor]  what-if: 1.2 = future pace 20 % faster
 * @param {number} [opts.floors]      number of floors, when known
 * @returns {object|null}             payload, or null when there is no budget to measure progress against
 */
export function schedulePayload(project, ev, asOf, { paceFactor = 1, floors = null } = {}) {
  const bac = ev.metrics.bac;
  if (!(bac > 0)) return null;
  const start = project.start_date;
  const pct = (v) => Math.min(100, Math.max(0, r3((v / bac) * 100)));
  const observations = ev.series.actual
    .filter((a) => diffDays(a.date, asOf) >= 0 && diffDays(start, a.date) >= 0)
    .map((a) => ({ day: diffDays(start, a.date), pct: pct(a.ev) }))
    .slice(-MAX_OBSERVATIONS);
  const planned = ev.series.planned;
  const planned_curve = planned
    .filter((p, i) => i % PLAN_STEP_DAYS === 0 || i === planned.length - 1)
    .map((p) => [diffDays(start, p.date), pct(p.pv)]);
  const payload = {
    start_date: start,
    as_of: asOf,
    observations,
    planned_duration_days: Math.max(1, diffDays(start, project.planned_end_date)),
    planned_pct_now: ev.metrics.planned_percent,
    planned_curve: planned_curve.length >= 2 ? planned_curve : null,
    pace_factor: paceFactor,
  };
  if (floors) payload.floors = floors;
  return payload;
}

/**
 * Chart data for the engineer panel: measured percent, planned percent, and the forecast extension from the
 * latest measurement to each method's completion date (with the range as a band).
 */
export function forecastChart(payload, model) {
  if (!payload || !model) return null;
  const last = payload.observations.at(-1) ?? { day: 0, pct: 0 };
  const extension = {};
  for (const key of ['baseline', 'ml', 'blend']) {
    const f = model[key];
    if (!f || f.status !== 'ok' || f.remaining_days == null) continue;
    const now = diffDays(payload.start_date, payload.as_of);
    extension[key] = { from: { day: last.day, pct: last.pct }, to_day: now + f.remaining_days,
      lower_day: now + f.lower_days, upper_day: now + f.upper_days };
  }
  return {
    start_date: payload.start_date,
    actual: payload.observations,
    planned: payload.planned_curve ?? [],
    curve: model.baseline?.details?.curve ?? null,   // logistic {k, t0} if fitted: p(t) = 100 / (1 + e^(-k (t - t0)))
    extension,
  };
}
