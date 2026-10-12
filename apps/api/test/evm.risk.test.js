import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, plannedFraction } from '../src/domain/evm.js';
import { riskRating, alarpZone, computeSdi, overallSafety, hazardFromDefect, matrixCounts, ratingLevel } from '../src/domain/risk.js';
import { desiredAlerts, diffAlerts } from '../src/domain/alerts.js';
import { pkr, budgetText, scheduleText } from '../src/domain/narrative.js';

// One task: Mon 2026-10-05 .. Thu 2026-10-15 = 10 working days (Mon-Sat), budget PKR 1,000,000
const TASK = { id: 't1', planned_start: '2026-10-05', planned_end: '2026-10-15', planned_cost_pkr: 1_000_000 };
const base = { tasks: [TASK], projectStart: '2026-10-05', plannedEnd: '2026-10-15' };
const prog = (date, percent) => ({ date, task_id: 't1', percent });
const spend = (date, cost_pkr) => ({ date, cost_pkr });

// ---- earned value (TC-EVM-*)
test('planned fraction is linear over working days', () => {
  assert.equal(plannedFraction(TASK, '2026-10-04'), 0);
  assert.equal(plannedFraction(TASK, '2026-10-09'), 0.5); // 5 of 10 working days
  assert.equal(plannedFraction(TASK, '2026-10-20'), 1);
});
test('behind schedule and over budget is detected with the right numbers', () => {
  const r = evaluate({ ...base, asOf: '2026-10-09',
    progress: [prog('2026-10-07', 20), prog('2026-10-08', 30), prog('2026-10-09', 40)],
    spend: [spend('2026-10-07', 200_000), spend('2026-10-08', 100_000), spend('2026-10-09', 180_000)] });
  const m = r.metrics;
  assert.equal(m.pv, 500_000); assert.equal(m.ev, 400_000); assert.equal(m.ac, 480_000);
  assert.equal(m.budget.cpi, 0.833);
  assert.equal(m.budget.eac, 1_200_000);
  assert.equal(m.budget.overrun, 200_000);
  assert.equal(m.budget.status, 'over_budget');
  assert.equal(m.schedule.spi, 0.8);
  assert.equal(m.schedule.forecast_working_days, 13);
  assert.equal(m.schedule.forecast_end, '2026-10-19');
  assert.equal(m.schedule.days_late, 4);
  assert.equal(m.schedule.status, 'behind');
  assert.equal(m.percent_complete, 40);
});
test('on-plan project is on track', () => {
  const r = evaluate({ ...base, asOf: '2026-10-09',
    progress: [prog('2026-10-07', 30), prog('2026-10-08', 40), prog('2026-10-09', 50)],
    spend: [spend('2026-10-07', 150_000), spend('2026-10-08', 150_000), spend('2026-10-09', 200_000)] });
  assert.equal(r.metrics.budget.status, 'on_track');
  assert.equal(r.metrics.schedule.status, 'on_track');
  assert.equal(r.metrics.schedule.days_late, 0);
});
test('ahead of schedule is reported', () => {
  const r = evaluate({ ...base, asOf: '2026-10-09',
    progress: [prog('2026-10-07', 40), prog('2026-10-08', 55), prog('2026-10-09', 70)],
    spend: [spend('2026-10-07', 300_000), spend('2026-10-08', 150_000), spend('2026-10-09', 250_000)] });
  assert.equal(r.metrics.schedule.status, 'ahead');
  assert.ok(r.metrics.schedule.days_late < 0);
});
test('fewer than 3 log days gives no forecast', () => {
  const r = evaluate({ ...base, asOf: '2026-10-07', progress: [prog('2026-10-06', 10), prog('2026-10-07', 20)],
    spend: [spend('2026-10-06', 50_000), spend('2026-10-07', 50_000)] });
  assert.equal(r.metrics.budget.status, 'insufficient_data');
  assert.equal(r.metrics.schedule.status, 'insufficient_data');
  assert.equal(r.metrics.budget.needed_days, 1);
});
test('no measurable progress after three days is "behind" without a made-up date', () => {
  const r = evaluate({ ...base, asOf: '2026-10-09',
    progress: [prog('2026-10-07', 0), prog('2026-10-08', 0), prog('2026-10-09', 0)],
    spend: [spend('2026-10-07', 50_000), spend('2026-10-08', 50_000), spend('2026-10-09', 50_000)] });
  assert.equal(r.metrics.schedule.status, 'behind');
  assert.equal(r.metrics.schedule.forecast_end, null);
  assert.equal(r.metrics.budget.status, 'insufficient_data');
});
test('status date before project start', () => {
  const r = evaluate({ ...base, asOf: '2026-10-01', progress: [], spend: [] });
  assert.equal(r.metrics.schedule.status, 'not_started');
  assert.equal(r.series.actual.length, 0);
  assert.equal(r.series.planned.length, 11); // plan curve is still drawn for the whole planned period
});
test('completed project reports final cost vs budget', () => {
  const r = evaluate({ ...base, asOf: '2026-10-16',
    progress: [prog('2026-10-12', 60), prog('2026-10-14', 90), prog('2026-10-16', 100)],
    spend: [spend('2026-10-12', 650_000), spend('2026-10-14', 300_000), spend('2026-10-16', 200_000)] });
  assert.equal(r.metrics.budget.completed, true);
  assert.equal(r.metrics.budget.eac, 1_150_000);
  assert.equal(r.metrics.budget.status, 'over_budget');
  assert.equal(r.metrics.schedule.status, 'completed_late');
  assert.equal(r.metrics.schedule.forecast_end, '2026-10-16');
});
test('zero-budget project is handled', () => {
  const r = evaluate({ tasks: [{ ...TASK, planned_cost_pkr: 0 }], projectStart: '2026-10-05', plannedEnd: '2026-10-15', asOf: '2026-10-09', progress: [], spend: [] });
  assert.equal(r.metrics.budget.status, 'no_budget');
});
test('productivity compares earned to planned value per interval', () => {
  const r = evaluate({ ...base, asOf: '2026-10-09',
    progress: [prog('2026-10-06', 10), prog('2026-10-08', 30), prog('2026-10-09', 40)],
    spend: [spend('2026-10-06', 1), spend('2026-10-08', 1), spend('2026-10-09', 1)] });
  const a = r.series.actual;
  assert.equal(a.length, 3);
  // 10-08 -> 10-09: earned 10 % of budget, planned 10 % (one of ten working days) => 1.0
  assert.equal(a[2].productivity, 1);
});

