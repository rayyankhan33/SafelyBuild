// Concrete mix proportioning by the absolute-volume method of ACI 211.1 (non-air-entrained
// concrete, slump 75-100 mm). Tables below are transcribed from ACI 211.1 for the cases we
// support; verify them against your licensed copy before relying on the numbers.
//
// Steps (ACI 211.1 sections 6.3.1-6.3.7):
//   1. f'cr  required average strength from specified f'c            (ACI 318 margin)
//   2. water and entrapped air for slump + maximum aggregate size    (Table 6.3.3)
//   3. w/c ratio for f'cr                                            (Table 6.3.4(a))
//   4. cement = water / (w/c)
//   5. coarse aggregate = bulk-volume fraction x dry-rodded density  (Table 6.3.6)
//   6. sand = remaining absolute volume x specific gravity

// Table 6.3.3, non-air-entrained, slump 75-100 mm: kg water per m3 and % entrapped air
const WATER_AIR = {
  19: { water: 205, airPct: 2.0 },
  25: { water: 193, airPct: 1.5 },
  37.5: { water: 181, airPct: 1.0 },
};
// Table 6.3.6, fineness modulus 2.8: bulk volume of dry-rodded coarse aggregate per m3 concrete
const COARSE_VOLUME_FM28 = { 19: 0.62, 25: 0.67, 37.5: 0.71 };
// Table 6.3.4(a), non-air-entrained: [f'cr MPa, w/c], ascending strength
const WC_TABLE = [[15, 0.79], [20, 0.69], [25, 0.61], [30, 0.54], [35, 0.47], [40, 0.42], [45, 0.38]];

export const SUPPORTED_MAX_AGG_MM = Object.keys(WATER_AIR).map(Number);

/** ACI 318 required average compressive strength when no field-test history exists (MPa). */
export function requiredAverageStrength(fc) {
  if (!(fc > 0)) throw new RangeError("f'c must be positive");
  if (fc < 21) return fc + 7.0;
  if (fc <= 35) return fc + 8.3;
  return 1.1 * fc + 5.0;
}

export function waterCementRatio(fcr) {
  const lo = WC_TABLE[0][0];
  const hi = WC_TABLE[WC_TABLE.length - 1][0];
  if (fcr < lo || fcr > hi) {
    throw new RangeError(`required average strength ${fcr.toFixed(1)} MPa is outside the ACI 211.1 table range ${lo}-${hi} MPa`);
  }
  for (let i = 1; i < WC_TABLE.length; i++) {
    const [x1, y1] = WC_TABLE[i - 1];
    const [x2, y2] = WC_TABLE[i];
    if (fcr <= x2) return y1 + ((fcr - x1) / (x2 - x1)) * (y2 - y1);
  }
  /* istanbul ignore next */ return WC_TABLE[WC_TABLE.length - 1][1];
}

/**
 * Mix per 1 m3 of compacted concrete, quantities as dry (SSD) masses in kg.
 * @param {number} fc specified compressive strength f'c (MPa)
 * @param {object} p  { maxAggMm, sgCement, sgFine, sgCoarse, coarseRoddedDensity }
 */
export function designMix(fc, p) {
  const wa = WATER_AIR[p.maxAggMm];
  if (!wa) throw new RangeError(`max aggregate ${p.maxAggMm} mm not supported (use ${SUPPORTED_MAX_AGG_MM.join(', ')})`);
  const fcr = requiredAverageStrength(fc);
  const wc = waterCementRatio(fcr);
  const water = wa.water;
  const cement = water / wc;
  const coarse = COARSE_VOLUME_FM28[p.maxAggMm] * p.coarseRoddedDensity;
  const fineVolume =
    1 - water / 1000 - cement / (p.sgCement * 1000) - wa.airPct / 100 - coarse / (p.sgCoarse * 1000);
  if (fineVolume <= 0) throw new RangeError('mix is over-volume: check specific gravities and rodded density');
  const fine = fineVolume * p.sgFine * 1000;
  return {
    fc, fcr: round(fcr, 1), wc: round(wc, 3), airPct: wa.airPct,
    water, cement: round(cement, 1), coarse: round(coarse, 1), fine: round(fine, 1),
    totalMass: round(water + cement + coarse + fine, 1),
  };
}

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;
