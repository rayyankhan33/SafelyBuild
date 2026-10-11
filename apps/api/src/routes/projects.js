import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  audit, bad, isoDate, notFound, parse, projectAccess, requireAuth, requireRole, uuid, wrap,
} from '../http.js';
import { today } from '../domain/dates.js';
import * as storage from '../storage.js';
import { ingestPhoto } from '../services/media.js';
import { buildDashboard, recompute } from '../services/forecast.js';
import {
  createEstimate, createProject, generateProjectSchedule, getActiveEstimate, getLog, getSchedule, loadRates, setRates, upsertLog,
} from '../services/projects.js';

export const router = Router();
router.use(requireAuth);

const read = projectAccess();
const write = projectAccess({ write: true });
const staff = requireRole('admin', 'engineer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 10 } });

// ------------------------------------------------------------------ projects
router.get('/projects', wrap(async (req, res) => {
  const where = req.user.role === 'admin' ? 'p.org_id = $1' : 'p.org_id = $1 AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2)';
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.location, p.status, p.start_date, p.planned_end_date, p.budget_pkr FROM projects p
     WHERE ${where} ORDER BY p.created_at DESC`, req.user.role === 'admin' ? [req.user.org_id] : [req.user.org_id, req.user.id]);
  res.json({ projects: rows });
}));

const newProject = z.object({
  name: z.string().min(2).max(160), location: z.string().max(200).optional(), description: z.string().max(2000).optional(), start_date: isoDate,
});
router.post('/projects', staff, wrap(async (req, res) => {
  const p = await createProject(pool, req.user, parse(newProject, req.body));
  await audit(pool, { ...req, project: p }, 'create', 'project', p.id);
  res.status(201).json({ project: p });
}));

router.get('/projects/:pid', read, (req, res) => res.json({ project: req.project }));

router.post('/projects/:pid/members', requireRole('admin'), read, wrap(async (req, res) => {
  const { user_id } = parse(z.object({ user_id: uuid }), req.body);
  const u = (await pool.query('SELECT id FROM users WHERE id = $1 AND org_id = $2', [user_id, req.user.org_id])).rows[0];
  if (!u) throw notFound('user');
  await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.project.id, user_id]);
  await audit(pool, req, 'add_member', 'project', req.project.id, { user_id });
  res.status(201).json({ ok: true });
}));

router.get('/projects/:pid/members', write, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.pec_number FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.role, u.full_name`,
    [req.project.id]);
  res.json({ members: rows });
}));

// ------------------------------------------------------------------ rates
router.get('/projects/:pid/rates', write, wrap(async (req, res) => res.json({ rates: await loadRates(pool, req.project.id), currency: 'PKR' })));
router.put('/projects/:pid/rates', write, wrap(async (req, res) => {
  const rates = parse(z.record(z.enum(['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK']), z.number().min(0).max(10_000_000)), req.body);
  await setRates(pool, req.project.id, rates);
  await audit(pool, req, 'update', 'rates', null, rates);
  res.json({ rates: await loadRates(pool, req.project.id) });
}));

