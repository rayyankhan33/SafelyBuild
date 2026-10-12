// Unit tests for the evidence-driven domain logic: stages, stock, derived hazards, camera health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_PLAN, confirmedValue, percentForStage, percentOnDate, progressHistory, stageAtProgress, stageLabel } from '../src/domain/stages.js';
import { dailyStock, inventoryHistory } from '../src/domain/inventory.js';
import { CLEAN_DAYS_TO_CLOSE, deriveHazards } from '../src/domain/risk.js';
import { cameraHealth, evidenceSummary, uncoveredTasks } from '../src/domain/evidence.js';
import { desiredAlerts } from '../src/domain/alerts.js';

// ------------------------------------------------------------------ stages (TC-STG)
test('middle stages report the midpoint of their range; stage 0 is 0 %', () => {
  assert.equal(percentForStage('slab', 0), 0);
  assert.equal(percentForStage('slab', 1), 30); // [15, 45)
  assert.equal(percentForStage('slab', 2), 57.5); // [45, 70)
  assert.equal(percentForStage('footing', 2), 47.5);
});
test('the last stage is continuous: pour coverage maps from the pour-start bound to 100 %', () => {
  assert.equal(percentForStage('slab', 3), 100); // no coverage given: fully covered
  assert.equal(percentForStage('slab', 3, 0), 70);
  assert.equal(percentForStage('slab', 3, 0.5), 85);
  assert.equal(percentForStage('slab', 3, 1), 100);
  assert.equal(percentForStage('slab', 3, 7), 100); // clamped
  assert.equal(percentForStage('footing', 4, 0.4), 85); // 75 + 0.4 * 25
});
test('invalid stages and element types are rejected', () => {
  assert.throws(() => percentForStage('slab', 4), RangeError);
  assert.throws(() => percentForStage('slab', -1), RangeError);
  assert.throws(() => percentForStage('slab', 1.5), RangeError);
  assert.throws(() => percentForStage('bridge', 1), RangeError);
  assert.throws(() => percentForStage('masonry_wall', 1), /fraction/);
});
test('stageAtProgress inverts the bounds, with a tolerance at completion', () => {
  assert.equal(stageAtProgress('slab', 0), 0);
  assert.equal(stageAtProgress('slab', 14.9), 0);
  assert.equal(stageAtProgress('slab', 15), 1);
  assert.equal(stageAtProgress('slab', 69.95), 3);
  assert.equal(stageAtProgress('slab', 99.95), 3);
  assert.equal(stageLabel('slab', 2), 'rebar mesh');
  assert.equal(stageLabel('slab', 0), 'not started');
});
test('reporting is unbiased and accurate: truth swept 1..99 % gives a tiny mean error and a bounded worst case', () => {
  for (const type of ['footing', 'column', 'beam', 'slab']) {
    const { bounds } = STAGE_PLAN[type];
    const last = bounds.length - 1;
    let sum = 0; let worst = 0; let n = 0;
    for (let pct = 1; pct <= 99; pct += 1) {
      const stage = stageAtProgress(type, pct);
      const coverage = stage === last ? (pct - bounds[last]) / (100 - bounds[last]) : 1; // what a camera would see
      const err = percentForStage(type, stage, coverage) - pct;
      sum += err; worst = Math.max(worst, Math.abs(err)); n += 1;
    }
    assert.ok(Math.abs(sum / n) < 6, `${type} mean error ${sum / n}`);
    assert.ok(worst <= 25, `${type} worst error ${worst}`);
  }
});
const obs = (day, stage) => ({ observed_on: day, stage });
test('one noisy frame cannot move progress; two agreeing frames can', () => {
  assert.equal(percentOnDate('slab', [obs('2026-10-05', 3)], '2026-10-05'), 0);
  assert.equal(percentOnDate('slab', [obs('2026-10-05', 3), obs('2026-10-05', 3)], '2026-10-05'), 100);
});
test('pour progress uses the coverage that at least two concrete frames agree on', () => {
  const o = (f) => ({ observed_on: '2026-10-05', stage: 3, fraction: f });
  assert.equal(percentOnDate('slab', [o(0.4), o(0.5)], '2026-10-05'), 82);          // second-highest of (0.5, 0.4) = 0.4 -> 70 + 0.4 * 30
  assert.equal(percentOnDate('slab', [o(0.9), o(0.5), o(0.5)], '2026-10-05'), 85); // the 0.9 outlier is ignored
});
test('a stage needs two frames at or above it: one high frame among low ones is ignored', () => {
  const o = [obs('2026-10-05', 1), obs('2026-10-05', 1), obs('2026-10-05', 2)];
  assert.equal(percentOnDate('slab', o, '2026-10-05'), 30);
});
test('frames older than the window do not count', () => {
  const o = [obs('2026-10-01', 2), obs('2026-10-01', 2)];
  assert.equal(percentOnDate('slab', o, '2026-10-02'), 57.5);
  assert.equal(percentOnDate('slab', o, '2026-10-09'), 0);
});
test('progress never decreases, even if later frames look earlier', () => {
  const o = [obs('2026-10-05', 2), obs('2026-10-05', 2), obs('2026-10-09', 0), obs('2026-10-09', 0)];
  const h = progressHistory('slab', o);
  assert.deepEqual(h.map((x) => x.percent), [57.5, 57.5]);
});
test('masonry progress is a measured fraction', () => {
  const o = [{ observed_on: '2026-10-05', fraction: 0.4 }, { observed_on: '2026-10-05', fraction: 0.42 }];
  assert.equal(percentOnDate('masonry_wall', o, '2026-10-05'), 40);
  assert.equal(percentOnDate('masonry_wall', [{ observed_on: '2026-10-05', fraction: 1.7 }, { observed_on: '2026-10-05', fraction: 1.7 }], '2026-10-05'), 100); // clamped
});
test('every element type has a plan', () => {
  for (const t of ['footing', 'column', 'beam', 'slab', 'masonry_wall']) assert.ok(STAGE_PLAN[t]);
  assert.equal(confirmedValue([], '2026-10-05'), 0);
});

