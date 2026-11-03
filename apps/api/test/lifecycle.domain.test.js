// Completion lifecycle: placed -> curing -> finished -> inspected (TC-LIFE-*). Pure functions, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskLifecycle, CURE_DAYS } from '../src/domain/lifecycle.js';

const base = { task: { name: 'Slab S0' }, elementType: 'slab', inspectable: true };
const prog = (date, percent) => ({ date, percent });
const done = [prog('2026-10-05', 40), prog('2026-10-08', 100)];            // placed 8 Oct
const obs = (observed_on, formwork, stage = 3) => ({ observed_on, stage, fraction: 1, evidence: { formwork, concrete: 0.3 } });
const life = (over) => taskLifecycle({ ...base, progress: done, observations: [], inspections: [], asOf: '2026-10-09', ...over });

test('a task that is not at 100 % has no lifecycle and no warnings', () => {
  const l = life({ progress: [prog('2026-10-05', 80)] });
  assert.equal(l.state, 'not_placed'); assert.deepEqual(l.warnings, []);
});

test('progress is credited when placed; curing, finishing and inspection are open warnings', () => {
  const l = life({});
  assert.equal(l.state, 'curing'); assert.equal(l.placed_on, '2026-10-08');
  assert.deepEqual(l.warnings.map((w) => w.step), ['curing', 'finished', 'inspected']);
  assert.match(l.warnings[0].technical, /day 1 of 7/); assert.match(l.warnings[0].plain, /still curing/);
});

test('curing is timed only: it clears after the minimum days and nothing else clears with it', () => {
  const l = life({ asOf: '2026-10-15' });                                  // 7 days after placement
  assert.equal(l.state, 'cured'); assert.equal(l.cure_complete_on, '2026-10-15');
  assert.deepEqual(l.warnings.map((w) => w.step), ['finished', 'inspected']);
  assert.equal(CURE_DAYS.slab, 7);
});

test('finished needs two frames AFTER curing showing the final stage with the formwork gone', () => {
  const frames = [obs('2026-10-12', 0.0), obs('2026-10-15', 0.0)];          // before / on the cure date
  assert.equal(life({ asOf: '2026-10-16', observations: frames }).finished_on, null);   // 15 Oct is the only one on/after cure
  const two = [obs('2026-10-15', 0.0), obs('2026-10-16', 0.01)];
  const l = life({ asOf: '2026-10-16', observations: two });
  assert.equal(l.state, 'finished'); assert.equal(l.finished_on, '2026-10-16');
});

test('formwork still visible, an earlier stage, or no formwork measurement means NOT finished', () => {
  const asOf = '2026-10-20';
  assert.equal(life({ asOf, observations: [obs('2026-10-16', 0.2), obs('2026-10-17', 0.2)] }).finished_on, null);   // formwork visible
  assert.equal(life({ asOf, observations: [obs('2026-10-16', 0, 2), obs('2026-10-17', 0, 2)] }).finished_on, null); // not the final stage
  const noMeasure = [{ observed_on: '2026-10-16', stage: 3, fraction: 1, evidence: {} }, { observed_on: '2026-10-17', stage: 3, fraction: 1, evidence: null }];
  assert.equal(life({ asOf, observations: noMeasure }).finished_on, null);                                          // absence of evidence never clears
});

test('inspected needs a clean inspection by the element\'s own camera after finishing', () => {
  const finished = [obs('2026-10-15', 0), obs('2026-10-16', 0)];
  const before = life({ asOf: '2026-10-20', observations: finished, inspections: [{ date: '2026-10-10', violations: 0 }] });
  assert.equal(before.inspected_on, null);                                  // an inspection before finishing does not count
  const clean = life({ asOf: '2026-10-20', observations: finished, inspections: [{ date: '2026-10-17', violations: 0 }] });
  assert.equal(clean.state, 'inspected'); assert.equal(clean.inspected_on, '2026-10-17'); assert.deepEqual(clean.warnings, []);
});

test('an inspection that finds defects does not clear the warning, and a later clean one does', () => {
  const finished = [obs('2026-10-15', 0), obs('2026-10-16', 0)];
  const bad = life({ asOf: '2026-10-20', observations: finished, inspections: [{ date: '2026-10-17', violations: 2 }] });
  assert.equal(bad.state, 'finished'); assert.match(bad.warnings[0].technical, /2 violation-level/);
  const later = life({ asOf: '2026-10-20', observations: finished, inspections: [{ date: '2026-10-17', violations: 2 }, { date: '2026-10-19', violations: 0 }] });
  assert.equal(later.state, 'inspected');
});

test('a camera that does not run defect checks can never evidence an inspection, and says so', () => {
  const l = life({ asOf: '2026-10-20', inspectable: false, observations: [obs('2026-10-15', 0), obs('2026-10-16', 0)] });
  assert.equal(l.state, 'finished');
  assert.match(l.warnings.find((w) => w.step === 'inspected').plain, /no inspection camera/);
});

test('masonry has no formwork: finished means the wall is fully built, two frames after curing', () => {
  const wall = (d, f) => ({ observed_on: d, stage: 100, fraction: f, evidence: {} });
  const l = taskLifecycle({ task: { name: 'Wall' }, elementType: 'masonry_wall', progress: done, inspections: [], inspectable: true, asOf: '2026-10-20',
    observations: [wall('2026-10-16', 1), wall('2026-10-17', 1)] });
  assert.equal(l.state, 'finished');
  assert.equal(taskLifecycle({ task: { name: 'Wall' }, elementType: 'masonry_wall', progress: done, inspections: [], inspectable: true, asOf: '2026-10-20',
    observations: [wall('2026-10-16', 0.9), wall('2026-10-17', 0.9)] }).state, 'cured');
});

test('evidence dated after the status date is ignored', () => {
  const l = life({ asOf: '2026-10-09', progress: [prog('2026-10-12', 100)] });
  assert.equal(l.state, 'not_placed');
});
