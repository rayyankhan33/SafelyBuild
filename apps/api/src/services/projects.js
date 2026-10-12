// Project workflows that combine database access with the pure domain functions.
// Rule of thumb: SQL lives here and in routes; arithmetic lives in src/domain.
import { withTx } from '../db/pool.js';
import { bad, HttpError, notFound } from '../http.js';
import { estimate as runEstimate, validateElement } from '../domain/estimation.js';
import { generateSchedule } from '../domain/schedule.js';
import { diffDays, today } from '../domain/dates.js';

const num = (x) => (x === null || x === undefined ? x : Number(x));

// ------------------------------------------------------------------ reference data
export async function loadFactors(db) {
  const { rows } = await db.query('SELECT key, value FROM estimation_factors');
  return Object.fromEntries(rows.map((r) => [r.key, num(r.value)]));
}

/** Global price book (admin-maintained). Engineers cannot change prices. */
export async function loadRates(db) {
  const { rows } = await db.query('SELECT m.code, p.rate_pkr FROM price_book p JOIN material_catalog m ON m.id = p.material_id');
  return Object.fromEntries(rows.map((r) => [r.code, num(r.rate_pkr)]));
}

export async function setPriceBook(db, userId, rates) {
  const { rows: cat } = await db.query('SELECT id, code FROM material_catalog');
  const byCode = Object.fromEntries(cat.map((c) => [c.code, c.id]));
  for (const [code, rate] of Object.entries(rates)) {
    if (!byCode[code]) throw bad(`unknown material '${code}'`);
    await db.query(
      `INSERT INTO price_book (material_id, rate_pkr, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (material_id) DO UPDATE SET rate_pkr = EXCLUDED.rate_pkr, effective_from = CURRENT_DATE, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [byCode[code], rate, userId]);
  }
}

// ------------------------------------------------------------------ projects
export async function createProject(db, user, { name, location, description, start_date }) {
  return withTx(db, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO projects (org_id, name, location, description, start_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user.org_id, name, location ?? null, description ?? null, start_date, user.id]);
    const p = rows[0];
    await c.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, user.id]);
    return p;
  });
}

// ------------------------------------------------------------------ estimate
export async function createEstimate(db, project, userId, { contingency_pct = 0, activate = true }) {
  const { rows: elements } = await db.query('SELECT * FROM design_elements WHERE project_id = $1 ORDER BY created_at, label', [project.id]);
  if (!elements.length) throw bad('add design elements before estimating');
  const problems = elements.flatMap((e) => validateElement(numify(e)));
  if (problems.length) throw bad('design elements are incomplete', problems);
  const [factors, rates] = await Promise.all([loadFactors(db), loadRates(db)]);

  let result;
  try {
    result = runEstimate(elements.map(numify), factors, rates, contingency_pct);
  } catch (e) {
    if (e instanceof RangeError) throw bad(e.message);
    throw e;
  }
  const { rows: mat } = await db.query('SELECT id, code FROM material_catalog');
  const matId = Object.fromEntries(mat.map((m) => [m.code, m.id]));

  return withTx(db, async (c) => {
    const v = (await c.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM cost_estimates WHERE project_id = $1', [project.id])).rows[0].v;
    const est = (await c.query(
      `INSERT INTO cost_estimates (project_id, version, total_pkr, contingency_pct, factors_snapshot, warnings, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [project.id, v, result.total_pkr, contingency_pct,
        { factors, rates, mixes: result.mixes, compaction_factor_coarse: result.compaction_factor_coarse, excluded: result.excluded,
          per_element: result.perElement, by_material: result.byMaterial, subtotal_pkr: result.subtotal_pkr, contingency_pkr: result.contingency_pkr },
        JSON.stringify(result.warnings), userId])).rows[0];
    for (const l of result.lines) {
      await c.query(
        `INSERT INTO estimate_lines (estimate_id, element_id, material_id, quantity, unit, rate_pkr, cost_pkr)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [est.id, l.element_id, matId[l.material_code], l.quantity, l.unit, l.rate_pkr, l.cost_pkr]);
    }
    if (activate) await activateEstimate(c, project.id, est.id, result.total_pkr);
    return { ...est, is_active: activate, ...result };
  });
}

export async function activateEstimate(db, projectId, estimateId, total) {
  await db.query('UPDATE cost_estimates SET is_active = false WHERE project_id = $1', [projectId]);
  await db.query('UPDATE cost_estimates SET is_active = true WHERE id = $1 AND project_id = $2', [estimateId, projectId]);
  await db.query('UPDATE projects SET budget_pkr = $2 WHERE id = $1', [projectId, total]);
}

export async function getActiveEstimate(db, projectId) {
  const est = (await db.query('SELECT * FROM cost_estimates WHERE project_id = $1 AND is_active', [projectId])).rows[0];
  if (!est) return null;
  const { rows: lines } = await db.query(
    `SELECT l.element_id, m.code AS material_code, m.name AS material_name, l.quantity, l.unit, l.rate_pkr, l.cost_pkr
     FROM estimate_lines l JOIN material_catalog m ON m.id = l.material_id WHERE l.estimate_id = $1 ORDER BY m.id`, [est.id]);
  return { ...est, lines };
}

const numify = (e) => ({ ...e, length_m: num(e.length_m), width_m: num(e.width_m), height_m: num(e.height_m),
  thickness_m: num(e.thickness_m), rebar_kg_per_m3: num(e.rebar_kg_per_m3) });

// ------------------------------------------------------------------ schedule
export async function generateProjectSchedule(db, project, { crews, confirm_reset = false }) {
  const est = await getActiveEstimate(db, project.id);
  if (!est) throw bad('activate a cost estimate first: the schedule budget comes from it');
  const existing = (await db.query(
    'SELECT (SELECT count(*) FROM task_progress tp JOIN schedule_tasks t ON t.id = tp.task_id WHERE t.project_id = $1) AS n', [project.id])).rows[0].n;
  if (Number(existing) > 0 && !confirm_reset) {
    throw new HttpError(409, 'would_erase_progress', 'a schedule with recorded progress already exists; pass confirm_reset=true to replace it and erase that progress');
  }
  const { rows: elements } = await db.query('SELECT * FROM design_elements WHERE project_id = $1 ORDER BY created_at, label', [project.id]);
  const { rows: prod } = await db.query('SELECT * FROM productivity_rates');
  const factors = await loadFactors(db);
  const useCrews = crews ?? factors.crews ?? 1;
  const scale = 1 + Number(est.contingency_pct) / 100;
  const perElement = Object.fromEntries(
    Object.entries(est.factors_snapshot.per_element).map(([id, cost]) => [id, Math.round(cost * scale * 100) / 100]));

  let sched;
  try {
    sched = generateSchedule(elements.map(numify), prod.map((p) => ({ ...p, output_per_day: num(p.output_per_day) })), perElement, project.start_date, useCrews);
  } catch (e) {
    if (e instanceof RangeError) throw bad(e.message);
    throw e;
  }
  return withTx(db, async (c) => {
    await c.query('DELETE FROM schedule_tasks WHERE project_id = $1', [project.id]);
    const idBySeq = {};
    for (const t of sched.tasks) {
      const r = await c.query(
        `INSERT INTO schedule_tasks (project_id, element_id, name, seq, planned_start, planned_end, planned_cost_pkr)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [project.id, t.element_id, t.name, t.seq, t.planned_start, t.planned_end, t.planned_cost_pkr]);
      idBySeq[t.seq] = r.rows[0].id;
    }
    for (const d of sched.dependencies) {
      await c.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ($1,$2)', [idBySeq[d.seq], idBySeq[d.depends_on_seq]]);
    }
    await c.query('UPDATE projects SET planned_end_date = $2, status = $3 WHERE id = $1', [project.id, sched.planned_end, 'active']);
    return { ...sched, crews: useCrews };
  });
}