// ------------------------------------------------------------------ stock (TC-INV)
const fr = (cam, code, q, t) => ({ camera_id: cam, material_code: code, quantity: q, captured_at: t });
test('daily stock takes each camera\'s first and last frame and adds cameras together', () => {
  const s = dailyStock([
    fr('a', 'SAND', 100, '2026-10-05T03:00:00Z'), fr('a', 'SAND', 90, '2026-10-05T11:00:00Z'),
    fr('b', 'SAND', 50, '2026-10-05T03:00:00Z'), fr('b', 'SAND', 50, '2026-10-05T11:00:00Z'),
  ]);
  assert.deepEqual(s.start, { SAND: 150 });
  assert.deepEqual(s.end, { SAND: 140 });
});
test('consumption is start minus end of the same day; a delivery day still shows its consumption', () => {
  const days = [
    { date: '2026-10-05', start: { CEMENT: 500 }, end: { CEMENT: 450 } },
    { date: '2026-10-06', start: { CEMENT: 1450 }, end: { CEMENT: 1380 } }, // 1000 bags delivered overnight, 70 used
  ];
  const h = inventoryHistory(days, { CEMENT: 20 });
  assert.equal(h[0].used, 50);
  assert.equal(h[1].used, 70);
  assert.equal(h[1].delivered, 1000);
});
test('changes inside the noise deadband count as nothing', () => {
  const h = inventoryHistory([{ date: '2026-10-05', start: { SAND: 100 }, end: { SAND: 99 } }]);
  assert.equal(h[0].used, 0);
});
test('a day with a single frame shows no consumption', () => {
  const s = dailyStock([fr('a', 'REBAR', 5000, '2026-10-05T03:00:00Z')]);
  assert.equal(inventoryHistory([{ date: '2026-10-05', ...s }])[0].used, 0);
});
test('small rises are noise, not deliveries', () => {
  const h = inventoryHistory([
    { date: '2026-10-05', start: { SAND: 100 }, end: { SAND: 100 } },
    { date: '2026-10-06', start: { SAND: 103 }, end: { SAND: 103 } },
  ], { SAND: 3 });
  assert.equal(h[1].delivered, 0);
});
test('materials are tracked independently', () => {
  const h = inventoryHistory([{ date: '2026-10-05', start: { SAND: 100, BRICK: 5000 }, end: { SAND: 80, BRICK: 5000 } }]);
  assert.equal(h.find((x) => x.material_code === 'SAND').used, 20);
  assert.equal(h.find((x) => x.material_code === 'BRICK').used, 0);
});