// ------------------------------------------------------------------ design elements (BOQ)
const dim = z.number().positive().max(1000);
const elementSchema = z.object({
  label: z.string().min(1).max(80),
  element_type: z.enum(['footing', 'column', 'beam', 'slab', 'masonry_wall']),
  quantity: z.number().int().positive().max(10_000).default(1),
  length_m: dim, width_m: dim.optional(), height_m: dim.optional(), thickness_m: dim.optional(),
  concrete_fc_mpa: z.number().int().min(15).max(60).optional(),
  rebar_kg_per_m3: z.number().min(0).max(500).optional(),
});
router.get('/projects/:pid/elements', write, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM design_elements WHERE project_id = $1 ORDER BY created_at, label', [req.project.id]);
  res.json({ elements: rows });
}));
router.post('/projects/:pid/elements', write, wrap(async (req, res) => {
  const items = parse(z.array(elementSchema).min(1).max(500), Array.isArray(req.body) ? req.body : [req.body]);
  const { validateElement } = await import('../domain/estimation.js');
  const problems = items.flatMap((e) => validateElement(e));
  if (problems.length) throw bad('some elements are incomplete', problems);
  const out = [];
  for (const e of items) {
    const { rows } = await pool.query(
      `INSERT INTO design_elements (project_id, label, element_type, quantity, length_m, width_m, height_m, thickness_m, concrete_fc_mpa, rebar_kg_per_m3)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.project.id, e.label, e.element_type, e.quantity, e.length_m, e.width_m ?? null, e.height_m ?? null, e.thickness_m ?? null, e.concrete_fc_mpa ?? null, e.rebar_kg_per_m3 ?? null]);
    out.push(rows[0]);
  }
  await audit(pool, req, 'create', 'design_elements', null, { count: out.length });
  res.status(201).json({ elements: out });
}));
router.delete('/projects/:pid/elements/:eid', write, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.eid).success) throw notFound('element');
  const r = await pool.query('DELETE FROM design_elements WHERE id = $1 AND project_id = $2', [req.params.eid, req.project.id]);
  if (!r.rowCount) throw notFound('element');
  await audit(pool, req, 'delete', 'design_element', req.params.eid);
  res.json({ ok: true, note: 'Re-run the estimate and regenerate the schedule to reflect this change.' });
}));

// ------------------------------------------------------------------ estimate
router.post('/projects/:pid/estimates', write, wrap(async (req, res) => {
  const b = parse(z.object({ contingency_pct: z.number().min(0).max(50).default(5), activate: z.boolean().default(true) }), req.body ?? {});
  const est = await createEstimate(pool, req.project, req.user.id, b);
  await audit(pool, req, 'create', 'estimate', est.id, { total_pkr: est.total_pkr, activate: b.activate });
  res.status(201).json({ estimate: est });
}));
router.get('/projects/:pid/estimates/active', write, wrap(async (req, res) => {
  const est = await getActiveEstimate(pool, req.project.id);
  if (!est) throw notFound('active estimate');
  res.json({ estimate: est });
}));

// ------------------------------------------------------------------ schedule
router.post('/projects/:pid/schedule/generate', write, wrap(async (req, res) => {
  const b = parse(z.object({ crews: z.number().int().min(1).max(20).optional(), confirm_reset: z.boolean().optional() }), req.body ?? {});
  const s = await generateProjectSchedule(pool, req.project, b);
  await audit(pool, req, 'generate', 'schedule', null, { tasks: s.tasks.length, planned_end: s.planned_end });
  res.status(201).json({ schedule: s });
}));
router.get('/projects/:pid/schedule', read, wrap(async (req, res) => res.json({ tasks: await getSchedule(pool, req.project.id) })));

// ------------------------------------------------------------------ daily logs
const logSchema = z.object({
  workers_present: z.number().int().min(0).max(100_000).optional(),
  weather: z.string().max(80).optional(), notes: z.string().max(4000).optional(),
  progress: z.array(z.object({ task_id: uuid, percent: z.number().min(0).max(100) })).optional(),
  materials: z.array(z.object({
    material_code: z.enum(['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK']), quantity: z.number().min(0).max(1e9),
    source: z.enum(['manual', 'ai_confirmed', 'ai_simulated']).optional(), confidence: z.number().min(0).max(1).optional(), media_id: uuid.optional(),
  })).optional(),
});
router.put('/projects/:pid/logs/:date', write, wrap(async (req, res) => {
  const date = parse(isoDate, req.params.date);
  const log = await upsertLog(pool, req.project, req.user, date, parse(logSchema, req.body ?? {}));
  await audit(pool, req, 'upsert', 'daily_log', log.id, { date });
  const forecast = await recompute(pool, req.project, today());
  res.json({ log: await getLog(pool, req.project.id, date), status: forecast.ready ? { budget: forecast.metrics.budget.status, schedule: forecast.metrics.schedule.status, safety: forecast.safety.status } : null });
}));
router.get('/projects/:pid/logs', read, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.log_date, l.workers_present, l.weather, l.notes,
            COALESCE((SELECT sum(cost_pkr) FROM material_usage u WHERE u.daily_log_id = l.id),0) AS spend_pkr,
            (SELECT count(*) FROM media m WHERE m.daily_log_id = l.id)::int AS photos
     FROM daily_logs l WHERE l.project_id = $1 ORDER BY l.log_date DESC LIMIT 200`, [req.project.id]);
  res.json({ logs: rows });
}));
router.get('/projects/:pid/logs/:date', write, wrap(async (req, res) => res.json({ log: await getLog(pool, req.project.id, parse(isoDate, req.params.date)) })));

// ------------------------------------------------------------------ photos
router.post('/projects/:pid/logs/:date/media', write, upload.array('files', 10), wrap(async (req, res) => {
  const date = parse(isoDate, req.params.date);
  if (!req.files?.length) throw bad("attach at least one image in the 'files' field");
  const tag = req.body.tag || 'general';
  const results = [];
  for (const f of req.files) {
    results.push(await ingestPhoto(pool, req.project, req.user, date, {
      buffer: f.buffer, tag, latitude: req.body.latitude ? Number(req.body.latitude) : null, longitude: req.body.longitude ? Number(req.body.longitude) : null,
    }));
  }
  await audit(pool, req, 'upload', 'media', null, { count: results.length, tag, date });
  const forecast = await recompute(pool, req.project, today());
  res.status(201).json({ uploads: results, safety: forecast.ready ? forecast.safety : null });
}));

router.get('/media/:id/file', wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound('media');
  const m = (await pool.query(
    `SELECT m.* FROM media m JOIN projects p ON p.id = m.project_id WHERE m.id = $1 AND p.org_id = $2`, [req.params.id, req.user.org_id])).rows[0];
  if (!m) throw notFound('media');
  if (req.user.role !== 'admin') {
    const ok = await pool.query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [m.project_id, req.user.id]);
    if (!ok.rowCount) throw notFound('media');
  }
  const bytes = await storage.read(m.storage_key); // read first: an error must not carry cache headers
  res.set('Content-Type', m.content_type).set('Cache-Control', 'private, max-age=3600').send(bytes);
}));

