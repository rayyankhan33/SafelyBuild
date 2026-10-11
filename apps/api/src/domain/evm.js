// Earned-value based progress, cost and schedule forecasting (ANSI/EIA-748, PMBOK EVM).
//
//   PV  planned value  : budget of the work that *should* be done by the status date
//   EV  earned value   : budget of the work that *has* been done (sum of task budget x % complete)
//   AC  actual cost    : money spent on materials up to the status date (from daily material logs)
//   CPI = EV / AC      SPI = EV / PV
//   EAC = BAC / CPI    estimate at completion if cost performance so far continues
//   Forecast duration  = planned duration / SPI (working days)
//
// All functions are pure: they take plain data and return plain data, so every number on the
// dashboards can be reproduced from the database rows in a unit test.

import { addWorkingDays, diffDays, eachDay, workingDaysInclusive } from './dates.js';

export const THRESHOLDS = {
  MIN_LOG_DAYS: 3,          // fewer daily logs than this => "insufficient data", no forecast
  BUDGET_ON_TRACK_PCT: 2,   // projected overrun up to this % of budget is "on track"
  BUDGET_AT_RISK_PCT: 10,   // above this % it is "over budget"
  SCHEDULE_TOLERANCE_PCT: 3,// forecast lateness within 3 % of planned duration (min 1 day) is on track
  SCHEDULE_AT_RISK_PCT: 10, // lateness above 10 % of planned duration is "behind"
  TREND_WINDOW: 7,          // log entries used for the recent-trend cost forecast
  MAX_DURATION_FACTOR: 10,  // forecast duration is capped at 10x plan to stay meaningful
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

export function plannedFraction(task, asOf) {
  if (diffDays(task.planned_start, asOf) < 0) return 0;
  if (diffDays(task.planned_end, asOf) >= 0) return 1;
  const total = workingDaysInclusive(task.planned_start, task.planned_end);
  if (total === 0) return 1;
  return workingDaysInclusive(task.planned_start, asOf) / total;
}

/** progress: [{date, task_id, percent}] cumulative percent per task; returns latest <= asOf. */
function latestPercent(progressByTask, taskId, asOf) {
  const rows = progressByTask.get(taskId);
  if (!rows) return 0;
  let pct = 0;
  for (const r of rows) {
    if (diffDays(r.date, asOf) < 0) break;
    pct = r.percent;
  }
  return pct;
}

export function plannedValue(tasks, asOf) {
  return tasks.reduce((s, t) => s + Number(t.planned_cost_pkr) * plannedFraction(t, asOf), 0);
}

function groupProgress(progress) {
  const m = new Map();
  for (const p of [...progress].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!m.has(p.task_id)) m.set(p.task_id, []);
    m.get(p.task_id).push(p);
  }
  return m;
}

export function earnedValue(tasks, progressByTask, asOf) {
  return tasks.reduce((s, t) => s + Number(t.planned_cost_pkr) * (latestPercent(progressByTask, t.id, asOf) / 100), 0);
}

export function actualCost(spend, asOf) {
  return spend.reduce((s, x) => (diffDays(x.date, asOf) >= 0 ? s + Number(x.cost_pkr) : s), 0);
}

/**
 * @param {object} input
 * @param {object[]} input.tasks     {id, planned_start, planned_end, planned_cost_pkr}
 * @param {object[]} input.progress  {date, task_id, percent}
 * @param {object[]} input.spend     {date, cost_pkr}  one row per material entry
 * @param {string}   input.asOf      status date
 * @param {string}   input.projectStart
 * @param {string}   input.plannedEnd
 */
export function evaluate({ tasks, progress, spend, asOf, projectStart, plannedEnd }) {
  const bac = r2(tasks.reduce((s, t) => s + Number(t.planned_cost_pkr), 0));
  const progressByTask = groupProgress(progress);
  const logDates = [...new Set([...progress.map((p) => p.date), ...spend.map((s) => s.date)])]
    .filter((d) => diffDays(d, asOf) >= 0)
    .sort();

  // --- time series: one point per log date, plus the planned S-curve for every calendar day
  const actual = [];
  let prev = { pv: 0, ev: 0, ac: 0 };
  for (const d of logDates) {
    const pv = plannedValue(tasks, d);
    const ev = earnedValue(tasks, progressByTask, d);
    const ac = actualCost(spend, d);
    const dPv = pv - prev.pv;
    const dEv = ev - prev.ev;
    actual.push({
      date: d, pv: r2(pv), ev: r2(ev), ac: r2(ac),
      daily_spend: r2(ac - prev.ac), daily_ev: r2(dEv), daily_pv: r2(dPv),
      productivity: dPv > 0.5 ? r3(dEv / dPv) : null, // planned work existed in this period
      cpi: ac > 0 ? r3(ev / ac) : null,
    });
    prev = { pv, ev, ac };
  }
  const end = diffDays(plannedEnd, asOf) > 0 ? asOf : plannedEnd;
  const planned = diffDays(projectStart, end) >= 0
    ? eachDay(projectStart, end).map((d) => ({ date: d, pv: r2(plannedValue(tasks, d)) }))
    : [];

  const last = actual[actual.length - 1];
  const pv = plannedValue(tasks, asOf);
  const ev = last ? earnedValue(tasks, progressByTask, asOf) : 0;
  const ac = actualCost(spend, asOf);

  const base = {
    as_of: asOf, log_days: logDates.length, bac, pv: r2(pv), ev: r2(ev), ac: r2(ac),
    percent_complete: bac > 0 ? r2((ev / bac) * 100) : 0,
    planned_percent: bac > 0 ? r2((pv / bac) * 100) : 0,
    cost_variance: r2(ev - ac), // negative => spending more than the work is worth
    schedule_variance: r2(ev - pv),
  };

  return {
    metrics: {
      ...base,
      budget: forecastBudget(base, actual),
      schedule: forecastSchedule(base, actual, projectStart, plannedEnd, asOf),
      productivity: summariseProductivity(actual),
    },
    series: { planned, actual },
  };
}

