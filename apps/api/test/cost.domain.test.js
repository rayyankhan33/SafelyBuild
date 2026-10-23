// Total project cost: pure arithmetic (TC-COST-*). No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrueCosts, normType, plannedDailyCosts, plannedTaskCost, plannedTotals, totalsByCategory, validateRates } from '../src/domain/cost.js';

const RATES = { crew_rate_pkr: 50_000, overhead_pct: 10, equipment: [{ type: 'Concrete mixer', rate_pkr: 4000, planned_units: 2 }, { type: 'tower crane', rate_pkr: 20_000, planned_units: 1 }] };

test('rates are validated: negatives, duplicate types, bad units', () => {
  assert.deepEqual(validateRates({ ...RATES }), []);
  assert.match(validateRates({ ...RATES, crew_rate_pkr: -1 }).join(), /crew rate/);
  assert.match(validateRates({ ...RATES, overhead_pct: 101 }).join(), /overhead/);
  assert.match(validateRates({ ...RATES, equipment: [{ type: 'Mixer', rate_pkr: 1, planned_units: 1 }, { type: ' mixer ', rate_pkr: 2, planned_units: 1 }] }).join(), /twice/);
  assert.match(validateRates({ ...RATES, equipment: [{ type: 'Mixer', rate_pkr: 1, planned_units: 1.5 }] }).join(), /whole number/);
  assert.match(validateRates({ ...RATES, equipment: [{ type: '', rate_pkr: 1, planned_units: 1 }] }).join(), /type/);
});

test('equipment types are matched ignoring case and spacing', () => {
  assert.equal(normType('  Concrete MIXER '), 'concrete mixer');
});

test('planned daily labour and equipment cost', () => {
  // 2 crews x 50,000 = 100,000; 2 x 4,000 + 1 x 20,000 = 28,000
  assert.deepEqual(plannedDailyCosts(RATES, 2), { labour: 100_000, equipment: 28_000 });
});

test('a task budget is materials + labour + equipment + overheads, and the parts add up', () => {
  // 10 working days, 1 crew: labour 500,000; equipment 280,000; materials 1,000,000; overheads 10 % of 1,780,000 = 178,000
  const t = plannedTaskCost(1_000_000, 10, RATES, 1);
  assert.deepEqual(t, { materials: 1_000_000, labour: 500_000, equipment: 280_000, overheads: 178_000, total: 1_958_000 });
  assert.equal(t.materials + t.labour + t.equipment + t.overheads, t.total);
});

test('without rates a task budget is the materials estimate (scope: materials only)', () => {
  assert.deepEqual(plannedTaskCost(123_456.78, 5, null, 3), { materials: 123_456.78, labour: 0, equipment: 0, overheads: 0, total: 123_456.78 });
});

test('more planned crews cost proportionally more labour', () => {
  assert.equal(plannedTaskCost(0, 4, { ...RATES, equipment: [], overhead_pct: 0 }, 3).labour, 3 * 4 * 50_000);
});

test('labour accrues from crews logged per day; no crew log means no labour cost', () => {
  const logs = [{ date: '2026-10-05', crews: 2, equipment: [] }, { date: '2026-10-06', crews: 0, equipment: [] }, { date: '2026-10-07', crews: null, equipment: null }];
  const { rows } = accrueCosts([], logs, { ...RATES, overhead_pct: 0, equipment: [] });
  assert.deepEqual(rows.filter((r) => r.category === 'labour'), [{ date: '2026-10-05', cost_pkr: 100_000, category: 'labour' }]);
});

test('equipment accrues from units logged at the locked hire rate, matched case-insensitively', () => {
  const logs = [{ date: '2026-10-05', crews: 1, equipment: [{ type: 'CONCRETE MIXER', count: 3 }, { type: 'Tower Crane', count: 1 }] }];
  const { rows, warnings } = accrueCosts([], logs, { ...RATES, overhead_pct: 0 });
  assert.equal(rows.find((r) => r.category === 'equipment').cost_pkr, 3 * 4000 + 20_000);
  assert.equal(warnings.length, 0);
});

test('equipment with no hire rate is not costed and a warning says so', () => {
  const logs = [{ date: '2026-10-05', crews: 1, equipment: [{ type: 'Excavator', count: 1 }, { type: 'excavator', count: 2 }] }];
  const { rows, warnings } = accrueCosts([], logs, RATES);
  assert.equal(rows.filter((r) => r.category === 'equipment').length, 0);
  assert.match(warnings[0], /excavator/);
  assert.equal(warnings[0].match(/excavator/g).length, 1); // listed once
});

test('overheads are a percentage of that day\'s materials + labour + equipment', () => {
  const logs = [{ date: '2026-10-05', crews: 1, equipment: [{ type: 'tower crane', count: 1 }] }];
  const { rows } = accrueCosts([{ date: '2026-10-05', cost_pkr: 30_000 }], logs, RATES);
  // direct = 30,000 + 50,000 + 20,000 = 100,000 -> 10 %
  assert.equal(rows.find((r) => r.category === 'overheads').cost_pkr, 10_000);
});

test('materials-only projects (no rates) accrue nothing else', () => {
  const { rows, warnings } = accrueCosts([{ date: '2026-10-05', cost_pkr: 5000 }], [{ date: '2026-10-05', crews: 5, equipment: [{ type: 'x', count: 1 }] }], null);
  assert.deepEqual(rows, [{ date: '2026-10-05', cost_pkr: 5000, category: 'materials' }]);
  assert.deepEqual(warnings, []);
});

test('totals by category stop at the status date', () => {
  const rows = [
    { date: '2026-10-05', cost_pkr: 100, category: 'materials' }, { date: '2026-10-05', cost_pkr: 50, category: 'labour' },
    { date: '2026-10-06', cost_pkr: 100, category: 'materials' }, { date: '2026-10-06', cost_pkr: 5, category: 'overheads' },
  ];
  assert.deepEqual(totalsByCategory(rows, '2026-10-05'), { materials: 100, labour: 50, equipment: 0, overheads: 0, total: 150 });
  assert.deepEqual(totalsByCategory(rows, '2026-10-06'), { materials: 200, labour: 50, equipment: 0, overheads: 5, total: 255 });
});

test('planned totals are rebuilt from the task parts and materials is the remainder', () => {
  const tasks = [
    { planned_cost_pkr: 1_958_000, planned_labour_pkr: 500_000, planned_equipment_pkr: 280_000, planned_overhead_pkr: 178_000 },
    { planned_cost_pkr: 100, planned_labour_pkr: 0, planned_equipment_pkr: 0, planned_overhead_pkr: 0 },
  ];
  assert.deepEqual(plannedTotals(tasks), { materials: 1_000_100, labour: 500_000, equipment: 280_000, overheads: 178_000, total: 1_958_100 });
});