// ------------------------------------------------------------------ hazards derived from evidence (TC-HAZ)
const LIB = { 'STR-HONEY': { id: 1, category: 'Structural integrity', title: 'Honeycombed concrete', default_likelihood: 3, default_severity: 4 },
  'STR-RUST': { id: 2, category: 'Structural integrity', title: 'Corroded reinforcement', default_likelihood: 3, default_severity: 3 } };
const bad = (id, cam, type, day, score = 0.5, severity = 'High') => ({ id, camera_id: cam, defect_type: type, detected_on: day, score, severity, is_violation: true });
const seen = (cam, day) => ({ camera_id: cam, date: day });

test('a violation opens a hazard from the library, with likelihood raised by severity', () => {
  const h = deriveHazards([bad('d1', 'c1', 'honeycombed_concrete', '2026-10-01', 0.7, 'Critical')], [seen('c1', '2026-10-01')], LIB);
  assert.equal(h.length, 1);
  assert.equal(h[0].status, 'open');
  assert.equal(h[0].likelihood, 5);
  assert.equal(h[0].severity, 4);
  assert.equal(h[0].title, 'Honeycombed concrete');
  assert.equal(h[0].camera_id, 'c1');
});
test(`hazard closes only after ${CLEAN_DAYS_TO_CLOSE} consecutive clean inspection days`, () => {
  const d = [bad('d1', 'c1', 'rusted_rebar', '2026-10-01')];
  const ins = (days) => days.map((x) => seen('c1', x));
  assert.equal(deriveHazards(d, ins(['2026-10-01', '2026-10-02', '2026-10-03']), LIB)[0].status, 'open'); // 2 clean days
  const closed = deriveHazards(d, ins(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']), LIB)[0];
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_on, '2026-10-04');
});
test('days without frames change nothing: absence of evidence is not safety', () => {
  const d = [bad('d1', 'c1', 'rusted_rebar', '2026-10-01')];
  const h = deriveHazards(d, [seen('c1', '2026-10-01'), seen('c1', '2026-10-20')], LIB)[0]; // a month of silence, one clean frame
  assert.equal(h.status, 'open');
  assert.equal(h.clean_days, 1);
});
test('a new violation resets the clean count and raises the likelihood without duplicating', () => {
  const d = [bad('d1', 'c1', 'rusted_rebar', '2026-10-01', 0.3, 'Medium'), bad('d2', 'c1', 'rusted_rebar', '2026-10-04', 0.7, 'Critical')];
  const h = deriveHazards(d, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((x) => seen('c1', x)), LIB);
  assert.equal(h.length, 1);
  assert.equal(h[0].status, 'open');
  assert.equal(h[0].clean_days, 0);
  assert.equal(h[0].likelihood, 5);
  assert.equal(h[0].defect_id, 'd2'); // the worst detection is the evidence
});
test('a violation after closure opens a new hazard', () => {
  const d = [bad('d1', 'c1', 'rusted_rebar', '2026-10-01'), bad('d2', 'c1', 'rusted_rebar', '2026-10-10')];
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-10'];
  const h = deriveHazards(d, days.map((x) => seen('c1', x)), LIB);
  assert.deepEqual(h.map((x) => x.status), ['closed', 'open']);
});
test('cameras and defect types are tracked separately', () => {
  const d = [bad('d1', 'c1', 'rusted_rebar', '2026-10-01'), bad('d2', 'c2', 'rusted_rebar', '2026-10-01'), bad('d3', 'c1', 'honeycombed_concrete', '2026-10-01')];
  assert.equal(deriveHazards(d, [seen('c1', '2026-10-01'), seen('c2', '2026-10-01')], LIB).length, 3);
});
test('non-violation and unmapped defects create no hazard', () => {
  const d = [{ ...bad('d1', 'c1', 'rusted_rebar', '2026-10-01'), is_violation: false }, bad('d2', 'c1', 'unknown_defect', '2026-10-01')];
  assert.deepEqual(deriveHazards(d, [], LIB), []);
});
test('deriveHazards is deterministic: same evidence, same hazards', () => {
  const d = [bad('d1', 'c1', 'rusted_rebar', '2026-10-01'), bad('d2', 'c1', 'honeycombed_concrete', '2026-10-03')];
  const ins = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((x) => seen('c1', x));
  assert.deepEqual(deriveHazards(d, ins, LIB), deriveHazards(d, ins, LIB));
});

// ------------------------------------------------------------------ evidence health (TC-EVD)
const cam = (id, kind, last, extra = {}) => ({ id, name: id, kind, element_id: extra.element_id ?? null, active: extra.active ?? true, last_frame_date: last });
test('a camera is stale after two missed WORKING days; Sunday does not count', () => {
  // Fri 2026-10-09 last frame. Sat is a working day (Mon-Sat), Sun is not.
  const h = (asOf) => cameraHealth([cam('y', 'yard', '2026-10-09')], {}, asOf)[0].status;
  assert.equal(h('2026-10-10'), 'ok'); // Saturday: 1 working day missed
  assert.equal(h('2026-10-11'), 'ok'); // Sunday: still only 1 working day missed
  assert.equal(h('2026-10-12'), 'stale'); // Monday: Sat + Mon missed
});
test('a camera that never reported is flagged; a disabled one is not', () => {
  assert.equal(cameraHealth([cam('y', 'yard', null)], {}, '2026-10-12')[0].status, 'never');
  assert.equal(cameraHealth([cam('y', 'yard', null, { active: false })], {}, '2026-10-12')[0].status, 'disabled');
});
test('a zone camera is only expected to report while its task is active', () => {
  const c = cam('z', 'zone', '2026-09-01', { element_id: 'e1' });
  assert.equal(cameraHealth([c], { e1: false }, '2026-10-12')[0].status, 'idle');
  assert.equal(cameraHealth([c], { e1: true }, '2026-10-12')[0].status, 'stale');
});
test('tasks without a zone camera are reported as uncovered', () => {
  const tasks = [{ name: 'A', element_id: 'e1' }, { name: 'B', element_id: 'e2' }];
  const u = uncoveredTasks(tasks, [cam('z', 'zone', null, { element_id: 'e1' }), cam('x', 'zone', null, { element_id: 'e2', active: false })]);
  assert.deepEqual(u.map((t) => t.name), ['B']);
});
test('evidence summary and alerts name the quiet cameras and uncovered tasks', () => {
  const health = [{ name: 'Yard', status: 'stale' }, { name: 'Gate', status: 'ok' }];
  const summary = evidenceSummary(health, [{ name: 'Walls' }]);
  assert.equal(summary.gap, true);
  const alerts = desiredAlerts({ budget: { status: 'on_track' }, schedule: { status: 'on_track' }, safety: { status: 'low' }, sdi: null, evidence: summary });
  assert.deepEqual(alerts.map((a) => a.dedupe_key).sort(), ['evidence:cameras', 'evidence:uncovered']);
  assert.match(alerts[0].plain_msg + alerts[1].plain_msg, /not verified|cannot be verified/);
  assert.equal(desiredAlerts({ budget: { status: 'on_track' }, schedule: { status: 'on_track' }, safety: { status: 'low' }, sdi: null, evidence: evidenceSummary([{ name: 'Gate', status: 'ok' }], []) }).length, 0);
});
