import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, elementVolume, validateElement } from '../src/domain/estimation.js';
import { generateSchedule } from '../src/domain/schedule.js';

export const FACTORS = {
  cement_bag_kg: 50, sg_cement: 3.15, sg_fine_agg: 2.65, sg_coarse_agg: 2.65, coarse_rodded_density: 1600,
  coarse_loose_density: 1450, sand_loose_density: 1500, wastage_concrete_pct: 5, wastage_steel_pct: 3,
  wastage_brick_pct: 5, bricks_per_m3_wall: 500, aci318_min_rho_column: 0.01, aci318_min_rho_slab: 0.0018,
  steel_density: 7850, max_aggregate_mm: 25,
};
export const RATES = { CEMENT: 1400, SAND: 3000, AGGREGATE: 4000, REBAR: 260, BRICK: 25 };
const slab = { id: 's1', label: 'Slab A', element_type: 'slab', quantity: 1, length_m: 10, width_m: 5, thickness_m: 0.15, concrete_fc_mpa: 25 };

// ---- estimation (TC-EST-*)
test('slab volume is L x W x t', () => assert.equal(elementVolume(slab), 7.5));
test('quantity multiplies volume', () => assert.equal(elementVolume({ ...slab, quantity: 4 }), 30));
test('cement bags follow the ACI mix with wastage', () => {
  const r = estimate([slab], FACTORS, RATES);
  const cement = r.lines.find((l) => l.material_code === 'CEMENT');
  assert.ok(cement.quantity > 58 && cement.quantity < 65, `bags ${cement.quantity}`); // 7.5 m3 x ~391 kg x 1.05 / 50
  const rebar = r.lines.find((l) => l.material_code === 'REBAR');
  assert.ok(Math.abs(rebar.quantity - 7.5 * 90 * 1.03) < 0.01);
});
test('total equals sum of line costs plus contingency', () => {
  const r = estimate([slab], FACTORS, RATES, 10);
  const sum = r.lines.reduce((s, l) => s + l.cost_pkr, 0);
  assert.ok(Math.abs(r.subtotal_pkr - sum) < 0.01);
  assert.ok(Math.abs(r.total_pkr - r.subtotal_pkr * 1.1) < 0.02);
});
test('masonry wall produces bricks only', () => {
  const wall = { id: 'w', label: 'Wall', element_type: 'masonry_wall', quantity: 1, length_m: 10, height_m: 3, thickness_m: 0.23 };
  const r = estimate([wall], FACTORS, RATES);
  assert.deepEqual(r.lines.map((l) => l.material_code), ['BRICK']);
  assert.ok(Math.abs(r.lines[0].quantity - 10 * 3 * 0.23 * 500 * 1.05) < 0.01);
});
test('steel below ACI 318 minimum raises a warning but still estimates', () => {
  const col = { id: 'c', label: 'Col C1', element_type: 'column', quantity: 1, length_m: 0.4, width_m: 0.4, height_m: 3, concrete_fc_mpa: 25, rebar_kg_per_m3: 40 };
  const r = estimate([col], FACTORS, RATES);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'ACI318_MIN_STEEL');
  assert.ok(r.total_pkr > 0);
});
test('missing dimension is reported', () => {
  assert.match(validateElement({ ...slab, thickness_m: undefined }).join(), /thickness_m/);
  assert.throws(() => estimate([{ ...slab, thickness_m: null }], FACTORS, RATES), /missing thickness_m/);
});
test('concrete element without grade is rejected', () => {
  assert.throws(() => estimate([{ ...slab, concrete_fc_mpa: null }], FACTORS, RATES), /f'c is required/);
});
test('empty BOQ, bad contingency and missing rate are rejected', () => {
  assert.throws(() => estimate([], FACTORS, RATES), /no design elements/);
  assert.throws(() => estimate([slab], FACTORS, RATES, 80), /contingency/);
  assert.throws(() => estimate([slab], FACTORS, { ...RATES, REBAR: undefined }), /missing rate for REBAR/);
});
test('zero rate is allowed (donated material) and gives zero cost for that line', () => {
  const r = estimate([slab], FACTORS, { ...RATES, SAND: 0 });
  assert.equal(r.lines.find((l) => l.material_code === 'SAND').cost_pkr, 0);
});

// ---- schedule (TC-SCH-*)
const PROD = [
  { element_type: 'footing', output_per_day: 12, min_duration_days: 2, sequence_no: 1 },
  { element_type: 'slab', output_per_day: 18, min_duration_days: 2, sequence_no: 4 },
];
test('tasks follow BOQ order and do not overlap', () => {
  const footing = { id: 'f', label: 'F1', element_type: 'footing', quantity: 1, length_m: 2, width_m: 2, height_m: 0.5 };
  const s = generateSchedule([slab, footing], PROD, { f: 100, s1: 200 }, '2026-10-05');
  assert.deepEqual(s.tasks.map((t) => t.element_id), ['s1', 'f']); // BOQ order is kept
  assert.ok(s.tasks[1].planned_start > s.tasks[0].planned_end);
  assert.equal(s.dependencies.length, 1);
  assert.equal(s.planned_end, s.tasks[1].planned_end);
});
test('minimum duration applies to small elements', () => {
  const s = generateSchedule([slab], PROD, { s1: 1 }, '2026-10-05');
  assert.equal(s.tasks[0].duration_days, 2); // 7.5 m3 / 18 = 1 day but minimum is 2
});
test('more crews shorten a large job', () => {
  const big = { ...slab, length_m: 60, width_m: 30 }; // 270 m3
  const one = generateSchedule([big], PROD, { s1: 1 }, '2026-10-05', 1).tasks[0].duration_days;
  const three = generateSchedule([big], PROD, { s1: 1 }, '2026-10-05', 3).tasks[0].duration_days;
  assert.equal(one, 15);
  assert.equal(three, 5);
});
test('start on a Sunday moves to Monday', () => {
  const s = generateSchedule([slab], PROD, { s1: 1 }, '2026-10-11');
  assert.equal(s.tasks[0].planned_start, '2026-10-12');
});
test('unknown element type or empty input is rejected', () => {
  assert.throws(() => generateSchedule([], PROD, {}, '2026-10-05'), /no design elements/);
  assert.throws(() => generateSchedule([{ ...slab, element_type: 'beam', width_m: 1, height_m: 1 }], PROD, {}, '2026-10-05'), /no productivity rate/);
});
