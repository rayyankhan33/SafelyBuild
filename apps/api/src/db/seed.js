// Demo data generator.
//
// There are no real site photos for the demo, so this script SIMULATES the true state of a site
// day by day (progress, material stock, defects) and renders SYNTHETIC camera frames from it
// through the inference service's demo generator. Those frames then travel through the SAME ingest
// -> analysis -> roll-up -> forecast code that real camera frames use. No progress, spend or hazard
// number is typed in: they are measured back from the pictures.
//
// The synthetic frames are not real images. They show the pipeline works end to end; they say nothing
// about accuracy on real footage. The project is flagged `is_demo` and the UI says so.
//
//   npm run db:seed              create demo data if the demo organisation does not exist
//   npm run db:seed -- --reset   wipe all organisations/projects first
//
// Needs the inference service running with ENABLE_DEMO_FRAMES=1 (npm run dev does this).
// The demo password below is for LOCAL DEMOS ONLY.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { config } from '../config.js';
import { hashPassword } from '../http.js';
import { addDays, diffDays, isWorkingDay, today } from '../domain/dates.js';
import { plannedFraction } from '../domain/evm.js';
import { STAGE_PLAN, isContinuous, stageAtProgress } from '../domain/stages.js';
import { inferenceHealth } from '../inference.js';
import { createCamera, ingestFrame } from '../services/ingest.js';
import { rebuild } from '../services/rollup.js';
import { recompute } from '../services/forecast.js';
import { createEstimate, createProject, generateProjectSchedule, getActiveEstimate, getSchedule, setCostRates, setSiteStatus } from '../services/projects.js';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'SafelyBuild-Demo-1';
export const DEMO_USERS = [
  { email: 'admin@demo.safelybuild.test', full_name: 'Demo Admin', role: 'admin' },
  { email: 'engineer@demo.safelybuild.test', full_name: 'Ayesha Malik', role: 'engineer', pec_number: 'CIVIL/12345' },
  { email: 'investor@demo.safelybuild.test', full_name: 'Bilal Chaudhry', role: 'investor' },
];

// small deterministic PRNG so the demo is identical on every run
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const YARD_SCALE = 0.1; // metres per pixel of the yard camera
const EQUIPMENT = [{ type: 'Concrete mixer', count: 2 }, { type: 'Poker vibrator', count: 3 }, { type: 'Tower crane', count: 1 }];
// Indicative demo rates (PKR), entered once by the engineer at inception and then locked.
export const DEMO_COST_RATES = {
  crew_rate_pkr: 60_000, overhead_pct: 8,
  equipment: [{ type: 'Concrete mixer', rate_pkr: 4000, planned_units: 2 }, { type: 'Poker vibrator', rate_pkr: 1500, planned_units: 3 }, { type: 'Tower crane', rate_pkr: 25_000, planned_units: 1 }],
};

// Inspection-camera scenario, by working-day index from project start. 'bad' frames are REAL sample
// photos (rusted rebar / honeycomb); 'clean' frames show an empty area. Three consecutive clean days
// close a hazard automatically.
const INSPECTION = {
  6: 'concrete honey comb.jfif', 7: 'clean', 8: 'clean', 9: 'clean',
  12: 'Rusted Rebar.jfif', 13: 'clean', 14: 'clean', 15: 'clean',
  28: 'Rusted Rebar 2.jpg', 29: 'clean', 30: 'clean',
  33: 'concrete honey comb.jfif', 35: 'Rusted Rebar 2.jpg', 36: 'concrete-column-damage-honeycomb-189798476.webp',
};

// Indicative demo prices (PKR). SAND/AGGREGATE per m3 (about 85 and 120 PKR per cubic foot). Same values as migration 003.
const DEMO_PRICES = { CEMENT: 1400, SAND: 3002, AGGREGATE: 4238, REBAR: 270, BRICK: 28 };
async function ensurePriceBook() {
  if ((await pool.query('SELECT 1 FROM price_book LIMIT 1')).rowCount) return;
  for (const [code, rate] of Object.entries(DEMO_PRICES)) {
    await pool.query('INSERT INTO price_book (material_id, rate_pkr) SELECT id, $2 FROM material_catalog WHERE code = $1', [code, rate]);
  }
}