// ---- risk (TC-RSK-*)
test('risk rating bounds and ALARP zones', () => {
  assert.equal(riskRating(3, 4), 12);
  assert.throws(() => riskRating(0, 3), RangeError);
  assert.throws(() => riskRating(2, 6), RangeError);
  assert.throws(() => riskRating(2.5, 3), RangeError);
  assert.deepEqual([4, 5, 14, 15].map(alarpZone), ['acceptable', 'alarp', 'alarp', 'intolerable']);
  assert.deepEqual([4, 5, 10, 15].map(ratingLevel), ['low', 'moderate', 'high', 'critical']);
});
test('auto hazard raises likelihood with defect severity but caps at 5', () => {
  const lib = { id: 1, category: 'Structural integrity', title: 'Honeycombed concrete', default_likelihood: 3, default_severity: 4 };
  assert.equal(hazardFromDefect(lib, { id: 'd', severity: 'Medium', score: 0.2 }).likelihood, 3);
  assert.equal(hazardFromDefect(lib, { id: 'd', severity: 'Critical', score: 0.8 }).likelihood, 5);
  assert.equal(hazardFromDefect({ ...lib, default_likelihood: 5 }, { id: 'd', severity: 'Critical', score: 0.8 }).likelihood, 5);
});
const A = (date, media_id) => ({ date, media_id });
const D = (detected_on, media_id, score, is_violation = true) => ({ detected_on, media_id, score, is_violation, severity: 'High' });