export async function getSchedule(db, projectId) {
  const { rows } = await db.query(
    `SELECT t.*, COALESCE((SELECT percent_complete FROM task_progress tp JOIN daily_logs l ON l.id = tp.daily_log_id
                           WHERE tp.task_id = t.id ORDER BY l.log_date DESC LIMIT 1), 0) AS percent_complete
     FROM schedule_tasks t WHERE t.project_id = $1 ORDER BY t.seq`, [projectId]);
  return rows;
}

// ------------------------------------------------------------------ site status (the only daily engineer input)
/** Crews on site and equipment available. Nothing about progress, materials, defects or hazards. */
export async function setSiteStatus(db, project, user, date, { crews, equipment }) {
  if (diffDays(date, today()) < 0) throw bad('date cannot be in the future');
  if (diffDays(project.start_date, date) < 0) throw bad(`date is before the project start (${project.start_date})`);
  const { rows } = await db.query(
    `INSERT INTO daily_logs (project_id, log_date, author_id, crews, equipment, site_status_by, site_status_at)
     VALUES ($1,$2,$3,$4,$5,$3,now())
     ON CONFLICT (project_id, log_date) DO UPDATE
       SET crews = EXCLUDED.crews, equipment = EXCLUDED.equipment, site_status_by = EXCLUDED.site_status_by, site_status_at = now()
     RETURNING log_date, crews, equipment, site_status_at`,
    [project.id, date, user.id, crews, JSON.stringify(equipment)]);
  return rows[0];
}

export async function listSiteStatus(db, projectId) {
  const { rows } = await db.query(
    `SELECT log_date, crews, equipment FROM daily_logs WHERE project_id = $1 AND crews IS NOT NULL ORDER BY log_date DESC LIMIT 120`, [projectId]);
  return rows;
}
