// Total project cost: materials + labour + equipment + overheads (decisions D1, D2).
//
//   labour     = crews on site that day x crew rate per day
//   equipment  = units on site that day x hire rate per unit per day (per equipment type)
//   overheads  = overhead % x (materials + labour + equipment) of the same day
//   materials  = measured from the yard cameras (see inventory.js); never entered by a person
//
// Rates are entered once at the start of the project and locked. Crews and equipment per day are the
// engineer's own site log (not image evidence), so labour and equipment cost are "reported" costs; the
// crew-count cross-check against camera counts is a later feature. All functions are pure.

export const CATEGORIES = ['materials', 'labour', 'equipment', 'overheads'];

const r2 = (x) => Math.round(x * 100) / 100;
export const normType = (t) => String(t ?? '').trim().toLowerCase();

/**
 * Check a rates submission. Returns a list of problems (empty = valid).
 * @param {{crew_rate_pkr:number, overhead_pct:number, equipment:{type:string, rate_pkr:number, planned_units:number}[]}} r
 */
export function validateRates(r) {
  const problems = [];
  if (!Number.isFinite(r.crew_rate_pkr) || r.crew_rate_pkr < 0) problems.push('crew rate must be zero or more PKR per day');
  if (!Number.isFinite(r.overhead_pct) || r.overhead_pct < 0 || r.overhead_pct > 100) problems.push('overhead percentage must be between 0 and 100');
  const seen = new Set();
  for (const e of r.equipment ?? []) {
    const t = normType(e.type);
    if (!t) problems.push('every equipment line needs a type');
    else if (seen.has(t)) problems.push(`equipment type '${t}' is listed twice`);
    seen.add(t);
    if (!(e.rate_pkr >= 0)) problems.push(`equipment '${t}': rate must be zero or more PKR per unit per day`);
    if (!Number.isInteger(e.planned_units) || e.planned_units < 0) problems.push(`equipment '${t}': planned units must be a whole number`);
  }
  return problems;
}

/** Cost per working day of the planned crews and equipment. */
export function plannedDailyCosts(rates, plannedCrews) {
  const labour = plannedCrews * rates.crew_rate_pkr;
  const equipment = rates.equipment.reduce((s, e) => s + e.planned_units * e.rate_pkr, 0);
  return { labour, equipment };
}

/**
 * Budget of one task split into its parts. `materialCost` already includes the estimate's contingency.
 * Labour and equipment run for the task's planned duration (working days); overheads are a % of the direct total.
 */
export function plannedTaskCost(materialCost, durationDays, rates, plannedCrews) {
  if (!rates) return { materials: r2(materialCost), labour: 0, equipment: 0, overheads: 0, total: r2(materialCost) };
  const d = plannedDailyCosts(rates, plannedCrews);
  const labour = d.labour * durationDays;
  const equipment = d.equipment * durationDays;
  const overheads = ((materialCost + labour + equipment) * rates.overhead_pct) / 100;
  return { materials: r2(materialCost), labour: r2(labour), equipment: r2(equipment), overheads: r2(overheads), total: r2(materialCost + labour + equipment + overheads) };
}

/**
 * Cost rows accrued from the engineer's daily site log, plus the measured material spend.
 * @param {{date:string, cost_pkr:number}[]} materialSpend  from camera-measured consumption
 * @param {{date:string, crews:number|null, equipment:{type:string,count:number}[]|null}[]} siteLogs
 * @param {object|null} rates  {crew_rate_pkr, overhead_pct, equipment:[{type, rate_pkr}]} or null (materials only)
 * @returns {{rows:{date:string, cost_pkr:number, category:string}[], warnings:string[]}}
 */
export function accrueCosts(materialSpend, siteLogs, rates) {
  const rows = materialSpend.map((s) => ({ date: s.date, cost_pkr: Number(s.cost_pkr), category: 'materials' }));
  const warnings = [];
  if (!rates) return { rows, warnings };
  const rateByType = new Map(rates.equipment.map((e) => [normType(e.type), Number(e.rate_pkr)]));
  const unpriced = new Set();
  const direct = new Map(); // date -> materials + labour + equipment
  const add = (date, cost) => direct.set(date, (direct.get(date) ?? 0) + cost);
  for (const s of rows) add(s.date, s.cost_pkr);

  for (const log of siteLogs) {
    if (log.crews === null || log.crews === undefined) continue;
    const labour = Number(log.crews) * Number(rates.crew_rate_pkr);
    if (labour > 0) { rows.push({ date: log.date, cost_pkr: r2(labour), category: 'labour' }); add(log.date, labour); }
    let eq = 0;
    for (const u of log.equipment ?? []) {
      const key = normType(u.type);
      if (!rateByType.has(key)) { unpriced.add(key); continue; }
      eq += Number(u.count) * rateByType.get(key);
    }
    if (eq > 0) { rows.push({ date: log.date, cost_pkr: r2(eq), category: 'equipment' }); add(log.date, eq); }
  }
  if (rates.overhead_pct > 0) {
    for (const [date, d] of direct) rows.push({ date, cost_pkr: r2((d * rates.overhead_pct) / 100), category: 'overheads' });
  }
  if (unpriced.size) warnings.push(`Equipment logged with no hire rate was not costed: ${[...unpriced].join(', ')}. Rates cannot be added after inception; this needs change control.`);
  return { rows, warnings };
}

/** Totals by category up to and including `asOf` ({materials, labour, equipment, overheads, total}). */
export function totalsByCategory(rows, asOf) {
  const out = { materials: 0, labour: 0, equipment: 0, overheads: 0 };
  for (const r of rows) if (r.date <= asOf) out[r.category] += r.cost_pkr;
  for (const k of CATEGORIES) out[k] = r2(out[k]);
  return { ...out, total: r2(CATEGORIES.reduce((s, k) => s + out[k], 0)) };
}

/** Baseline budget by category from the schedule's tasks. */
export function plannedTotals(tasks) {
  const sum = (f) => r2(tasks.reduce((s, t) => s + Number(f(t) ?? 0), 0));
  const total = sum((t) => t.planned_cost_pkr);
  const labour = sum((t) => t.planned_labour_pkr);
  const equipment = sum((t) => t.planned_equipment_pkr);
  const overheads = sum((t) => t.planned_overhead_pkr);
  return { materials: r2(total - labour - equipment - overheads), labour, equipment, overheads, total };
}
