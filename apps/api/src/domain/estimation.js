// Bill-of-quantities -> material quantities -> PKR cost.
//
// Scope (Sprint 1): the estimate covers the *visible bulk materials* that the daily photo
// check can later track - cement, sand, coarse aggregate, reinforcing steel, bricks.
// Labour, plant, formwork and overheads are excluded and noted as such in the UI.

import { designMix } from './aci211.js';

const CONCRETE_TYPES = new Set(['footing', 'column', 'beam', 'slab']);

/** Dimensions each element type needs. Volume formula is documented per type. */
const SHAPES = {
  footing:      { need: ['length_m', 'width_m', 'height_m'],    vol: (e) => e.length_m * e.width_m * e.height_m },
  column:       { need: ['length_m', 'width_m', 'height_m'],    vol: (e) => e.length_m * e.width_m * e.height_m }, // section L x W, height H
  beam:         { need: ['length_m', 'width_m', 'height_m'],    vol: (e) => e.length_m * e.width_m * e.height_m }, // span L, width W, depth H
  slab:         { need: ['length_m', 'width_m', 'thickness_m'], vol: (e) => e.length_m * e.width_m * e.thickness_m },
  masonry_wall: { need: ['length_m', 'height_m', 'thickness_m'], vol: (e) => e.length_m * e.height_m * e.thickness_m },
};

/** Typical reinforcement used when the engineer gives none (kg of steel per m3 of concrete). */
export const DEFAULT_REBAR_KG_PER_M3 = { footing: 70, column: 160, beam: 140, slab: 90 };

export const REQUIRED_FACTORS = [
  'cement_bag_kg', 'sg_cement', 'sg_fine_agg', 'sg_coarse_agg', 'coarse_rodded_density',
  'coarse_loose_density', 'sand_loose_density', 'wastage_concrete_pct', 'wastage_steel_pct',
  'wastage_brick_pct', 'bricks_per_m3_wall', 'aci318_min_rho_column', 'aci318_min_rho_slab',
  'steel_density', 'max_aggregate_mm',
];

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

export function elementVolume(e) {
  const shape = SHAPES[e.element_type];
  if (!shape) throw new RangeError(`unknown element type '${e.element_type}'`);
  const missing = shape.need.filter((k) => !(Number(e[k]) > 0));
  if (missing.length) throw new RangeError(`${e.label || e.element_type}: missing ${missing.join(', ')}`);
  return shape.vol(e) * (e.quantity ?? 1);
}

/** Validate an element and return a list of human-readable problems (empty = fine). */
export function validateElement(e) {
  const problems = [];
  try {
    elementVolume(e);
  } catch (err) {
    problems.push(err.message);
  }
  if (CONCRETE_TYPES.has(e.element_type) && !e.concrete_fc_mpa) problems.push(`${e.label}: concrete grade f'c is required`);
  return problems;
}

/**
 * @param {object[]} elements   design_elements rows
 * @param {Record<string,number>} factors  estimation_factors as key -> number
 * @param {Record<string,number>} rates    material code -> PKR per unit
 * @param {number} contingencyPct
 */
export function estimate(elements, factors, rates, contingencyPct = 0) {
  for (const k of REQUIRED_FACTORS) if (!(k in factors)) throw new Error(`missing estimation factor '${k}'`);
  for (const c of ['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK']) {
    if (!(rates[c] >= 0)) throw new Error(`missing rate for ${c}`);
  }
  if (!(contingencyPct >= 0 && contingencyPct <= 50)) throw new RangeError('contingency must be between 0 and 50 %');
  if (!elements.length) throw new RangeError('no design elements: add elements before estimating');

  const lines = [];
  const warnings = [];
  const mixes = new Map(); // fc -> mix (cached)
  const perElement = {};

  const addLine = (el, code, qty, unit) => {
    qty = r3(qty);
    const cost = r2(qty * rates[code]);
    lines.push({ element_id: el.id ?? null, material_code: code, quantity: qty, unit, rate_pkr: rates[code], cost_pkr: cost });
    perElement[el.id ?? el.label] = r2((perElement[el.id ?? el.label] ?? 0) + cost);
  };

  const mixFor = (fc) => {
    if (!mixes.has(fc)) {
      mixes.set(fc, designMix(fc, {
        maxAggMm: factors.max_aggregate_mm, sgCement: factors.sg_cement, sgFine: factors.sg_fine_agg,
        sgCoarse: factors.sg_coarse_agg, coarseRoddedDensity: factors.coarse_rodded_density,
      }));
    }
    return mixes.get(fc);
  };

  for (const el of elements) {
    const vol = elementVolume(el);
    if (el.element_type === 'masonry_wall') {
      addLine(el, 'BRICK', vol * factors.bricks_per_m3_wall * (1 + factors.wastage_brick_pct / 100), 'nos');
      continue;
    }
    if (!el.concrete_fc_mpa) throw new RangeError(`${el.label}: concrete grade f'c is required`);
    const mix = mixFor(el.concrete_fc_mpa);
    const w = 1 + factors.wastage_concrete_pct / 100;
    addLine(el, 'CEMENT', (vol * mix.cement * w) / factors.cement_bag_kg, 'bag');
    addLine(el, 'SAND', (vol * mix.fine * w) / factors.sand_loose_density, 'm3');
    addLine(el, 'AGGREGATE', (vol * mix.coarse * w) / factors.coarse_loose_density, 'm3');

    const rebarPerM3 = el.rebar_kg_per_m3 ?? DEFAULT_REBAR_KG_PER_M3[el.element_type];
    addLine(el, 'REBAR', vol * rebarPerM3 * (1 + factors.wastage_steel_pct / 100), 'kg');

    // ACI 318 minimum-steel sanity check (advisory; does not change the quantity)
    const minPerM3 =
      el.element_type === 'column' ? factors.aci318_min_rho_column * factors.steel_density
      : el.element_type === 'slab' ? factors.aci318_min_rho_slab * factors.steel_density
      : null;
    if (minPerM3 != null && rebarPerM3 < minPerM3) {
      warnings.push({
        element: el.label, code: 'ACI318_MIN_STEEL',
        message: `${el.label}: ${rebarPerM3} kg/m3 of steel is below the ACI 318 minimum of about ${r2(minPerM3)} kg/m3 for a ${el.element_type}.`,
      });
    }
  }

  const byMaterial = {};
  for (const l of lines) {
    const m = (byMaterial[l.material_code] ??= { quantity: 0, unit: l.unit, rate_pkr: l.rate_pkr, cost_pkr: 0 });
    m.quantity = r3(m.quantity + l.quantity);
    m.cost_pkr = r2(m.cost_pkr + l.cost_pkr);
  }
  const subtotal = r2(lines.reduce((s, l) => s + l.cost_pkr, 0));
  const contingency = r2((subtotal * contingencyPct) / 100);
  return {
    lines,
    byMaterial,
    perElement,
    subtotal_pkr: subtotal,
    contingency_pct: contingencyPct,
    contingency_pkr: contingency,
    total_pkr: r2(subtotal + contingency),
    mixes: [...mixes.values()],
    compaction_factor_coarse: r3(factors.coarse_rodded_density / factors.coarse_loose_density),
    warnings,
    excluded: ['labour', 'plant and equipment', 'formwork', 'overheads and profit'],
  };
}