test('no inspection in window => no SDI', () => {
  assert.equal(computeSdi([], [], '2026-10-10'), null);
  assert.equal(computeSdi([], [A('2026-09-01', 'm')], '2026-10-10'), null);
});
test('clean inspections give SDI 0 / low', () => {
  const r = computeSdi([], [A('2026-10-10', 'm1')], '2026-10-10');
  assert.equal(r.sdi, 0); assert.equal(r.status, 'low');
});
test('severe defect in every image on first inspection day is critical and escalates', () => {
  const r = computeSdi([D('2026-10-10', 'm1', 0.7)], [A('2026-10-10', 'm1')], '2026-10-10');
  assert.equal(r.sdi, 10); assert.equal(r.status, 'critical'); assert.equal(r.escalate, true);
});
test('density counts images with violations over images analysed', () => {
  const r = computeSdi([D('2026-10-10', 'm1', 0.3)], [A('2026-10-10', 'm1'), A('2026-10-10', 'm2'), A('2026-10-10', 'm3'), A('2026-10-10', 'm4')], '2026-10-10');
  assert.equal(r.density_part, 0.25);
});
test('weights shift as inspection history grows', () => {
  const day = (n) => `2026-10-${String(n).padStart(2, '0')}`;
  const analysed = [1, 2, 3, 4, 5, 6].map((n) => A(day(n), `m${n}`));
  assert.deepEqual(computeSdi([], analysed.slice(0, 1), day(1)).weights, { severity: 0.6, density: 0.4, progression: 0 });
  assert.deepEqual(computeSdi([], analysed.slice(0, 3), day(3)).weights, { severity: 0.5, density: 0.3, progression: 0.2 });
  assert.deepEqual(computeSdi([], analysed, day(6)).weights, { severity: 0.4, density: 0.3, progression: 0.3 });
});
test('worsening versus the previous window raises the progression part', () => {
  const analysed = [A('2026-10-03', 'p1'), A('2026-10-10', 'c1')];
  const steady = computeSdi([D('2026-10-03', 'p1', 0.6), D('2026-10-10', 'c1', 0.6)], analysed, '2026-10-10');
  const worsening = computeSdi([D('2026-10-03', 'p1', 0.1, false), D('2026-10-10', 'c1', 0.6)], analysed, '2026-10-10');
  assert.ok(worsening.progression_part > steady.progression_part);
});
test('overall safety is the worse of SDI and hazards', () => {
  const sdi = { status: 'low', sdi: 1 };
  const hz = [{ status: 'open', likelihood: 4, severity: 5, risk_rating: 20 }];
  assert.equal(overallSafety(sdi, hz).status, 'critical');
  assert.equal(overallSafety(sdi, hz).intolerable, 1);
  assert.equal(overallSafety(null, []).status, 'no_data');
  assert.equal(overallSafety(sdi, [{ status: 'closed', likelihood: 5, severity: 5 }]).status, 'low');
});
test('matrix counts place hazards in [severity][likelihood] and ignore closed ones', () => {
  const g = matrixCounts([{ likelihood: 3, severity: 4, status: 'open' }, { likelihood: 3, severity: 4, status: 'closed' }]);
  assert.equal(g[3][2], 1);
});

// ---- alerts & wording (TC-ALR-*)
test('alerts: one per condition, resolved when the condition clears', () => {
  const state = { budget: { status: 'over_budget', eac: 1.2e6, bac: 1e6, overrun: 2e5, overrun_pct: 20, cpi: 0.83, eac_low: 1.1e6, eac_high: 1.3e6 },
    schedule: { status: 'on_track' }, safety: { status: 'low' }, sdi: null };
  const d1 = desiredAlerts(state);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].level, 'critical');
  const open = [{ id: 'a1', dedupe_key: 'budget:over_budget', technical_msg: d1[0].technical_msg, plain_msg: d1[0].plain_msg }, { id: 'a2', dedupe_key: 'schedule:behind' }];
  const diff = diffAlerts(d1, open);
  assert.deepEqual(diff.toCreate, []);
  assert.deepEqual(diff.toResolve, ['a2']);
  assert.deepEqual(diff.toUpdate, []); // wording unchanged
});
test('an open alert is refreshed when its wording changes (new numbers, different cameras)', () => {
  const d = [{ kind: 'system', level: 'warning', dedupe_key: 'evidence:cameras', technical_msg: 'No recent frames from: A, B.', plain_msg: 'p' }];
  const diff = diffAlerts(d, [{ id: 'x', dedupe_key: 'evidence:cameras', technical_msg: 'No recent frames from: A.', plain_msg: 'p' }]);
  assert.deepEqual(diff.toCreate, []);
  assert.deepEqual(diff.toUpdate, [{ id: 'x', technical_msg: 'No recent frames from: A, B.', plain_msg: 'p' }]);
});
test('investor wording has no jargon; engineer wording has indices', () => {
  const b = { status: 'over_budget', eac: 1.2e7, bac: 1e7, overrun: 2e6, overrun_pct: 20, cpi: 0.83, eac_low: 1.1e7, eac_high: 1.3e7 };
  const t = budgetText(b);
  assert.doesNotMatch(t.plain, /CPI|EAC|BAC/);
  assert.match(t.technical, /CPI 0.83/);
  assert.equal(pkr(25_000_000), 'PKR 2.50 crore');
  assert.equal(pkr(450_000), 'PKR 4.50 lakh');
  assert.match(scheduleText({ status: 'insufficient_data', needed_days: 2 }).plain, /2 more/);
});
