// Demo data generator. It builds a realistic project *through the same services the API uses*
// (estimate -> schedule -> daily logs -> photo analysis), so every number on the dashboards is
// computed, not typed in. Dates are relative to today, so the demo is always "live".
//
//   npm run db:seed              create demo data if the demo organisation does not exist
//   npm run db:seed -- --reset   wipe all organisations/projects first
//
// The demo pass-word below is for LOCAL DEMOS ONLY. Photos need the inference service running
// (npm run inference); without it the project is seeded without photos.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { hashPassword } from '../http.js';
import { addDays, isWorkingDay, today, diffDays } from '../domain/dates.js';
import { plannedFraction } from '../domain/evm.js';
import { inferenceHealth } from '../inference.js';
import { ingestPhoto } from '../services/media.js';
import { recompute } from '../services/forecast.js';
import { createEstimate, createProject, generateProjectSchedule, getActiveEstimate, getSchedule, upsertLog } from '../services/projects.js';

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

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../services/inference/samples');
// working-day index from project start -> sample photo. The last entries are recent on purpose so
// the 7-day Structural Danger Index window has inspections in it when the demo is opened.
const PHOTO_PLAN = [
  [6, 'concrete honey comb.jfif', 'general'],
  [12, 'Rusted Rebar.jfif', 'general'],
  [19, 'concrete-column-damage-honeycomb-189798476.webp', 'general'],
  [28, 'Rusted Rebar 2.jpg', 'general'],
  [33, 'concrete honey comb.jfif', 'general'],
  [35, 'Rusted Rebar 2.jpg', 'general'],
  [36, 'concrete-column-damage-honeycomb-189798476.webp', 'general'],
];

export async function seed({ reset = false, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  await migrate(pool);
  if (reset) await pool.query('TRUNCATE organizations CASCADE');
  const exists = (await pool.query("SELECT 1 FROM organizations WHERE name = 'Demo Developments'")).rowCount;
  if (exists) { log('Demo data already present (use --reset to rebuild).'); return null; }

  const org = (await pool.query("INSERT INTO organizations (name) VALUES ('Demo Developments') RETURNING id")).rows[0];
  const users = {};
  for (const u of DEMO_USERS) {
    users[u.role] = (await pool.query(
      `INSERT INTO users (org_id, email, password_hash, full_name, role, pec_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [org.id, u.email, await hashPassword(DEMO_PASSWORD), u.full_name, u.role, u.pec_number ?? null])).rows[0];
  }

  // project starts ~6 weeks ago so that "today" falls mid-construction
  const start = addDays(today(), -42);
  const project = await createProject(pool, users.engineer, {
    name: 'Margalla Heights - Residential Block A', location: 'Sector D-12, Islamabad',
    description: 'Three-storey RC frame residential block (demo project).', start_date: start });
  await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2)', [project.id, users.investor.id]);

  // listed in build order: each storey is footings/columns -> beams -> slab, walls last
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
      [project.id, label, type, qty, l, type === 'masonry_wall' ? null : w, type === 'masonry_wall' ? w : h, t, fc]);
  }
  const est = await createEstimate(pool, project, users.engineer.id, { contingency_pct: 5, activate: true });
  const fresh = (await pool.query('SELECT * FROM projects WHERE id = $1', [project.id])).rows[0];
  const sched = await generateProjectSchedule(pool, fresh, {});
  log(`Estimate PKR ${est.total_pkr.toLocaleString()}; ${sched.tasks.length} tasks, planned finish ${sched.planned_end}`);

  // ---- simulate daily site records: crews run at ~85% of plan, materials at ~7% over estimate
  const p = (await pool.query('SELECT * FROM projects WHERE id = $1', [project.id])).rows[0];
  const tasks = await getSchedule(pool, project.id);
  const active = await getActiveEstimate(pool, project.id);
  const rand = rng(2026);
  const cumulative = Object.fromEntries(tasks.map((t) => [t.id, 0]));
  const photoDays = new Map(PHOTO_PLAN.map(([i, f, tag]) => [i, { file: f, tag }]));
  const inferenceUp = (await inferenceHealth()).ok;
  if (!inferenceUp) log('Inference service not reachable: seeding without photos (start it with `npm run inference`).');

  let prevDate = null;
  let workingIndex = 0;
  const yesterday = addDays(today(), -1);
  for (let d = start; diffDays(d, yesterday) >= 0; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    workingIndex += 1;
    const perf = 0.85 + (rand() - 0.5) * 0.2 - (workingIndex >= 15 && workingIndex <= 17 ? 0.35 : 0); // rain dip around day 15-17
    const progress = [];
    const use = {};
    for (const t of tasks) {
      const planInc = plannedFraction(t, d) - (prevDate ? plannedFraction(t, prevDate) : 0);
      if (planInc <= 0 || cumulative[t.id] >= 1) continue;
      const inc = Math.min(1 - cumulative[t.id], planInc * Math.max(0.1, perf));
      cumulative[t.id] += inc;
      const factor = 1.08 + rand() * 0.08; // material over-use 8-16 % on top of the 5 % allowance
      for (const l of active.lines.filter((x) => x.element_id === t.element_id)) {
        use[l.material_code] = (use[l.material_code] ?? 0) + Number(l.quantity) * inc * factor;
      }
    }
    for (const t of tasks) if (cumulative[t.id] > 0) progress.push({ task_id: t.id, percent: Math.round(cumulative[t.id] * 1000) / 10 });
    const materials = Object.entries(use).filter(([, q]) => q > 0).map(([code, q]) => ({
      material_code: code, quantity: Math.round(q * 100) / 100, source: 'manual' }));
    await upsertLog(pool, p, users.engineer, d, {
      workers_present: Math.round(28 + rand() * 10), weather: perf < 0.6 ? 'Rain' : 'Clear',
      notes: perf < 0.6 ? 'Rain delayed pours.' : undefined, progress, materials });
    const ph = photoDays.get(workingIndex);
    if (ph && inferenceUp) {
      const buffer = await fs.readFile(path.join(SAMPLES, ph.file));
      await ingestPhoto(pool, p, users.engineer, d, { buffer, tag: ph.tag });
    }
    prevDate = d;
  }
  const result = await recompute(pool, p, today());
  log('Seeded. Status:', JSON.stringify({ budget: result.metrics.budget.status, schedule: result.metrics.schedule.status, safety: result.safety.status }));
  return { project: p, users };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed({ reset: process.argv.includes('--reset') });
  console.log('\nDemo logins: see DEMO_USERS and DEMO_PASSWORD in apps/api/src/db/seed.js');
  await pool.end();
}
