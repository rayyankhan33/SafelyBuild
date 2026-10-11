// Risk scoring. Three layers, all pure functions:
//
//  1. Risk matrix (ISO 31000 / IEC 31010): rating = likelihood (1-5) x severity (1-5).
//  2. ALARP zones (HSE R2P2 tolerability of risk) from the rating:
//        >= 15  intolerable          - must be reduced before work continues
//        5-14   tolerable if ALARP   - reduce as far as reasonably practicable
//        <= 4   broadly acceptable   - keep monitoring
//  3. Structural Danger Index (SDI, 0-10) from inspection photos, built from the proposal's
//     three pillars: severity, density, progression, with weights that shift as history grows.
//
// Engineers see the numbers; investors see the 4-level traffic light and plain wording.

import { addDays, diffDays } from './dates.js';

export const LIKELIHOOD_LABELS = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
export const SEVERITY_LABELS = ['Negligible', 'Minor', 'Moderate', 'Major', 'Catastrophic'];

export const RISK_THRESHOLDS = { INTOLERABLE: 15, ALARP: 5 };
export const SDI_BANDS = { MODERATE: 2.5, HIGH: 5.0, CRITICAL: 7.5 }; // lower bounds of each band
export const SEVERITY_WEIGHT_NORM = 0.6; // heuristics score at which a defect counts as fully severe

const LEVELS = ['low', 'moderate', 'high', 'critical'];
export const worstOf = (...ls) => ls.filter(Boolean).reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), 'low');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- matrix / ALARP
export function riskRating(likelihood, severity) {
  for (const [n, v] of [['likelihood', likelihood], ['severity', severity]]) {
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new RangeError(`${n} must be an integer 1-5`);
  }
  return likelihood * severity;
}

export function alarpZone(rating) {
  if (rating >= RISK_THRESHOLDS.INTOLERABLE) return 'intolerable';
  if (rating >= RISK_THRESHOLDS.ALARP) return 'alarp';
  return 'acceptable';
}

/** Traffic-light level for one hazard rating (used for the investor view). */
export function ratingLevel(rating) {
  if (rating >= RISK_THRESHOLDS.INTOLERABLE) return 'critical';
  if (rating >= 10) return 'high';
  if (rating >= RISK_THRESHOLDS.ALARP) return 'moderate';
  return 'low';
}

export const ZONE_TEXT = {
  intolerable: 'Intolerable - risk must be reduced before the affected work continues.',
  alarp: 'Tolerable only if as low as reasonably practicable (ALARP) - apply the suggested controls.',
  acceptable: 'Broadly acceptable - continue to monitor.',
};

// ---------------------------------------------------------------- hazards from defects
const DEFECT_TO_LIBRARY = { rusted_rebar: 'STR-RUST', honeycombed_concrete: 'STR-HONEY' };
export const libraryCodeForDefect = (type) => DEFECT_TO_LIBRARY[type] ?? null;

/** Raise likelihood with defect severity: High +1, Critical +2 (capped at 5). */
export function hazardFromDefect(library, defect) {
  const bump = { Low: 0, Medium: 0, High: 1, Critical: 2 }[defect.severity] ?? 0;
  return {
    library_id: library.id, defect_id: defect.id, source: 'auto_defect',
    category: library.category, title: library.title,
    likelihood: clamp(library.default_likelihood + bump, 1, 5), severity: library.default_severity,
    notes: `Detected automatically (${defect.severity} severity, score ${Number(defect.score).toFixed(2)}).`,
  };
}

// ---------------------------------------------------------------- SDI
/**
 * @param {object[]} defects  {detected_on, score, severity, is_violation, media_id}
 * @param {object[]} analysed {date, media_id}  every image that was analysed (denominator for density)
 * @param {string} asOf       'YYYY-MM-DD'
 * @param {number} windowDays current window length; the previous window is the same length before it
 */