async function demoFrame(kind, params, seed) {
  const f = new FormData();
  f.append('kind', kind); f.append('params', JSON.stringify(params)); f.append('seed', String(seed));
  const res = await fetch(`${config.inferenceUrl}/v1/demo/frame`, { method: 'POST', body: f });
  if (!res.ok) throw new Error(`demo frame failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The scene a zone camera would see when the element is `pct` % complete (the simulation knows the truth). */
function framePlan(type, pct) {
  const stage = stageAtProgress(type, pct);
  const bounds = STAGE_PLAN[type].bounds;
  const last = bounds.length - 1;
  // once concrete is going down, the share of the element already covered is the pour progress
  return stage === last
    ? { element_type: type, stage, fraction: Math.min(1, (pct - bounds[last]) / (100 - bounds[last])) }
    : { element_type: type, stage };
}

export async function seed({ reset = false, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  await migrate(pool);
  if (reset) await pool.query('TRUNCATE organizations CASCADE'); // cascades to price_book (it references users)
  await ensurePriceBook();
  if ((await pool.query("SELECT 1 FROM organizations WHERE name = 'Demo Developments'")).rowCount) { log('Demo data already present (use --reset to rebuild).'); return null; }

  const health = await inferenceHealth();
  if (!health.ok || !health.demo_frames) {
    throw new Error('The inference service must be running with ENABLE_DEMO_FRAMES=1 to build demo data (npm run dev starts it that way).');
  }

  const org = (await pool.query("INSERT INTO organizations (name) VALUES ('Demo Developments') RETURNING id")).rows[0];
  const users = {};
  for (const u of DEMO_USERS) {
    users[u.role] = (await pool.query(
      `INSERT INTO users (org_id, email, password_hash, full_name, role, pec_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [org.id, u.email, await hashPassword(DEMO_PASSWORD), u.full_name, u.role, u.pec_number ?? null])).rows[0];
  }

  // project starts ~6 weeks ago so that "today" falls mid-construction
  const start = addDays(today(), -42);
  const created = await createProject(pool, users.engineer, {
    name: 'Margalla Heights - Residential Block A', location: 'Sector D-12, Islamabad',
    description: 'Three-storey RC frame residential block (demo project with synthetic camera frames).', start_date: start });
  await pool.query('UPDATE projects SET is_demo = true WHERE id = $1', [created.id]);
  await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2)', [created.id, users.investor.id]);

  // ---- engineer input 1: the BOQ, listed in build order
  const els = [
    ['Footings F1 (isolated)', 'footing', 60, 1.8, 1.8, 0.6, null, 25],
    ['Columns C1 (ground storey)', 'column', 80, 0.4, 0.4, 3.2, null, 30],
    ['Plinth beams PB1', 'beam', 100, 5.0, 0.3, 0.45, null, 25],
    ['Ground floor slab S0', 'slab', 1, 30, 20, null, 0.15, 25],
    ['Columns C2 (first storey)', 'column', 80, 0.4, 0.4, 3.0, null, 30],
    ['First floor beams B1', 'beam', 100, 5.0, 0.3, 0.45, null, 25],
    ['First floor slab S1', 'slab', 1, 30, 20, null, 0.15, 25],
    ['Columns C3 (second storey)', 'column', 80, 0.4, 0.4, 3.0, null, 30],
    ['Second floor beams B2', 'beam', 100, 5.0, 0.3, 0.45, null, 25],
    ['Second floor slab S2', 'slab', 1, 30, 20, null, 0.15, 25],
    ['Boundary and partition walls', 'masonry_wall', 1, 300, 3.0, null, 0.23, null],
  ];
  for (const [label, type, qty, l, w, h, t, fc] of els) {
    await pool.query(
      `INSERT INTO design_elements (project_id, label, element_type, quantity, length_m, width_m, height_m, thickness_m, concrete_fc_mpa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [created.id, label, type, qty, l, type === 'masonry_wall' ? null : w, type === 'masonry_wall' ? w : h, t, fc]);
  }
  const est = await createEstimate(pool, created, users.engineer.id, { contingency_pct: 5, activate: true });
  // ---- engineer input: labour, equipment and overhead rates, once, then locked
  await setCostRates(pool, created, users.engineer, DEMO_COST_RATES);
  const project = (await pool.query('SELECT * FROM projects WHERE id = $1', [created.id])).rows[0];
  const sched = await generateProjectSchedule(pool, project, {});
  const p = (await pool.query('SELECT * FROM projects WHERE id = $1', [project.id])).rows[0];
  log(`Estimate PKR ${est.total_pkr.toLocaleString()}; ${sched.tasks.length} tasks, planned finish ${sched.planned_end}`);

  // ---- admin installs the cameras (one per element, one yard camera, one inspection camera).
  // Only the inspection camera runs the defect check: the synthetic zone/yard frames are flat colour
  // regions, which the texture-based defect heuristics are not meant for. (On a real site the admin
  // would enable defect checks on every camera that can see finished work.)
  const tasks = await getSchedule(pool, p.id);
  const elements = (await pool.query('SELECT id, element_type, label FROM design_elements WHERE project_id = $1', [p.id])).rows;
  const elType = Object.fromEntries(elements.map((e) => [e.id, e.element_type]));
  const zoneCams = {};
  for (const t of tasks) {
    const e = elements.find((x) => x.id === t.element_id);
    zoneCams[t.id] = (await createCamera(pool, p, users.admin, { name: `Zone camera - ${e.label}`, kind: 'zone', element_id: e.id, expected_frames_per_day: 2, detect_defects: false })).camera;
  }
  const yardCam = (await createCamera(pool, p, users.admin, { name: 'Material yard camera', kind: 'yard', scale_m_per_px: YARD_SCALE, expected_frames_per_day: 2, detect_defects: false })).camera;
  const gateCam = (await createCamera(pool, p, users.admin, { name: 'Inspection camera (site gate)', kind: 'overview', expected_frames_per_day: 1 })).camera;
  const camRow = async (c) => (await pool.query('SELECT * FROM cameras WHERE id = $1', [c.id])).rows[0];

  // ---- simulate the site, day by day. The simulation knows the TRUTH; the system only ever sees pictures.
  const active = await getActiveEstimate(pool, p.id);
  const rand = rng(2026);
  const plannedDays = sched.tasks.reduce((n, t) => n + t.duration_days, 0);
  const totals = {};
  for (const l of active.lines) totals[l.material_code] = (totals[l.material_code] ?? 0) + Number(l.quantity);
  const avgDaily = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / plannedDays]));
  const stock = Object.fromEntries(Object.keys(totals).map((k) => [k, avgDaily[k] * 8])); // initial delivery
  const cumulative = Object.fromEntries(tasks.map((t) => [t.id, 0]));
  const doneOn = {};
  const yesterday = addDays(today(), -1);
  let truthSpend = 0;
  let prevDate = null;
  let idx = 0;
  let frames = 0;
  const at = (d, hourUtc, minute = 0) => new Date(`${d}T${String(hourUtc).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);

  for (let d = start; diffDays(d, yesterday) >= 0; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    idx += 1;
    const perf = 0.85 + (rand() - 0.5) * 0.2 - (idx >= 15 && idx <= 17 ? 0.35 : 0); // rain dip around day 15-17

    // truth: progress and material consumption today
    const use = {};
    for (const t of tasks) {
      const planInc = plannedFraction(t, d) - (prevDate ? plannedFraction(t, prevDate) : 0);
      if (planInc <= 0 || cumulative[t.id] >= 1) continue;
      const inc = Math.min(1 - cumulative[t.id], planInc * Math.max(0.1, perf));
      cumulative[t.id] += inc;
      if (cumulative[t.id] >= 0.9999 && !doneOn[t.id]) doneOn[t.id] = d;
      const factor = 1.08 + rand() * 0.08; // site uses 8-16 % more material than estimated
      for (const l of active.lines.filter((x) => x.element_id === t.element_id)) use[l.material_code] = (use[l.material_code] ?? 0) + Number(l.quantity) * inc * factor;
    }
    let materialsToday = 0;
    for (const [code, q] of Object.entries(use)) materialsToday += q * (DEMO_PRICES[code] ?? 0);
    const stockAtStart = {};
    for (const code of Object.keys(stock)) {
      const need = use[code] ?? 0;
      if (stock[code] - need < avgDaily[code] * 2) stock[code] += Math.max(avgDaily[code], need) * 7; // delivery arrives before work starts
      stockAtStart[code] = stock[code];
      stock[code] -= need; // consumed during the day
    }

    // engineer input 2 and 3: crews and equipment on site
    const crewsToday = perf < 0.6 ? 0 : 1;
    await setSiteStatus(pool, p, users.engineer, d, { crews: crewsToday, equipment: EQUIPMENT });
    // truth of the day's total cost: materials + labour + equipment + overheads, at the locked rates
    const labourToday = crewsToday * DEMO_COST_RATES.crew_rate_pkr;
    const equipmentToday = EQUIPMENT.reduce((n, u) => n + u.count * DEMO_COST_RATES.equipment.find((e) => e.type === u.type).rate_pkr, 0);
    truthSpend += (materialsToday + labourToday + equipmentToday) * (1 + DEMO_COST_RATES.overhead_pct / 100);

    // cameras report: two frames from the yard camera
    for (const [n, hour] of [[0, 3], [1, 11]]) {
      const shown = n === 0 ? stockAtStart : stock; // 08:00 frame: start of day; 16:00 frame: end of day
      const png = await demoFrame('yard', { stock: Object.fromEntries(Object.entries(shown).map(([k, v]) => [k, Math.round(v * 100) / 100])), scale_m_per_px: YARD_SCALE }, idx * 10 + n);
      await ingestFrame(pool, await camRow(yardCam), { buffer: png, capturedAt: at(d, hour, 5 * n + 1), backfill: true });
      frames += 1;
    }
    // zone cameras report while their task is under way
    for (const t of tasks) {
      const due = diffDays(t.planned_start, d) >= -1;
      const doneEarlier = doneOn[t.id] && diffDays(doneOn[t.id], d) > 1;
      if (!due || doneEarlier) continue;
      const type = elType[t.element_id];
      const pct = cumulative[t.id] * 100;
      const params = isContinuous(type) ? { element_type: type, fraction: pct / 100 } : framePlan(type, pct);
      for (const [n, hour] of [[0, 4], [1, 10]]) {
        const png = await demoFrame('zone', params, idx * 100 + tasks.indexOf(t) * 2 + n);
        await ingestFrame(pool, await camRow(zoneCams[t.id]), { buffer: png, capturedAt: at(d, hour, 10 * n + 2), backfill: true });
        frames += 1;
      }
    }
    // inspection camera
    if (INSPECTION[idx]) {
      const png = INSPECTION[idx] === 'clean'
        ? await demoFrame('zone', { element_type: 'slab', stage: 0 }, idx)
        : await demoFrame('sample', { file: INSPECTION[idx] }, idx);
      await ingestFrame(pool, await camRow(gateCam), { buffer: png, capturedAt: at(d, 7, 30), backfill: true });
      frames += 1;
    }
    prevDate = d;
    if (idx % 6 === 0) log(`  simulated ${idx} working days (${frames} frames so far)`);
  }

  await rebuild(pool, p);
  const result = await recompute(pool, p, today());
  const truthEv = tasks.reduce((sum, t) => sum + Number(t.planned_cost_pkr) * cumulative[t.id], 0);
  const m = result.metrics;
  log(`Measurement fidelity (synthetic frames): spend measured ${Math.round(m.ac).toLocaleString()} vs true ${Math.round(truthSpend).toLocaleString()} (${((m.ac / truthSpend - 1) * 100).toFixed(1)} %); ` +
    `work done measured ${Math.round(m.ev).toLocaleString()} vs true ${Math.round(truthEv).toLocaleString()} (${((m.ev / truthEv - 1) * 100).toFixed(1)} %)`);
  const measured = Object.fromEntries((await getSchedule(pool, p.id)).map((t) => [t.id, Number(t.percent_complete)]));
  for (const t of tasks) log(`    ${t.name.padEnd(46)} true ${(cumulative[t.id] * 100).toFixed(1).padStart(5)} %   measured ${measured[t.id].toFixed(1).padStart(5)} %`);
  log(`Ingested ${frames} synthetic frames. Status:`, JSON.stringify({ budget: result.metrics.budget.status, schedule: result.metrics.schedule.status, safety: result.safety.status }));
  return { project: p, users };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed({ reset: process.argv.includes('--reset') });
  console.log('\nDemo logins: see docs/demo-accounts.md');
  await pool.end();
}
