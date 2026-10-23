import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import {
  audit, bad, isoDate, notFound, parse, projectAccess, requireAuth, requireRole, uuid, wrap,
} from '../http.js';
import { config } from '../config.js';
import { today } from '../domain/dates.js';
import { validateElement } from '../domain/estimation.js';
import * as storage from '../storage.js';
import { buildDashboard, recompute } from '../services/forecast.js';
import { createCamera, listCameras, setCameraActive } from '../services/ingest.js';
import { listNotifications, markAllRead, markRead } from '../services/notifications.js';
import * as testfootage from '../services/testfootage.js';
import {
  createEstimate, createProject, generateProjectSchedule, getActiveEstimate, getCostRates, setCostRates, getSchedule, listSiteStatus, loadRates, setPriceBook, setSiteStatus,
} from '../services/projects.js';

export const router = Router();
router.use(requireAuth);

// What each role may do (see docs/design.md section 10). The roles do not overlap:
//   investor  read-only: plain-language progress, money, schedule, safety and photos
//   engineer  creates projects; BOQ and budget, schedule, crews and equipment; reads technical status, risk and
//             evidence health; the temporary test-footage tool. Cannot install cameras, edit prices or manage people.
//   admin     does NOT create projects (is notified when one is created) and cannot enter project content;
//             manages users (incl. deleting accounts), project access, cameras, the price book and reads the audit log
const read = projectAccess();
const staff = projectAccess({ write: true });
const engineerOnly = requireRole('engineer');
const eng = [engineerOnly, read];            // engineer writes: role first, then project membership
const adminOnly = requireRole('admin');

// ------------------------------------------------------------------ projects
router.get('/projects', wrap(async (req, res) => {
  const where = req.user.role === 'admin' ? 'p.org_id = $1' : 'p.org_id = $1 AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2)';
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.location, p.status, p.start_date, p.planned_end_date, p.budget_pkr, p.is_demo FROM projects p
     WHERE ${where} ORDER BY p.created_at DESC`, req.user.role === 'admin' ? [req.user.org_id] : [req.user.org_id, req.user.id]);
  res.json({ projects: rows });
}));

const newProject = z.object({
  name: z.string().min(2).max(160), location: z.string().max(200).optional(), description: z.string().max(2000).optional(), start_date: isoDate,
});
router.post('/projects', engineerOnly, wrap(async (req, res) => {
  const p = await createProject(pool, req.user, parse(newProject, req.body));
  await audit(pool, { ...req, project: p }, 'create', 'project', p.id);
  res.status(201).json({ project: p });
}));

router.get('/projects/:pid', read, (req, res) => res.json({ project: req.project }));

router.post('/projects/:pid/members', adminOnly, read, wrap(async (req, res) => {
  const { user_id } = parse(z.object({ user_id: uuid }), req.body);
  const u = (await pool.query('SELECT id FROM users WHERE id = $1 AND org_id = $2', [user_id, req.user.org_id])).rows[0];
  if (!u) throw notFound('user');
  await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.project.id, user_id]);
  await audit(pool, req, 'add_member', 'project', req.project.id, { user_id });
  res.status(201).json({ ok: true });
}));

router.delete('/projects/:pid/members/:uid', adminOnly, read, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.uid).success) throw notFound('member');
  const r = await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [req.project.id, req.params.uid]);
  if (!r.rowCount) throw notFound('member');
  await audit(pool, req, 'remove_member', 'project', req.project.id, { user_id: req.params.uid });
  res.json({ ok: true });
}));

router.get('/projects/:pid/members', adminOnly, read, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.pec_number FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.role, u.full_name`,
    [req.project.id]);
  res.json({ members: rows });
}));