export function computeSdi(defects, analysed, asOf, windowDays = 7) {
  const inWindow = (d, from, to) => diffDays(from, d) >= 0 && diffDays(d, to) >= 0;
  // current window [asOf-windowDays+1, asOf]; previous window is the same length just before it
  const startCur = addDays(asOf, -(windowDays - 1));
  const endPrev = addDays(asOf, -windowDays);
  const startPrev = addDays(asOf, -(2 * windowDays - 1));

  const curA = analysed.filter((a) => inWindow(a.date, startCur, asOf));
  if (curA.length === 0) return null; // no inspection in the window: cannot score

  const curD = defects.filter((d) => inWindow(d.detected_on, startCur, asOf));
  const prevA = analysed.filter((a) => inWindow(a.date, startPrev, endPrev));
  const prevD = defects.filter((d) => inWindow(d.detected_on, startPrev, endPrev));

  const sev = (ds) => (ds.length ? clamp(Math.max(...ds.map((d) => Number(d.score))) / SEVERITY_WEIGHT_NORM, 0, 1) : 0);
  const dens = (ds, as) => {
    if (!as.length) return 0;
    const bad = new Set(ds.filter((d) => d.is_violation).map((d) => d.media_id));
    return bad.size / new Set(as.map((a) => a.media_id)).size;
  };

  const S = sev(curD);
  const D = dens(curD, curA);
  const inspectionDays = new Set(analysed.map((a) => a.date)).size;
  const violationDays = new Set(curD.filter((d) => d.is_violation).map((d) => d.detected_on)).size;
  const curInspDays = new Set(curA.map((a) => a.date)).size;
  const hasPrev = prevA.length > 0;
  const persistence = curInspDays ? violationDays / curInspDays : 0;
  const delta = hasPrev ? S - sev(prevD) : 0;
  const P = clamp(Math.max(0, delta) + 0.5 * persistence, 0, 1);

  const weights = inspectionDays < 2 ? { severity: 0.6, density: 0.4, progression: 0 }
    : inspectionDays < 5 ? { severity: 0.5, density: 0.3, progression: 0.2 }
    : { severity: 0.4, density: 0.3, progression: 0.3 };

  const raw = weights.severity * S + weights.density * D + weights.progression * P;
  const sdi = r1(clamp(raw * 10, 0, 10));
  return {
    sdi, status: sdiLevel(sdi), severity_part: r3(S), density_part: r3(D), progression_part: r3(P),
    weights, inspection_days: inspectionDays, images_analysed: curA.length,
    defects_in_window: curD.length, violations_in_window: curD.filter((d) => d.is_violation).length,
    escalate: sdi >= SDI_BANDS.CRITICAL,
    explanation: explainSdi({ sdi, S, D, P, weights, inspectionDays, hasPrev, delta, violations: curD.filter((d) => d.is_violation).length }),
  };
}

export function sdiLevel(sdi) {
  if (sdi >= SDI_BANDS.CRITICAL) return 'critical';
  if (sdi >= SDI_BANDS.HIGH) return 'high';
  if (sdi >= SDI_BANDS.MODERATE) return 'moderate';
  return 'low';
}

function explainSdi({ sdi, S, D, P, weights, inspectionDays, hasPrev, delta, violations }) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const parts = [
    `SDI ${sdi}/10 = ${weights.severity} x severity ${pct(S)} + ${weights.density} x density ${pct(D)} + ${weights.progression} x progression ${pct(P)}.`,
    `${violations} violation-level defect(s) in the last 7 days across ${inspectionDays} inspection day(s) on record.`,
  ];
  if (hasPrev) parts.push(`Severity ${delta > 0.001 ? 'worsened' : delta < -0.001 ? 'improved' : 'is unchanged'} versus the previous 7 days.`);
  else parts.push('No earlier inspection window to compare with, so progression reflects persistence only.');
  return parts.join(' ');
}

// ---------------------------------------------------------------- overall safety status
/**
 * @param {object|null} sdi    result of computeSdi (or null)
 * @param {object[]} hazards   open hazards with risk_rating
 */
export function overallSafety(sdi, hazards) {
  const open = hazards.filter((h) => h.status !== 'closed');
  const worstRating = open.reduce((m, h) => Math.max(m, h.risk_rating ?? riskRating(h.likelihood, h.severity)), 0);
  const hazardLevel = open.length ? ratingLevel(worstRating) : null;
  if (!sdi && !open.length) return { status: 'no_data', sdi_level: null, hazard_level: null, worst_rating: 0, open_hazards: 0 };
  return {
    status: worstOf(sdi?.status, hazardLevel),
    sdi_level: sdi?.status ?? null, hazard_level: hazardLevel,
    worst_rating: worstRating, open_hazards: open.length,
    intolerable: open.filter((h) => alarpZone(h.risk_rating ?? riskRating(h.likelihood, h.severity)) === 'intolerable').length,
  };
}

/** 5x5 grid of hazard counts for the engineer heat-map. */
export function matrixCounts(hazards) {
  const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const h of hazards) if (h.status !== 'closed') grid[h.severity - 1][h.likelihood - 1] += 1;
  return grid; // grid[severity-1][likelihood-1]
}
