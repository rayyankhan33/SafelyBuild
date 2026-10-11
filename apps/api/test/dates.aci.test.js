import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/domain/dates.js';
import { designMix, requiredAverageStrength, waterCementRatio } from '../src/domain/aci211.js';

// ---- dates (TC-DATE-*)
test('working week is Mon-Sat: Sunday is skipped', () => {
  assert.equal(D.isWorkingDay('2026-10-10'), true); // Saturday
  assert.equal(D.isWorkingDay('2026-10-11'), false); // Sunday
  assert.equal(D.nextWorkingDay('2026-10-11'), '2026-10-12');
  assert.equal(D.addWorkingDays('2026-10-05', 6), '2026-10-12'); // Mon + 6 working days => next Mon
});
test('working days inclusive counts and handles reversed ranges', () => {
  assert.equal(D.workingDaysInclusive('2026-10-05', '2026-10-11'), 6);
  assert.equal(D.workingDaysInclusive('2026-10-11', '2026-10-05'), 0);
});
test('invalid dates are rejected', () => {
  assert.throws(() => D.parse('2026-02-30'), RangeError);
  assert.throws(() => D.parse('11/10/2026'), RangeError);
});
test('month and leap-year arithmetic', () => {
  assert.equal(D.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(D.diffDays('2026-12-31', '2027-01-01'), 1);
});

// ---- ACI 211.1 (TC-ACI-*)
const P = { maxAggMm: 25, sgCement: 3.15, sgFine: 2.65, sgCoarse: 2.65, coarseRoddedDensity: 1600 };

test("f'cr margin follows ACI 318 bands", () => {
  assert.equal(requiredAverageStrength(20), 27.0);
  assert.equal(requiredAverageStrength(25), 33.3);
  assert.ok(Math.abs(requiredAverageStrength(40) - 49) < 1e-9);
});
test('w/c interpolates between table rows', () => {
  assert.equal(waterCementRatio(30), 0.54);
  assert.ok(Math.abs(waterCementRatio(32.5) - 0.505) < 1e-9);
});
test('25 MPa mix is physically plausible', () => {
  const m = designMix(25, P);
  assert.equal(m.water, 193);
  assert.ok(m.cement > 380 && m.cement < 400, `cement ${m.cement}`);
  assert.equal(m.coarse, 1072);
  assert.ok(m.fine > 650 && m.fine < 750, `fine ${m.fine}`);
  assert.ok(m.totalMass > 2300 && m.totalMass < 2450, `mass ${m.totalMass}`);
});
test('stronger concrete needs more cement', () => {
  assert.ok(designMix(30, P).cement > designMix(20, P).cement);
});
test('strength above the table range is refused, not extrapolated', () => {
  assert.throws(() => designMix(40, P), /outside the ACI 211.1 table range/);
});
test('unsupported aggregate size is refused', () => {
  assert.throws(() => designMix(25, { ...P, maxAggMm: 10 }), /not supported/);
});