// ------------------------------------------------------------------ notifications (each user sees only their own)
router.get('/notifications', wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  res.json(await listNotifications(pool, req.user.id, { limit }));
}));
router.post('/notifications/read-all', wrap(async (req, res) => res.json({ marked: await markAllRead(pool, req.user.id) })));
router.post('/notifications/:id/read', wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound('notification');
  await markRead(pool, req.user.id, req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ price book (admin only)
router.get('/price-book', requireRole('engineer', 'admin'), wrap(async (_req, res) => res.json({ rates: await loadRates(pool), currency: 'PKR' })));
router.put('/price-book', adminOnly, wrap(async (req, res) => {
  const rates = parse(z.record(z.enum(['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK']), z.number().min(0).max(10_000_000)), req.body);
  await setPriceBook(pool, req.user.id, rates);
  await audit(pool, req, 'update', 'price_book', null, rates);
  res.json({ rates: await loadRates(pool) });
}));

// ------------------------------------------------------------------ design elements (BOQ): engineer input
const dim = z.number().positive().max(1000);
const elementSchema = z.object({
  label: z.string().min(1).max(80),
  element_type: z.enum(['footing', 'column', 'beam', 'slab', 'masonry_wall']),
  quantity: z.number().int().positive().max(10_000).default(1),
  length_m: dim, width_m: dim.optional(), height_m: dim.optional(), thickness_m: dim.optional(),
  concrete_fc_mpa: z.number().int().min(15).max(60).optional(),
  rebar_kg_per_m3: z.number().min(0).max(500).optional(),
});
router.get('/projects/:pid/elements', staff, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM design_elements WHERE project_id = $1 ORDER BY created_at, label', [req.project.id]);
  res.json({ elements: rows });
}));
router.post('/projects/:pid/elements', eng, wrap(async (req, res) => {
  const items = parse(z.array(elementSchema).min(1).max(500), Array.isArray(req.body) ? req.body : [req.body]);
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
router.delete('/projects/:pid/elements/:eid', eng, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.eid).success) throw notFound('element');
  const r = await pool.query('DELETE FROM design_elements WHERE id = $1 AND project_id = $2', [req.params.eid, req.project.id]);
  if (!r.rowCount) throw notFound('element');
  await audit(pool, req, 'delete', 'design_element', req.params.eid);
  res.json({ ok: true, note: 'Re-run the estimate and regenerate the schedule to reflect this change.' });
}));

// ------------------------------------------------------------------ estimate (initial budget): engineer input
router.post('/projects/:pid/estimates', eng, wrap(async (req, res) => {
  const b = parse(z.object({ contingency_pct: z.number().min(0).max(50).default(5), activate: z.boolean().default(true) }), req.body ?? {});
  const est = await createEstimate(pool, req.project, req.user.id, b);
  await audit(pool, req, 'create', 'estimate', est.id, { total_pkr: est.total_pkr, activate: b.activate });
  res.status(201).json({ estimate: est });
}));
router.get('/projects/:pid/estimates/active', staff, wrap(async (req, res) => {
  const est = await getActiveEstimate(pool, req.project.id);
  if (!est) throw notFound('active estimate');
  res.json({ estimate: est });
}));

// ------------------------------------------------------------------ labour, equipment and overheads: entered once, then locked
const costRatesSchema = z.object({
  crew_rate_pkr: z.number().min(0).max(10_000_000),
  overhead_pct: z.number().min(0).max(100),
  equipment: z.array(z.object({ type: z.string().min(1).max(80), rate_pkr: z.number().min(0).max(100_000_000), planned_units: z.number().int().min(0).max(1000) }).strict()).max(30).default([]),
}).strict();
router.post('/projects/:pid/cost-rates', eng, wrap(async (req, res) => {
  const rates = await setCostRates(pool, req.project, req.user, parse(costRatesSchema, req.body ?? {}));
  await audit(pool, req, 'create', 'cost_rates', req.project.id, { crew_rate_pkr: rates.crew_rate_pkr, overhead_pct: rates.overhead_pct, equipment: rates.equipment.length });
  res.status(201).json({ rates, note: 'Rates are now locked. Regenerate the schedule so the baseline budget includes labour, equipment and overheads.' });
}));
router.get('/projects/:pid/cost-rates', staff, wrap(async (req, res) => res.json({ rates: await getCostRates(pool, req.project.id) })));

// ------------------------------------------------------------------ schedule
router.post('/projects/:pid/schedule/generate', eng, wrap(async (req, res) => {
  const b = parse(z.object({ crews: z.number().int().min(1).max(20).optional(), confirm_reset: z.boolean().optional() }), req.body ?? {});
  const s = await generateProjectSchedule(pool, req.project, b);
  await audit(pool, req, 'generate', 'schedule', null, { tasks: s.tasks.length, planned_end: s.planned_end });
  res.status(201).json({ schedule: s });
}));
router.get('/projects/:pid/schedule', read, wrap(async (req, res) => res.json({ tasks: await getSchedule(pool, req.project.id) })));

// ------------------------------------------------------------------ site status: crews and equipment, nothing else
const siteStatusSchema = z.object({
  crews: z.number().int().min(0).max(500),
  equipment: z.array(z.object({ type: z.string().min(1).max(80), count: z.number().int().min(0).max(1000) })).max(50).default([]),
}).strict();
router.put('/projects/:pid/site-status/:date', eng, wrap(async (req, res) => {
  const date = parse(isoDate, req.params.date);
  const body = parse(siteStatusSchema, req.body ?? {});
  const row = await setSiteStatus(pool, req.project, req.user, date, body);
  await audit(pool, req, 'set', 'site_status', date, body);
  await recompute(pool, req.project, today());
  res.json({ site_status: row });
}));
router.get('/projects/:pid/site-status', staff, wrap(async (req, res) => res.json({ site_status: await listSiteStatus(pool, req.project.id) })));