// ------------------------------------------------------------------ hazards
router.get('/hazard-library', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT id, code, category, title, description, default_likelihood, default_severity FROM hazard_library ORDER BY category, title');
  res.json({ library: rows });
}));
const hazardSchema = z.object({
  library_id: z.number().int().positive().optional(), title: z.string().min(2).max(160).optional(), category: z.string().min(2).max(80).optional(),
  likelihood: z.number().int().min(1).max(5), severity: z.number().int().min(1).max(5), notes: z.string().max(2000).optional(),
});
router.post('/projects/:pid/hazards', write, wrap(async (req, res) => {
  const b = parse(hazardSchema, req.body);
  let { title, category } = b;
  if (b.library_id) {
    const lib = (await pool.query('SELECT category, title FROM hazard_library WHERE id = $1', [b.library_id])).rows[0];
    if (!lib) throw bad('unknown hazard library entry');
    title = title ?? lib.title; category = category ?? lib.category;
  }
  if (!title || !category) throw bad('give a title and category, or pick a library entry');
  const { rows } = await pool.query(
    `INSERT INTO hazards (project_id, library_id, source, category, title, notes, likelihood, severity, identified_on, created_by)
     VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.project.id, b.library_id ?? null, category, title, b.notes ?? null, b.likelihood, b.severity, today(), req.user.id]);
  await audit(pool, req, 'create', 'hazard', rows[0].id, { title });
  await recompute(pool, req.project, today());
  res.status(201).json({ hazard: rows[0] });
}));
router.patch('/projects/:pid/hazards/:hid', write, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.hid).success) throw notFound('hazard');
  const b = parse(z.object({
    status: z.enum(['open', 'mitigating', 'closed']).optional(), likelihood: z.number().int().min(1).max(5).optional(),
    severity: z.number().int().min(1).max(5).optional(), notes: z.string().max(2000).optional(),
  }), req.body);
  const { rows } = await pool.query(
    `UPDATE hazards SET status = COALESCE($3, status), likelihood = COALESCE($4, likelihood), severity = COALESCE($5, severity), notes = COALESCE($6, notes)
     WHERE id = $1 AND project_id = $2 RETURNING *`, [req.params.hid, req.project.id, b.status ?? null, b.likelihood ?? null, b.severity ?? null, b.notes ?? null]);
  if (!rows[0]) throw notFound('hazard');
  await audit(pool, req, 'update', 'hazard', rows[0].id, b);
  await recompute(pool, req.project, today());
  res.json({ hazard: rows[0] });
}));

// ------------------------------------------------------------------ dashboard, alerts, audit
router.get('/projects/:pid/dashboard', read, wrap(async (req, res) => {
  const asOf = req.query.as_of ? parse(isoDate, req.query.as_of) : today();
  res.json(await buildDashboard(pool, req.project, req.user.role, asOf));
}));
router.post('/projects/:pid/alerts/:aid/ack', write, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.aid).success) throw notFound('alert');
  const r = await pool.query('UPDATE alerts SET acknowledged_by = $3, acknowledged_at = now() WHERE id = $1 AND project_id = $2', [req.params.aid, req.project.id, req.user.id]);
  if (!r.rowCount) throw notFound('alert');
  await audit(pool, req, 'acknowledge', 'alert', req.params.aid);
  res.json({ ok: true });
}));
router.get('/projects/:pid/audit', write, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 200`, [req.project.id]);
  res.json({ audit: rows });
}));