// ---------------------------------------------------------------- budget forecast
export function forecastBudget(m, actual) {
  const out = { bac: m.bac, ac: m.ac, ev: m.ev };
  if (!(m.bac > 0)) return { ...out, status: 'no_budget' };
  if (m.ev >= m.bac * 0.9999) {
    const overrun = r2(m.ac - m.bac);
    return { ...out, status: statusFromOverrun(overrun, m.bac), cpi: m.ac > 0 ? r3(m.ev / m.ac) : null,
      eac: m.ac, eac_low: m.ac, eac_high: m.ac, overrun, overrun_pct: r2((overrun / m.bac) * 100), completed: true };
  }
  if (m.log_days < THRESHOLDS.MIN_LOG_DAYS || m.ev <= 0 || m.ac <= 0) {
    return { ...out, status: 'insufficient_data', needed_days: Math.max(0, THRESHOLDS.MIN_LOG_DAYS - m.log_days) };
  }
  const cpi = m.ev / m.ac;
  const eacCpi = m.bac / cpi; // = AC + (BAC - EV) / CPI

  // recent trend: marginal cost per unit of value over the last window of log entries
  let eacTrend = eacCpi;
  const win = actual.slice(-(THRESHOLDS.TREND_WINDOW + 1));
  if (win.length >= 2) {
    const dEv = win[win.length - 1].ev - win[0].ev;
    const dAc = win[win.length - 1].ac - win[0].ac;
    if (dEv > 0 && dAc >= 0) eacTrend = m.ac + (m.bac - m.ev) * (dAc / dEv);
  }
  const low = Math.min(eacCpi, eacTrend);
  const high = Math.max(eacCpi, eacTrend);
  const overrun = eacCpi - m.bac;
  return {
    ...out, cpi: r3(cpi), eac: r2(eacCpi), eac_trend: r2(eacTrend), eac_low: r2(low), eac_high: r2(high),
    overrun: r2(overrun), overrun_pct: r2((overrun / m.bac) * 100),
    overrun_high: r2(high - m.bac), status: statusFromOverrun(overrun, m.bac),
    method: 'EAC = BAC / CPI (cumulative); range uses recent-trend cost per unit of value',
  };
}

function statusFromOverrun(overrun, bac) {
  const pct = (overrun / bac) * 100;
  if (pct <= THRESHOLDS.BUDGET_ON_TRACK_PCT) return pct < -THRESHOLDS.BUDGET_ON_TRACK_PCT ? 'under_budget' : 'on_track';
  return pct <= THRESHOLDS.BUDGET_AT_RISK_PCT ? 'at_risk' : 'over_budget';
}

// ------------------------------------------------------------- schedule forecast
export function forecastSchedule(m, actual, projectStart, plannedEnd, asOf) {
  const plannedDays = workingDaysInclusive(projectStart, plannedEnd);
  const out = { planned_start: projectStart, planned_end: plannedEnd, planned_working_days: plannedDays };
  if (diffDays(projectStart, asOf) < 0) return { ...out, status: 'not_started' };
  if (m.bac > 0 && m.ev >= m.bac * 0.9999) {
    const done = actual.find((a) => a.ev >= m.bac * 0.9999);
    const finish = done ? done.date : asOf;
    const late = diffDays(plannedEnd, finish);
    return { ...out, status: late > 0 ? 'completed_late' : 'completed', completed: true, forecast_end: finish, days_late: late };
  }
  const spi = m.pv > 0 ? m.ev / m.pv : null;
  if (m.log_days < THRESHOLDS.MIN_LOG_DAYS || spi === null) {
    return { ...out, status: 'insufficient_data', needed_days: Math.max(0, THRESHOLDS.MIN_LOG_DAYS - m.log_days) };
  }
  if (m.ev <= 0) return { ...out, status: 'behind', spi: 0, forecast_end: null, reason: 'no measurable progress recorded yet' };

  const rawFd = Math.ceil(plannedDays / spi);
  const capped = rawFd > plannedDays * THRESHOLDS.MAX_DURATION_FACTOR;
  const fd = capped ? plannedDays * THRESHOLDS.MAX_DURATION_FACTOR : rawFd;
  const forecastEnd = addWorkingDays(projectStart, Math.max(0, fd - 1));
  const lateWd = fd - plannedDays;
  const tol = Math.max(1, (plannedDays * THRESHOLDS.SCHEDULE_TOLERANCE_PCT) / 100);
  let status;
  if (lateWd <= -tol) status = 'ahead';
  else if (lateWd <= tol) status = 'on_track';
  else if (lateWd <= (plannedDays * THRESHOLDS.SCHEDULE_AT_RISK_PCT) / 100) status = 'at_risk';
  else status = 'behind';
  return {
    ...out, status, spi: r3(spi), forecast_working_days: fd, forecast_end: forecastEnd,
    days_late: diffDays(plannedEnd, forecastEnd), working_days_late: lateWd, capped,
    method: 'forecast duration = planned duration / SPI (working days)',
  };
}

function summariseProductivity(actual) {
  const vals = actual.map((a) => a.productivity).filter((v) => v !== null).slice(-7);
  if (!vals.length) return { recent_avg: null, label: 'unknown', samples: 0 };
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  return { recent_avg: r3(avg), label: avg >= 0.95 ? 'good' : avg >= 0.75 ? 'fair' : 'low', samples: vals.length };
}
