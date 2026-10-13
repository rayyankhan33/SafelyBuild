// Turn raw camera observations into the figures the dashboards use: task progress, material
// consumption and spend, and hazards. Everything is REPLAYED from the observations every time, so
// the result is identical however often it runs and cannot drift from the evidence. Nothing here
// reads human input.
import { dailyStock, inventoryHistory } from '../domain/inventory.js';
import { deriveHazards } from '../domain/risk.js';
import { progressHistory } from '../domain/stages.js';
import { loadRates } from './projects.js';

// Smallest increase in stock (per material) that can be read as a delivery rather than image noise.
const MIN_DELIVERY = { CEMENT: 20, SAND: 3, AGGREGATE: 3, BRICK: 500, REBAR: 100 };

export async function rebuild(db, project) {
  await rebuildProgress(db, project);
  await rebuildInventory(db, project);
  await rebuildHazards(db, project);
}

async function logIds(db, projectId, dates) {
  const ids = {};
  for (const d of dates) {
    const r = await db.query(
      `INSERT INTO daily_logs (project_id, log_date) VALUES ($1,$2)
       ON CONFLICT (project_id, log_date) DO UPDATE SET log_date = EXCLUDED.log_date RETURNING id`, [projectId, d]);
    ids[d] = r.rows[0].id;
  }
  return ids;
}

async function rebuildProgress(db, project) {
  const tasks = (await db.query(
    `SELECT t.id, t.element_id, e.element_type FROM schedule_tasks t JOIN design_elements e ON e.id = t.element_id WHERE t.project_id = $1`, [project.id])).rows;
  const obs = (await db.query(
    `SELECT o.element_id, o.observed_on, o.stage, o.fraction FROM stage_observations o JOIN cameras c ON c.id = o.camera_id WHERE c.project_id = $1`, [project.id])).rows;
  await db.query(
    `DELETE FROM task_progress WHERE source = 'image_stage' AND task_id IN (SELECT id FROM schedule_tasks WHERE project_id = $1)`, [project.id]);
  const rows = [];
  for (const t of tasks) {
    const mine = obs.filter((o) => o.element_id === t.element_id);
    if (!mine.length) continue;
    for (const h of progressHistory(t.element_type, mine)) if (h.percent > 0) rows.push({ task_id: t.id, ...h });
  }
  const ids = await logIds(db, project.id, [...new Set(rows.map((r) => r.date))]);
  for (const r of rows) {
    await db.query(
      `INSERT INTO task_progress (daily_log_id, task_id, percent_complete, source) VALUES ($1,$2,$3,'image_stage')
       ON CONFLICT (daily_log_id, task_id) DO UPDATE SET percent_complete = EXCLUDED.percent_complete, source = 'image_stage'`,
      [ids[r.date], r.task_id, r.percent]);
  }
}

async function rebuildInventory(db, project) {
  const obs = (await db.query(
    `SELECT o.camera_id, o.observed_on, m.code AS material_code, o.quantity, md.captured_at
     FROM inventory_observations o JOIN cameras c ON c.id = o.camera_id JOIN material_catalog m ON m.id = o.material_id
     JOIN inference_runs r ON r.id = o.inference_run_id JOIN media md ON md.id = r.media_id
     WHERE c.project_id = $1 ORDER BY o.observed_on`, [project.id])).rows;
  const byDate = new Map();
  for (const o of obs) {
    if (!byDate.has(o.observed_on)) byDate.set(o.observed_on, []);
    byDate.get(o.observed_on).push(o);
  }
  const days = [...byDate.keys()].sort().map((date) => ({ date, ...dailyStock(byDate.get(date)) }));
  const hist = inventoryHistory(days, MIN_DELIVERY);

  const cat = Object.fromEntries((await db.query('SELECT id, code FROM material_catalog')).rows.map((m) => [m.code, m.id]));
  const rates = await loadRates(db);
  // keep the price that applied when a day was first costed: later price-book changes must not rewrite history
  const prior = (await db.query(
    `SELECT l.log_date, m.code, u.rate_pkr FROM material_usage u JOIN daily_logs l ON l.id = u.daily_log_id JOIN material_catalog m ON m.id = u.material_id
     WHERE l.project_id = $1 AND u.source = 'image_estimate'`, [project.id])).rows;
  const priorRate = Object.fromEntries(prior.map((r) => [`${r.log_date}|${r.code}`, Number(r.rate_pkr)]));

  await db.query('DELETE FROM inventory_daily WHERE project_id = $1', [project.id]);
  await db.query(`DELETE FROM material_usage WHERE source = 'image_estimate' AND daily_log_id IN (SELECT id FROM daily_logs WHERE project_id = $1)`, [project.id]);
  const ids = await logIds(db, project.id, days.map((d) => d.date));
  for (const h of hist) {
    await db.query(
      `INSERT INTO inventory_daily (project_id, observed_on, material_id, start_qty, stock_qty, used_qty, delivered_qty) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [project.id, h.date, cat[h.material_code], round3(h.start), round3(h.end), round3(h.used), round3(h.delivered)]);
    if (h.used > 0) {
      const rate = priorRate[`${h.date}|${h.material_code}`] ?? rates[h.material_code] ?? 0;
      await db.query(
        `INSERT INTO material_usage (daily_log_id, material_id, quantity, rate_pkr, cost_pkr, source, confidence) VALUES ($1,$2,$3,$4,$5,'image_estimate',0.5)`,
        [ids[h.date], cat[h.material_code], round3(h.used), rate, Math.round(h.used * rate * 100) / 100]);
    }
  }
}

async function rebuildHazards(db, project) {
  const lib = Object.fromEntries((await db.query('SELECT * FROM hazard_library')).rows.map((l) => [l.code, l]));
  const defects = (await db.query(
    `SELECT d.id, m.camera_id, d.defect_type, d.detected_on, d.score, d.severity, d.is_violation
     FROM defects d JOIN media m ON m.id = d.media_id WHERE d.project_id = $1 AND m.camera_id IS NOT NULL`, [project.id])).rows;
  const inspections = (await db.query(
    `SELECT m.camera_id, l.log_date AS date FROM inference_runs r JOIN media m ON m.id = r.media_id JOIN daily_logs l ON l.id = m.daily_log_id
     WHERE m.project_id = $1 AND m.camera_id IS NOT NULL AND r.kind = 'defects' AND r.status = 'succeeded'`, [project.id])).rows;
  const derived = deriveHazards(defects, inspections, lib);
  await db.query('DELETE FROM hazards WHERE project_id = $1', [project.id]);
  for (const h of derived) {
    await db.query(
      `INSERT INTO hazards (project_id, library_id, defect_id, camera_id, source, category, title, notes, likelihood, severity, status, identified_on, closed_on, clean_days, last_clean_on)
       VALUES ($1,$2,$3,$4,'auto_defect',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [project.id, h.library_id, h.defect_id, h.camera_id, h.category, h.title, h.notes, h.likelihood, h.severity, h.status, h.identified_on, h.closed_on, h.clean_days, h.last_clean_on]);
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;