// ------------------------------------------------------------------ cameras (admin installs; engineers can see health)
const cameraSchema = z.object({
  name: z.string().min(2).max(80), kind: z.enum(['zone', 'yard', 'overview']),
  element_id: uuid.optional(), scale_m_per_px: z.number().positive().max(10).optional(),
  expected_frames_per_day: z.number().int().min(1).max(1000).optional(), detect_defects: z.boolean().optional(),
});
router.get('/projects/:pid/cameras', staff, wrap(async (req, res) => res.json({ cameras: await listCameras(pool, req.project.id) })));
router.post('/projects/:pid/cameras', adminOnly, read, wrap(async (req, res) => {
  const out = await createCamera(pool, req.project, req.user, parse(cameraSchema, req.body));
  await audit(pool, req, 'create', 'camera', out.camera.id, { name: out.camera.name, kind: out.camera.kind });
  res.status(201).json({ ...out, note: 'Store this key now. It is shown only once and cannot be recovered.' });
}));
router.patch('/projects/:pid/cameras/:cid', adminOnly, read, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.cid).success) throw notFound('camera');
  const { active } = parse(z.object({ active: z.boolean() }), req.body);
  await setCameraActive(pool, req.project.id, req.params.cid, active);
  await audit(pool, req, active ? 'enable' : 'disable', 'camera', req.params.cid);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ frames (read only)
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

// ------------------------------------------------------------------ TEMPORARY: test footage (docs/temporary-features.md)
// Sandbox for trying the vision model on uploaded footage. Results never enter progress, spend, hazards or forecasts.
const uploadDir = path.join(os.tmpdir(), 'safelybuild-uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const footageUpload = multer({ dest: uploadDir, limits: { fileSize: config.testUploadMaxBytes, files: 1 } });

router.get('/test-footage/defaults', engineerOnly, wrap(async (_req, res) => res.json(await testfootage.getDefaults())));
router.get('/projects/:pid/test-runs', eng, wrap(async (req, res) => res.json({ runs: await testfootage.listRuns(pool, req.project.id) })));
router.post('/projects/:pid/test-runs', eng, footageUpload.single('file'), wrap(async (req, res) => {
  const tmp = req.file?.path;
  try {
    if (!req.file) throw bad("attach a video or image in the 'file' field");
    const type = testfootage.sniffFootageType(await testfootage.readHead(tmp));
    if (!type) throw bad('unsupported file: upload an MP4/MOV, AVI or WebM/MKV video, or a JPEG, PNG, WebP or BMP image');
    const params = testfootage.validateParams(req.body ?? {});
    const run = await testfootage.startRun(pool, req.project, req.user, { tmpPath: tmp, filename: req.file.originalname || 'upload', size: req.file.size, params });
    await audit(pool, req, 'upload', 'test_footage', run.id, { filename: req.file.originalname, bytes: req.file.size });
    res.status(202).json({ run });
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { force: true }); // startRun removes it too; this covers failures before it
    throw e;
  }
}));
router.get('/projects/:pid/test-runs/:rid', eng, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.rid).success) throw notFound('test run');
  res.json({ run: await testfootage.getRun(pool, req.project.id, req.params.rid) });
}));
router.delete('/projects/:pid/test-runs/:rid', eng, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.rid).success) throw notFound('test run');
  const run = await testfootage.deleteRun(pool, req.project.id, req.params.rid);
  await audit(pool, req, 'delete', 'test_footage', run.id, { filename: run.filename });
  res.json({ ok: true });
}));
router.get('/test-frames/:id/image', engineerOnly, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound('frame');
  const bytes = await testfootage.frameImage(pool, req.user, req.params.id);
  res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=3600').send(bytes);
}));

// ------------------------------------------------------------------ dashboard, alerts, audit
router.get('/projects/:pid/dashboard', read, wrap(async (req, res) => {
  const asOf = req.query.as_of ? parse(isoDate, req.query.as_of) : today();
  res.json(await buildDashboard(pool, req.project, req.user.role, asOf));
}));
router.post('/projects/:pid/alerts/:aid/ack', eng, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.aid).success) throw notFound('alert');
  const r = await pool.query('UPDATE alerts SET acknowledged_by = $3, acknowledged_at = now() WHERE id = $1 AND project_id = $2', [req.params.aid, req.project.id, req.user.id]);
  if (!r.rowCount) throw notFound('alert');
  await audit(pool, req, 'acknowledge', 'alert', req.params.aid);
  res.json({ ok: true });
}));
router.get('/projects/:pid/audit', adminOnly, read, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, COALESCE(u.full_name, a.actor_label) AS full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 200`, [req.project.id]);
  res.json({ audit: rows });
}));
