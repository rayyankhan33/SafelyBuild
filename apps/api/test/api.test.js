// Integration tests: real Express app + real PostgreSQL (database safelybuild_test) + fake inference.
// Covers the automated-evidence design: engineers enter only BOQ/budget, crews and equipment;
// everything else arrives from cameras (TC-API-*, see docs/srs.md).
import { startFakeInference } from './env.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fake = await startFakeInference();
const { pool } = await import('../src/db/pool.js');
const { resetDatabase } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/http.js');
const { addDays, today } = await import('../src/domain/dates.js');
const { authenticateCamera, ingestFrame } = await import('../src/services/ingest.js');
const { rebuild } = await import('../src/services/rollup.js');
const footageSvc = await import('../src/services/testfootage.js');

const PW = 'Test-Password-1';
let server, base;
const tokens = {};
let projectId; let taskIds = []; let elements = {};
let zoneKey; let yardKey; let gateKey;

async function api(method, path, { token, body, form, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const login = (email, password = PW) => api('POST', '/api/auth/login', { body: { email, password } });
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1500)]); // unique bytes each call

function frameForm(buf, capturedAt) {
  const f = new FormData();
  f.append('image', new Blob([buf], { type: 'image/jpeg' }), 'f.jpg');
  if (capturedAt !== undefined) f.append('captured_at', capturedAt);
  return f;
}
const ingest = (key, { buf = jpeg(), at = new Date().toISOString(), token } = {}) =>
  api('POST', '/api/ingest/frame', { form: frameForm(buf, at), headers: key ? { 'x-camera-key': key } : {}, token });
const dash = (token, id = projectId) => api('GET', `/api/projects/${id}/dashboard`, { token }).then((r) => r.body);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

before(async () => {
  await resetDatabase(pool);
  const org = (await pool.query("INSERT INTO organizations (name) VALUES ('Org A') RETURNING id")).rows[0];
  const org2 = (await pool.query("INSERT INTO organizations (name) VALUES ('Org B') RETURNING id")).rows[0];
  const mk = async (orgId, email, role) => (await pool.query(
    'INSERT INTO users (org_id, email, password_hash, full_name, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orgId, email, await hashPassword(PW), email, role])).rows[0].id;
  await mk(org.id, 'admin@a.test', 'admin');
  await mk(org.id, 'eng@a.test', 'engineer');
  await mk(org.id, 'eng2@a.test', 'engineer');
  await mk(org.id, 'inv@a.test', 'investor');
  await mk(org2.id, 'eng@b.test', 'engineer');
  await pool.query("INSERT INTO users (org_id, email, password_hash, full_name, role, is_active) VALUES ($1,'off@a.test',$2,'off','engineer',false)", [org.id, await hashPassword(PW)]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, e] of [['admin', 'admin@a.test'], ['eng', 'eng@a.test'], ['eng2', 'eng2@a.test'], ['inv', 'inv@a.test'], ['engB', 'eng@b.test']]) {
    tokens[k] = (await login(e)).body.token;
  }
});
after(async () => {
  server.close();
  await fake.close();
  await pool.end();
});

describe('authentication (TC-API-AUTH)', () => {
  test('valid login returns token and user without password hash', async () => {
    const r = await login('eng@a.test');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'engineer');
    assert.ok(!('password_hash' in r.body.user));
  });
  test('wrong password and unknown user give the same 401 message', async () => {
    const a = await login('eng@a.test', 'nope');
    const b = await login('ghost@a.test', 'nope');
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.body.error.message, b.body.error.message);
  });
  test('missing or garbage token is rejected', async () => {
    assert.equal((await api('GET', '/api/projects')).status, 401);
    assert.equal((await api('GET', '/api/projects', { token: 'abc.def.ghi' })).status, 401);
  });
  test('disabled account cannot log in', async () => assert.equal((await login('off@a.test')).status, 401));
  test('repeated failures are rate limited', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await login('inv@a.test', 'bad');
    assert.equal(last.status, 429);
    assert.equal((await login('inv@a.test')).status, 429);
  });
  test('only admins can create users; short passwords refused; duplicates conflict', async () => {
    const body = { email: 'new@a.test', full_name: 'New', role: 'engineer', password: 'LongEnough1' };
    assert.equal((await api('POST', '/api/users', { token: tokens.eng, body })).status, 403);
    assert.equal((await api('POST', '/api/users', { token: tokens.admin, body: { ...body, password: 'short' } })).status, 422);
    assert.equal((await api('POST', '/api/users', { token: tokens.admin, body })).status, 201);
    assert.equal((await api('POST', '/api/users', { token: tokens.admin, body })).status, 409);
  });
});

describe('engineer inputs: BOQ, budget, schedule (TC-API-SETUP)', () => {
  test('engineer creates the project; investor cannot', async () => {
    const start = addDays(today(), -10);
    assert.equal((await api('POST', '/api/projects', { token: tokens.inv, body: { name: 'X', start_date: start } })).status, 403);
    assert.equal((await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'X', start_date: 'tomorrow' } })).status, 422);
    const r = await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'Test Block', location: 'Islamabad', start_date: start } });
    assert.equal(r.status, 201);
    projectId = r.body.project.id;
    const inv = (await pool.query("SELECT id FROM users WHERE email = 'inv@a.test'")).rows[0].id;
    await pool.query('INSERT INTO project_members VALUES ($1,$2)', [projectId, inv]);
  });
  test('estimate before any elements is refused', async () => {
    const r = await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: {} });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /add design elements/);
  });
  test('invalid elements are rejected with field-level reasons', async () => {
    const r = await api('POST', `/api/projects/${projectId}/elements`, { token: tokens.eng, body: { label: 'S', element_type: 'slab', length_m: 10, width_m: 5 } });
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(r.body.error.details), /thickness_m/);
    const neg = await api('POST', `/api/projects/${projectId}/elements`, { token: tokens.eng, body: { label: 'S', element_type: 'slab', length_m: -1, width_m: 5, thickness_m: 0.1, concrete_fc_mpa: 25 } });
    assert.equal(neg.status, 422);
  });
  test('valid BOQ -> estimate -> activated budget -> schedule whose task budgets add up', async () => {
    const els = [
      { label: 'Footings', element_type: 'footing', quantity: 20, length_m: 1.5, width_m: 1.5, height_m: 0.5, concrete_fc_mpa: 25 },
      { label: 'Slab', element_type: 'slab', quantity: 1, length_m: 20, width_m: 15, thickness_m: 0.15, concrete_fc_mpa: 25 },
    ];
    const made = await api('POST', `/api/projects/${projectId}/elements`, { token: tokens.eng, body: els });
    assert.equal(made.status, 201);
    elements = Object.fromEntries(made.body.elements.map((e) => [e.element_type, e.id]));
    const est = await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: { contingency_pct: 5 } });
    assert.equal(est.status, 201);
    const proj = (await api('GET', `/api/projects/${projectId}`, { token: tokens.eng })).body.project;
    assert.equal(proj.budget_pkr, est.body.estimate.total_pkr);
    assert.equal((await api('POST', `/api/projects/${projectId}/schedule/generate`, { token: tokens.eng, body: {} })).status, 201);
    const tasks = (await api('GET', `/api/projects/${projectId}/schedule`, { token: tokens.eng })).body.tasks;
    taskIds = tasks.map((t) => t.id);
    assert.equal(tasks.length, 2);
    assert.ok(Math.abs(tasks.reduce((s, t) => s + t.planned_cost_pkr, 0) - est.body.estimate.total_pkr) < 1);
  });
  test('prices come from the admin-only price book; engineers cannot change them', async () => {
    assert.equal((await api('PUT', '/api/price-book', { token: tokens.eng, body: { CEMENT: 1 } })).status, 403);
    assert.equal((await api('PUT', `/api/projects/${projectId}/rates`, { token: tokens.eng, body: { CEMENT: 1 } })).status, 404);
    const before = (await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: { contingency_pct: 5, activate: false } })).body.estimate.total_pkr;
    assert.equal((await api('PUT', '/api/price-book', { token: tokens.admin, body: { CEMENT: 2800 } })).status, 200);
    const after = (await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: { contingency_pct: 5, activate: false } })).body.estimate.total_pkr;
    assert.ok(after > before);
    await api('PUT', '/api/price-book', { token: tokens.admin, body: { CEMENT: 1400 } });
  });
  test('regenerating the schedule over measured progress needs explicit confirmation (covered below)', () => {});
});

describe('there is no human path to evidence (TC-API-NOHUMAN)', () => {
  test('endpoints that used to accept typed progress, spend, photos and hazards no longer exist', async () => {
    const d = today();
    const tries = [
      ['PUT', `/api/projects/${projectId}/logs/${d}`, { progress: [], materials: [] }],
      ['POST', `/api/projects/${projectId}/logs/${d}/media`, undefined],
      ['POST', `/api/projects/${projectId}/hazards`, { title: 'x', category: 'y', likelihood: 1, severity: 1 }],
      ['PATCH', `/api/projects/${projectId}/hazards/${crypto.randomUUID()}`, { status: 'closed' }],
      ['GET', '/api/hazard-library', undefined],
    ];
    for (const role of ['eng', 'admin']) {
      for (const [m, p, b] of tries) {
        const r = await api(m, p, { token: tokens[role], body: b });
        assert.equal(r.status, 404, `${role} ${m} ${p} -> ${r.status}`);
      }
    }
  });
  test('site status accepts only crews and equipment; any extra field is refused', async () => {
    const put = (body, token = tokens.eng, date = today()) => api('PUT', `/api/projects/${projectId}/site-status/${date}`, { token, body });
    assert.equal((await put({ crews: 2, equipment: [{ type: 'Concrete mixer', count: 2 }] })).status, 200);
    for (const extra of [{ progress: [{ task_id: taskIds[0], percent: 100 }] }, { materials: [] }, { notes: 'all fine' }, { hazards_closed: true }, { workers_present: 3 }]) {
      const r = await put({ crews: 2, equipment: [], ...extra });
      assert.equal(r.status, 422, JSON.stringify(extra));
    }
    assert.equal((await put({ crews: -1, equipment: [] })).status, 422);
    assert.equal((await put({ crews: 1, equipment: [{ type: '', count: 1 }] })).status, 422);
    assert.equal((await put({ crews: 1, equipment: [] }, tokens.eng, addDays(today(), 3))).status, 422);
    assert.equal((await put({ crews: 1, equipment: [] }, tokens.eng, addDays(today(), -400))).status, 422);
    assert.equal((await put({ crews: 1, equipment: [] }, tokens.inv)).status, 403);
  });
  test('crews and equipment are stored and visible to engineers', async () => {
    const r = await api('GET', `/api/projects/${projectId}/site-status`, { token: tokens.eng });
    assert.equal(r.body.site_status[0].crews, 2);
    assert.equal(r.body.site_status[0].equipment[0].type, 'Concrete mixer');
  });
  test('the database refuses manual hazards and unflagged closures even if the API were bypassed', async () => {
    await assert.rejects(() => pool.query(
      "INSERT INTO hazards (project_id, source, category, title, likelihood, severity, identified_on) VALUES ($1,'manual','c','t',1,1,'2026-01-01')", [projectId]), (e) => e.code === '23514');
    await assert.rejects(() => pool.query(
      "INSERT INTO hazards (project_id, source, category, title, likelihood, severity, status, identified_on) VALUES ($1,'auto_defect','c','t',1,1,'closed','2026-01-01')", [projectId]), (e) => e.code === '23514');
  });
});

describe('cameras (TC-API-CAM)', () => {
  const create = (token, body, id = projectId) => api('POST', `/api/projects/${id}/cameras`, { token, body });
  test('only admins can install cameras', async () => {
    const body = { name: 'Zone cam', kind: 'zone', element_id: elements.slab };
    assert.equal((await create(tokens.eng, body)).status, 403);
    assert.equal((await create(tokens.inv, body)).status, 403);
  });
  test('zone cameras need an element of this project; yard cameras need a calibrated scale', async () => {
    assert.equal((await create(tokens.admin, { name: 'z', kind: 'zone' })).status, 422);
    assert.equal((await create(tokens.admin, { name: 'z2', kind: 'zone', element_id: crypto.randomUUID() })).status, 422);
    assert.equal((await create(tokens.admin, { name: 'yy', kind: 'yard' })).status, 422);
    assert.equal((await create(tokens.admin, { name: 'yy', kind: 'yard', scale_m_per_px: -1 })).status, 422);
  });
  test('the key is shown once and only its hash is stored', async () => {
    const z = await create(tokens.admin, { name: 'Zone camera - Slab', kind: 'zone', element_id: elements.slab, detect_defects: false });
    assert.equal(z.status, 201);
    zoneKey = z.body.key;
    assert.match(zoneKey, /^[0-9a-f-]{36}\.[0-9a-f]{48}$/);
    const row = (await pool.query('SELECT key_hash FROM cameras WHERE id = $1', [z.body.camera.id])).rows[0];
    assert.notEqual(row.key_hash, zoneKey.split('.')[1]);
    assert.equal(row.key_hash, crypto.createHash('sha256').update(zoneKey.split('.')[1]).digest('hex'));
    const y = await create(tokens.admin, { name: 'Yard camera', kind: 'yard', scale_m_per_px: 0.1, detect_defects: false });
    yardKey = y.body.key;
    const g = await create(tokens.admin, { name: 'Gate camera', kind: 'overview' });
    gateKey = g.body.key;
    const list = await api('GET', `/api/projects/${projectId}/cameras`, { token: tokens.eng });
    assert.equal(list.body.cameras.length, 3);
    assert.ok(!JSON.stringify(list.body).includes(zoneKey.split('.')[1]));
    assert.ok(!('key_hash' in list.body.cameras[0]));
    assert.equal((await api('GET', `/api/projects/${projectId}/cameras`, { token: tokens.inv })).status, 403);
  });
});

describe('ingest security (TC-API-INGEST)', () => {
  test('no key, wrong key, malformed key: refused', async () => {
    assert.equal((await ingest(null)).status, 401);
    assert.equal((await ingest(`${zoneKey.split('.')[0]}.${'0'.repeat(48)}`)).status, 401);
    assert.equal((await ingest('garbage')).status, 401);
    assert.equal((await ingest(`${crypto.randomUUID()}.${'a'.repeat(48)}`)).status, 401);
  });
  test('a logged-in engineer or admin cannot submit frames: only a camera can', async () => {
    assert.equal((await ingest(null, { token: tokens.eng })).status, 401);
    assert.equal((await ingest(null, { token: tokens.admin })).status, 401);
  });
  test('a camera key cannot be used as a user session', async () => {
    assert.equal((await api('GET', '/api/projects', { token: zoneKey })).status, 401);
    assert.equal((await api('GET', '/api/projects', { headers: { 'x-camera-key': zoneKey } })).status, 401);
  });
  test('missing image, non-image content, empty file: refused', async () => {
    assert.equal((await api('POST', '/api/ingest/frame', { form: new FormData(), headers: { 'x-camera-key': zoneKey } })).status, 422);
    assert.equal((await ingest(zoneKey, { buf: Buffer.from('<?php echo 1; ?>') })).status, 422);
    assert.equal((await ingest(zoneKey, { buf: Buffer.alloc(0) })).status, 422);
  });
  test('frames whose camera clock disagrees with the server are refused (stale, future, garbage)', async () => {
    const stale = await ingest(zoneKey, { at: minutesAgo(60 * 24 * 3) });
    assert.equal(stale.status, 422); assert.equal(stale.body.error.code, 'clock_skew');
    assert.equal((await ingest(zoneKey, { at: new Date(Date.now() + 3_600_000).toISOString() })).status, 422);
    assert.equal((await ingest(zoneKey, { at: 'not a date' })).status, 422);
    const noTime = new FormData();
    noTime.append('image', new Blob([jpeg()], { type: 'image/jpeg' }), 'f.jpg');
    assert.equal((await api('POST', '/api/ingest/frame', { form: noTime, headers: { 'x-camera-key': zoneKey } })).status, 422); // captured_at missing
  });
  test('replaying the same frame is refused; a different camera may send the same bytes', async () => {
    fake.state.mode = 'ok'; fake.state.stage = 0; fake.state.items = [];
    const buf = jpeg();
    assert.equal((await ingest(zoneKey, { buf })).status, 201);
    const again = await ingest(zoneKey, { buf });
    assert.equal(again.status, 409); assert.equal(again.body.error.code, 'duplicate_frame');
    assert.equal((await ingest(gateKey, { buf })).status, 201);
  });
  test('a disabled camera is refused', async () => {
    const extra = await api('POST', `/api/projects/${projectId}/cameras`, { token: tokens.admin, body: { name: 'Spare', kind: 'overview' } });
    const [id] = extra.body.key.split('.');
    assert.equal((await ingest(extra.body.key)).status, 201);
    assert.equal((await api('PATCH', `/api/projects/${projectId}/cameras/${id}`, { token: tokens.eng, body: { active: false } })).status, 403);
    assert.equal((await api('PATCH', `/api/projects/${projectId}/cameras/${id}`, { token: tokens.admin, body: { active: false } })).status, 200);
    assert.equal((await ingest(extra.body.key)).status, 401);
  });
});

describe('frames become measurements (TC-API-MEASURE)', () => {
  test('two agreeing zone frames set task progress from the stage; nobody typed it', async () => {
    fake.state.stage = 2; // slab: rebar mesh visible -> range 45-70 -> reported 57.5 %
    for (let i = 0; i < 2; i++) assert.equal((await ingest(zoneKey, { at: minutesAgo(5 - i) })).status, 201);
    const tasks = (await api('GET', `/api/projects/${projectId}/schedule`, { token: tokens.eng })).body.tasks;
    const slab = tasks.find((t) => t.name.startsWith('Slab'));
    assert.equal(slab.percent_complete, 57.5);
    const rows = (await pool.query("SELECT source FROM task_progress")).rows;
    assert.ok(rows.length > 0 && rows.every((r) => r.source === 'image_stage'));
  });
  test('one frame alone does not move progress', async () => {
    const f = (await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'One frame', start_date: addDays(today(), -3) } })).body.project;
    await api('POST', `/api/projects/${f.id}/elements`, { token: tokens.eng, body: { label: 'S', element_type: 'slab', length_m: 10, width_m: 10, thickness_m: 0.15, concrete_fc_mpa: 25 } });
    await api('POST', `/api/projects/${f.id}/estimates`, { token: tokens.eng, body: {} });
    await api('POST', `/api/projects/${f.id}/schedule/generate`, { token: tokens.eng, body: {} });
    const el = (await pool.query('SELECT id FROM design_elements WHERE project_id = $1', [f.id])).rows[0].id;
    const cam = await api('POST', `/api/projects/${f.id}/cameras`, { token: tokens.admin, body: { name: 'cam', kind: 'zone', element_id: el } });
    fake.state.stage = 3;
    assert.equal((await ingest(cam.body.key)).status, 201);
    const tasks = (await api('GET', `/api/projects/${f.id}/schedule`, { token: tokens.eng })).body.tasks;
    assert.equal(tasks[0].percent_complete, 0);
  });
  test('yard frames: stock falling during the day is measured consumption and priced from the price book', async () => {
    const mk = (qty) => { fake.state.items = [{ material_code: 'SAND', quantity: qty, unit: 'm3', area_px: 1, method: 'fake', confidence: 0.5 }]; };
    mk(100); assert.equal((await ingest(yardKey, { at: minutesAgo(8) })).status, 201);
    mk(80); assert.equal((await ingest(yardKey, { at: minutesAgo(1) })).status, 201);
    const d = await dash(tokens.eng);
    const rate = (await pool.query("SELECT p.rate_pkr FROM price_book p JOIN material_catalog m ON m.id = p.material_id WHERE m.code = 'SAND'")).rows[0].rate_pkr;
    assert.equal(d.headline.budget.spent, 20 * rate);
    const inv = d.inventory.find((r) => r.material === 'SAND');
    assert.equal(inv.used_qty, 20);
    const src = (await pool.query("SELECT DISTINCT source FROM material_usage")).rows.map((r) => r.source);
    assert.deepEqual(src, ['image_estimate']);
  });
  test('re-running the roll-up changes nothing (idempotent replay)', async () => {
    const project = (await pool.query('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
    const snap = async () => JSON.stringify([(await pool.query('SELECT percent_complete FROM task_progress ORDER BY 1')).rows, (await pool.query('SELECT used_qty, delivered_qty FROM inventory_daily ORDER BY 1,2')).rows]);
    const a = await snap();
    await rebuild(pool, project); await rebuild(pool, project);
    assert.equal(await snap(), a);
  });
  test('a later price-book change does not rewrite what past days cost', async () => {
    const before = (await dash(tokens.eng)).headline.budget.spent;
    await api('PUT', '/api/price-book', { token: tokens.admin, body: { SAND: 9999 } });
    const project = (await pool.query('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
    await rebuild(pool, project);
    assert.equal((await dash(tokens.eng)).headline.budget.spent, before);
    await api('PUT', '/api/price-book', { token: tokens.admin, body: { SAND: 3002 } });
  });
  test('regenerating the schedule over measured progress needs explicit confirmation', async () => {
    const r = await api('POST', `/api/projects/${projectId}/schedule/generate`, { token: tokens.eng, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'would_erase_progress');
  });
  test('every analysis records which model produced it', async () => {
    const runs = (await pool.query("SELECT kind, model_version FROM inference_runs WHERE kind IN ('stage','inventory') AND status = 'succeeded'")).rows;
    assert.ok(runs.length > 0);
    assert.ok(runs.every((r) => r.model_version === 'fake@0'));
  });
});

describe('failure handling (TC-API-FAIL)', () => {
  test('inference down: frame is stored, run marked failed, system alert raised, then cleared', async () => {
    fake.state.mode = 'down';
    const r = await ingest(gateKey);
    assert.equal(r.status, 201);
    assert.equal(r.body.analysis.defects.status, 'failed');
    const run = (await pool.query("SELECT status, error FROM inference_runs WHERE media_id = $1 AND kind = 'defects'", [r.body.media_id])).rows[0];
    assert.equal(run.status, 'failed');
    assert.match(run.error, /unreachable|timed out/);
    const file = await fetch(`${base}/api/media/${r.body.media_id}/file`, { headers: { authorization: `Bearer ${tokens.eng}` } });
    assert.equal(file.status, 200);
    assert.equal((await pool.query("SELECT 1 FROM alerts WHERE project_id = $1 AND kind = 'system' AND dedupe_key = 'system:analysis_failed' AND resolved_at IS NULL", [projectId])).rowCount, 1);
    fake.state.mode = 'ok'; fake.state.findings = [];
    assert.equal((await ingest(gateKey)).status, 201);
    assert.equal((await pool.query("SELECT 1 FROM alerts WHERE project_id = $1 AND dedupe_key = 'system:analysis_failed' AND resolved_at IS NULL", [projectId])).rowCount, 0);
  });
  test('inference returning 500 is recorded, not a crash', async () => {
    fake.state.mode = 'error';
    const r = await ingest(gateKey);
    assert.equal(r.status, 201);
    assert.match(r.body.analysis.defects.error, /model crashed/);
    fake.state.mode = 'ok';
  });
  test('regression: a missing photo file returns an error without cache headers', async () => {
    const m = (await pool.query(
      `INSERT INTO media (project_id, tag, storage_key, sha256, content_type, size_bytes) VALUES ($1,'general','missing/none.jpg','x','image/jpeg',1) RETURNING id`, [projectId])).rows[0];
    const res = await fetch(`${base}/api/media/${m.id}/file`, { headers: { authorization: `Bearer ${tokens.eng}` } });
    assert.equal(res.status, 500);
    assert.ok(!(res.headers.get('cache-control') ?? '').includes('max-age'));
  });
  test('photos are only served to members of the project', async () => {
    const id = (await pool.query('SELECT id FROM media WHERE project_id = $1 AND storage_key NOT LIKE $2 LIMIT 1', [projectId, 'missing/%'])).rows[0].id;
    const get = (t) => fetch(`${base}/api/media/${id}/file`, { headers: { authorization: `Bearer ${t}` } }).then((r) => r.status);
    assert.equal(await get(tokens.inv), 200);
    assert.equal(await get(tokens.engB), 404);
    assert.equal(await get(tokens.eng2), 404);
  });
});

describe('hazards and evidence over several days (TC-API-LIFE)', () => {
  // Multi-day histories cannot arrive over HTTP (the clock check forbids it), so they are loaded the
  // way a camera back-fills: through the ingest service with backfill, then the same roll-up.
  const day = (n) => addDays(today(), -n);
  const at = (d) => new Date(`${d}T05:00:00Z`);
  let gate; let project;
  before(async () => {
    project = (await pool.query('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
    // a camera of its own, so frames sent by earlier tests do not count as extra clean days
    const made = await api('POST', `/api/projects/${projectId}/cameras`, { token: tokens.admin, body: { name: 'Gate camera', kind: 'overview' } });
    gate = await authenticateCamera(pool, made.body.key);
    await pool.query("UPDATE cameras SET name = 'Gate camera (lifecycle)' WHERE id = $1", [gate.id]);
    await pool.query('DELETE FROM defects WHERE project_id = $1', [projectId]); // start from a clean evidence base
    await pool.query('DELETE FROM hazards WHERE project_id = $1', [projectId]);
  });
  const send = async (n, findings) => {
    fake.state.findings = findings;
    return ingestFrame(pool, gate, { buffer: jpeg(), capturedAt: at(day(n)), backfill: true });
  };
  const rust = [{ defect_type: 'rusted_rebar', score: 0.5, severity: 'High', is_violation: true, bbox: [1, 1, 50, 50], confidence: null }];

  test('a defect raises a hazard automatically; engineers and investors see it but cannot alter it', async () => {
    await send(6, rust);
    await rebuild(pool, project);
    const d = await dash(tokens.eng);
    const h = d.risk.hazards.find((x) => x.status === 'open');
    assert.equal(h.title, 'Corroded reinforcement');
    assert.equal(h.category, 'Structural integrity');
    assert.ok(h.bow_tie.preventive.length > 0);
    assert.equal(h.camera, 'Gate camera (lifecycle)');
    assert.ok(['moderate', 'high', 'critical'].includes(d.headline.safety.status));
    assert.equal((await api('PATCH', `/api/projects/${projectId}/hazards/${h.id}`, { token: tokens.eng, body: { status: 'closed' } })).status, 404);
  });
  test('the hazard closes by itself after three clean inspection days, not before', async () => {
    await send(5, []); await send(4, []);
    await rebuild(pool, project);
    assert.equal((await dash(tokens.eng)).risk.hazards.find((x) => x.title === 'Corroded reinforcement').status, 'open');
    await send(3, []);
    await rebuild(pool, project);
    const h = (await dash(tokens.eng)).risk.hazards.find((x) => x.title === 'Corroded reinforcement');
    assert.equal(h.status, 'closed');
    assert.equal(h.closed_on, day(3));
  });
  test('a repeat defect after closure opens a new hazard; the history is kept', async () => {
    await send(2, rust);
    await rebuild(pool, project);
    const hs = (await dash(tokens.eng)).risk.hazards.filter((x) => x.title === 'Corroded reinforcement');
    assert.deepEqual(hs.map((x) => x.status).sort(), ['closed', 'open']);
  });
  test('rebuilding hazards from the same evidence always gives the same result', async () => {
    const snap = async () => JSON.stringify((await pool.query('SELECT title, status, identified_on, closed_on, clean_days, likelihood FROM hazards ORDER BY identified_on, title')).rows);
    const a = await snap();
    await rebuild(pool, project); await rebuild(pool, project);
    assert.equal(await snap(), a);
  });
  test('quiet cameras are flagged and safety is marked unverified, never silently fine', async () => {
    await pool.query("UPDATE cameras SET last_frame_at = now() - interval '10 days' WHERE project_id = $1 AND kind = 'yard'", [projectId]);
    const d = await dash(tokens.eng);
    assert.equal(d.headline.safety.evidence_gap, true);
    assert.ok(d.alerts.some((a) => /No recent frames from: .*Yard camera/.test(a.message)));
    assert.match((await dash(tokens.inv)).headline.safety.text, /not reported recently/);
    assert.ok(d.evidence.cameras.some((c) => c.name === 'Yard camera' && c.status === 'stale'));
  });
  test('tasks with no camera are called out', async () => {
    const d = await dash(tokens.eng);
    assert.deepEqual(d.evidence.uncovered_tasks.length, 1); // the footing task has no zone camera
    assert.ok(d.alerts.some((a) => /No camera covers/.test(a.message)));
  });
  test('the alert clears when the camera reports again', async () => {
    await pool.query("UPDATE cameras SET last_frame_at = now() WHERE project_id = $1", [projectId]);
    const d = await dash(tokens.eng);
    assert.ok(!d.alerts.some((a) => /No recent frames from/.test(a.message)));
  });

  test('a crack finding raises an "Excessive cracking" hazard from evidence only', async () => {
    const crack = [{ defect_type: 'concrete_crack', score: 0.93, severity: 'High', is_violation: true, bbox: [5, 5, 250, 250], confidence: 0.9 }];
    await send(1, crack);
    await rebuild(pool, project);
    const d = await dash(tokens.eng);
    const h = d.risk.hazards.find((x) => x.title === 'Excessive cracking' && x.status === 'open');
    assert.ok(h, 'crack hazard missing');
    assert.equal(h.category, 'Structural integrity');
    assert.ok(h.bow_tie.mitigating.length > 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM defects WHERE project_id = $1 AND defect_type = 'concrete_crack'", [projectId])).rows[0].n, 1);
    assert.equal((await api('PATCH', `/api/projects/${projectId}/hazards/${h.id}`, { token: tokens.eng, body: { status: 'closed' } })).status, 404);
    await send(1, []); // leave the shared fake service as other tests expect
  });
});

describe('role views and access control (TC-API-RBAC)', () => {
  test('other organisation sees 404, not 403', async () => {
    assert.equal((await api('GET', `/api/projects/${projectId}`, { token: tokens.engB })).status, 404);
    assert.equal((await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.engB })).status, 404);
  });
  test('non-member engineer sees 404; admin sees all in the organisation', async () => {
    assert.equal((await api('GET', `/api/projects/${projectId}`, { token: tokens.eng2 })).status, 404);
    assert.equal((await api('GET', `/api/projects/${projectId}`, { token: tokens.admin })).status, 200);
  });
  test('project list only contains accessible projects', async () => {
    assert.equal((await api('GET', '/api/projects', { token: tokens.eng2 })).body.projects.length, 0);
    assert.ok((await api('GET', '/api/projects', { token: tokens.inv })).body.projects.length >= 1);
  });
  test('investor is read-only on every write endpoint', async () => {
    for (const [m, p, b] of [
      ['POST', `/api/projects/${projectId}/elements`, { label: 'x', element_type: 'slab', length_m: 1, width_m: 1, thickness_m: 1, concrete_fc_mpa: 25 }],
      ['PUT', `/api/projects/${projectId}/site-status/${today()}`, { crews: 1, equipment: [] }],
      ['POST', `/api/projects/${projectId}/estimates`, {}],
      ['POST', `/api/projects/${projectId}/cameras`, { name: 'x', kind: 'overview' }],
      ['PUT', '/api/price-book', { CEMENT: 1 }],
    ]) assert.equal((await api(m, p, { token: tokens.inv, body: b })).status, 403, `${m} ${p}`);
  });
  test('malformed project id is a 404, not a 500', async () => assert.equal((await api('GET', '/api/projects/not-a-uuid', { token: tokens.eng })).status, 404));
  test('investor view is plain language and carries no engineering internals', async () => {
    const d = await dash(tokens.inv);
    for (const k of ['risk', 'standards', 'estimate', 'inventory', 'site_status', 'metrics']) assert.equal(d[k], undefined, k);
    assert.doesNotMatch(JSON.stringify(d.alerts), /SDI|CPI|EAC|ALARP|SPI/);
    assert.match(d.evidence.note, /measured automatically/);
  });
  test('engineer view carries standards, mixes, hazards with categories, stock, crews and the evidence trail', async () => {
    const d = await dash(tokens.eng);
    assert.ok(d.standards.some((s) => s.code === 'ACI 211.1'));
    assert.ok(d.estimate.mixes.length >= 1);
    assert.ok(d.risk.hazards.every((h) => h.category && h.zone));
    assert.ok(d.risk.sdi === null || typeof d.risk.sdi.sdi === 'number');
    assert.ok(d.inventory.length > 0);
    assert.ok(d.site_status.length > 0);
    assert.ok(Array.isArray(d.evidence.frames) && d.evidence.frames.length > 0);
  });
});

describe('accounts, notifications and project creation (TC-API-ACCT)', () => {
  const mkUser = async (email, role) => {
    const r = await api('POST', '/api/users', { token: tokens.admin, body: { email, full_name: `User ${email.split('@')[0]}`, role, password: 'Another-Pass-1' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.user.id, token: (await login(email, 'Another-Pass-1')).body.token };
  };
  const notes = (token) => api('GET', '/api/notifications', { token }).then((r) => r.body);
  const create = (token, name = 'Acct Test Project') => api('POST', '/api/projects', { token, body: { name, location: 'Lahore', start_date: addDays(today(), -2) } });

  test('only engineers create projects: admin and investor are refused', async () => {
    assert.equal((await create(tokens.admin)).status, 403);
    assert.equal((await create(tokens.inv)).status, 403);
    assert.equal((await create(tokens.eng)).status, 201);
  });
  test('creating a project notifies every admin of the organisation, and nobody else', async () => {
    const admin2 = await mkUser('admin2@a.test', 'admin');
    const before = { a1: (await notes(tokens.admin)).unread, a2: (await notes(admin2.token)).unread };
    const r = await create(tokens.eng, 'Notify Me Tower');
    assert.equal(r.status, 201);
    for (const [who, tok, was] of [['admin', tokens.admin, before.a1], ['admin2', admin2.token, before.a2]]) {
      const n = await notes(tok);
      assert.equal(n.unread, was + 1, who);
      assert.equal(n.notifications[0].kind, 'project_created');
      assert.equal(n.notifications[0].project_id, r.body.project.id);
      assert.match(n.notifications[0].body, /Notify Me Tower/);
      assert.match(n.notifications[0].body, /eng@a\.test \(engineer\)|User eng|eng@a.test/); // names the creator
    }
    const engSees = (await notes(tokens.eng)).notifications.filter((x) => x.kind === 'project_created');
    assert.equal(engSees.length, 0, 'the creator is not notified');
    assert.equal((await notes(tokens.inv)).notifications.length, 0);
    assert.equal((await notes(tokens.engB)).notifications.length, 0, 'another organisation sees nothing');
  });
  test('a refused project creation sends no notification', async () => {
    const n = (await notes(tokens.admin)).notifications.length;
    await create(tokens.admin, 'Should not exist');
    assert.equal((await notes(tokens.admin)).notifications.length, n);
  });
  test('notifications can be marked read one by one or all at once, and only by their owner', async () => {
    const list = (await notes(tokens.admin)).notifications;
    const one = list.find((x) => !x.read_at);
    assert.equal((await api('POST', `/api/notifications/${one.id}/read`, { token: tokens.eng })).status, 404); // someone else's
    assert.equal((await api('POST', `/api/notifications/${one.id}/read`, { token: tokens.admin })).status, 200);
    assert.equal((await api('POST', `/api/notifications/${one.id}/read`, { token: tokens.admin })).status, 200); // idempotent
    assert.equal((await api('POST', '/api/notifications/not-a-uuid/read', { token: tokens.admin })).status, 404);
    assert.equal((await api('POST', `/api/notifications/${crypto.randomUUID()}/read`, { token: tokens.admin })).status, 404);
    await api('POST', '/api/notifications/read-all', { token: tokens.admin });
    assert.equal((await notes(tokens.admin)).unread, 0);
    assert.equal((await api('GET', '/api/notifications')).status, 401);
  });

  test('only admins can delete accounts; not their own; not other organisations\'', async () => {
    const victim = await mkUser('victim@a.test', 'investor');
    assert.equal((await api('DELETE', `/api/users/${victim.id}`, { token: tokens.eng })).status, 403);
    assert.equal((await api('DELETE', `/api/users/${victim.id}`, { token: tokens.inv })).status, 403);
    const meAdmin = (await api('GET', '/api/auth/me', { token: tokens.admin })).body.user.id;
    const self = await api('DELETE', `/api/users/${meAdmin}`, { token: tokens.admin });
    assert.equal(self.status, 409); assert.equal(self.body.error.code, 'cannot_delete_self');
    const engB = (await pool.query("SELECT id FROM users WHERE email = 'eng@b.test'")).rows[0].id;
    assert.equal((await api('DELETE', `/api/users/${engB}`, { token: tokens.admin })).status, 404);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [engB])).rowCount, 1);
    assert.equal((await api('DELETE', `/api/users/${crypto.randomUUID()}`, { token: tokens.admin })).status, 404);
    assert.equal((await api('DELETE', '/api/users/not-a-uuid', { token: tokens.admin })).status, 404);
    assert.equal((await api('DELETE', `/api/users/${victim.id}`)).status, 401);
  });
  test('a deleted account stops working at once; what it created is kept; the audit trail still names it', async () => {
    const eng = await mkUser('temp.eng@a.test', 'engineer');
    const made = await create(eng.token, 'Orphan Keeper');
    assert.equal(made.status, 201);
    const pid = made.body.project.id;
    await api('POST', `/api/projects/${pid}/elements`, { token: eng.token, body: { label: 'S', element_type: 'slab', length_m: 5, width_m: 5, thickness_m: 0.15, concrete_fc_mpa: 25 } });
    await api('POST', `/api/projects/${pid}/estimates`, { token: eng.token, body: {} });

    const del = await api('DELETE', `/api/users/${eng.id}`, { token: tokens.admin });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted.email, 'temp.eng@a.test');
    assert.ok(!('password_hash' in del.body.deleted));

    // the old token and the password both stop working immediately
    assert.equal((await api('GET', '/api/projects', { token: eng.token })).status, 401);
    assert.equal((await login('temp.eng@a.test', 'Another-Pass-1')).status, 401);
    // the project and its estimate survive, no longer attributed to a user
    const p = (await pool.query('SELECT created_by FROM projects WHERE id = $1', [pid])).rows[0];
    assert.equal(p.created_by, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cost_estimates WHERE project_id = $1 AND created_by IS NULL', [pid])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_members WHERE user_id = $1', [eng.id])).rows[0].n, 0);
    // the trail keeps the name as text
    const a = await api('GET', `/api/projects/${pid}/audit`, { token: tokens.admin });
    const created = a.body.audit.find((x) => x.action === 'create' && x.entity === 'project');
    assert.match(created.full_name, /User temp\.eng \(engineer\)/);
    const rec = (await pool.query("SELECT details, actor_label FROM audit_log WHERE action = 'delete' AND entity = 'user' AND entity_id = $1", [eng.id])).rows[0];
    assert.equal(rec.details.email, 'temp.eng@a.test');
    assert.match(rec.actor_label, /admin@a\.test \(admin\)/);
  });
  test('deleting a user who received notifications or acknowledged alerts does not fail', async () => {
    const admin3 = await mkUser('admin3@a.test', 'admin');
    await create(tokens.eng, 'For admin3');
    assert.ok((await notes(admin3.token)).unread >= 1);
    assert.equal((await api('DELETE', `/api/users/${admin3.id}`, { token: tokens.admin })).status, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [admin3.id])).rows[0].n, 0);
  });
  test('admins manage project access; removed people lose the project at once', async () => {
    const inv = await mkUser('access.inv@a.test', 'investor');
    const p = (await create(tokens.eng, 'Access Project')).body.project;
    assert.equal((await api('GET', `/api/projects/${p.id}`, { token: inv.token })).status, 404); // not added yet
    assert.equal((await api('POST', `/api/projects/${p.id}/members`, { token: tokens.eng, body: { user_id: inv.id } })).status, 403);
    assert.equal((await api('POST', `/api/projects/${p.id}/members`, { token: tokens.admin, body: { user_id: inv.id } })).status, 201);
    assert.equal((await api('GET', `/api/projects/${p.id}`, { token: inv.token })).status, 200);
    assert.equal((await api('DELETE', `/api/projects/${p.id}/members/${inv.id}`, { token: tokens.eng })).status, 403);
    assert.equal((await api('DELETE', `/api/projects/${p.id}/members/${inv.id}`, { token: tokens.admin })).status, 200);
    assert.equal((await api('GET', `/api/projects/${p.id}`, { token: inv.token })).status, 404);
    assert.equal((await api('DELETE', `/api/projects/${p.id}/members/${inv.id}`, { token: tokens.admin })).status, 404); // already removed
  });
});

describe('total cost: labour, equipment and overheads (TC-API-COST)', () => {
  let pid; const p = () => `/api/projects/${pid}`;
  const RATES = { crew_rate_pkr: 50_000, overhead_pct: 10, equipment: [{ type: 'Concrete mixer', rate_pkr: 4000, planned_units: 2 }] };
  before(async () => {
    pid = (await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'Cost project', start_date: addDays(today(), -4) } })).body.project.id;
    await api('POST', `${p()}/elements`, { token: tokens.eng, body: { label: 'Slab', element_type: 'slab', length_m: 10, width_m: 10, thickness_m: 0.15, concrete_fc_mpa: 25 } });
    await api('POST', `${p()}/estimates`, { token: tokens.eng, body: { contingency_pct: 5, activate: true } });
    const inv = (await pool.query("SELECT id FROM users WHERE email = 'inv@a.test'")).rows[0].id;
    await pool.query('INSERT INTO project_members VALUES ($1,$2)', [pid, inv]);
  });

  test('only the project engineer sets the rates: administrators, investors, outsiders and anonymous callers are refused', async () => {
    const post = (token) => api('POST', `${p()}/cost-rates`, { token, body: RATES });
    assert.equal((await post(tokens.admin)).status, 403);
    assert.equal((await post(tokens.inv)).status, 403);
    assert.equal((await post(tokens.eng2)).status, 404);
    assert.equal((await post(tokens.engB)).status, 404);
    assert.equal((await post(undefined)).status, 401);
    assert.equal((await api('GET', `${p()}/cost-rates`, { token: tokens.inv })).status, 403);
    assert.equal((await api('GET', `${p()}/cost-rates`, { token: tokens.eng })).body.rates, null);
  });
  test('invalid rates are refused with reasons and nothing is stored', async () => {
    const post = (body) => api('POST', `${p()}/cost-rates`, { token: tokens.eng, body });
    assert.equal((await post({ ...RATES, crew_rate_pkr: -5 })).status, 422);
    assert.equal((await post({ ...RATES, overhead_pct: 150 })).status, 422);
    assert.equal((await post({ ...RATES, crew_rate_pkr: 'lots' })).status, 422);
    assert.equal((await post({ ...RATES, surprise: 1 })).status, 422);                       // strict schema
    const dup = await post({ ...RATES, equipment: [{ type: 'Mixer', rate_pkr: 1, planned_units: 1 }, { type: ' mixer', rate_pkr: 2, planned_units: 1 }] });
    assert.equal(dup.status, 422); assert.match(JSON.stringify(dup.body.error.details), /twice/);
    assert.equal((await post({ ...RATES, equipment: [{ type: 'Mixer', rate_pkr: 1, planned_units: 1.5 }] })).status, 422);
    assert.equal((await pool.query('SELECT count(*)::int n FROM cost_rates WHERE project_id = $1', [pid])).rows[0].n, 0);
  });
  test('rates are set once and then locked, in the API and in the database', async () => {
    const r = await api('POST', `${p()}/cost-rates`, { token: tokens.eng, body: RATES });
    assert.equal(r.status, 201);
    assert.equal(r.body.rates.equipment[0].type, 'concrete mixer');                           // normalised
    assert.equal((await api('GET', `${p()}/cost-rates`, { token: tokens.admin })).body.rates.crew_rate_pkr, 50_000);   // admins may read
    const again = await api('POST', `${p()}/cost-rates`, { token: tokens.eng, body: { ...RATES, crew_rate_pkr: 1 } });
    assert.equal(again.status, 409); assert.equal(again.body.error.code, 'rates_locked');
    await assert.rejects(pool.query('UPDATE cost_rates SET crew_rate_pkr = 1 WHERE project_id = $1', [pid]), /locked/);
    await assert.rejects(pool.query('UPDATE cost_rate_equipment SET rate_pkr = 1 WHERE project_id = $1', [pid]), /locked/);
    await assert.rejects(pool.query("INSERT INTO cost_rate_equipment VALUES ($1, 'crane', 1, 1)", [pid]), /locked/);
    assert.equal((await pool.query('SELECT crew_rate_pkr::int AS c FROM cost_rates WHERE project_id = $1', [pid])).rows[0].c, 50_000);
  });
  test('the baseline budget of every task includes labour, equipment and overheads, and the parts add up', async () => {
    assert.equal((await api('POST', `${p()}/schedule/generate`, { token: tokens.eng, body: { crews: 2 } })).status, 201);
    const tasks = (await api('GET', `${p()}/schedule`, { token: tokens.eng })).body.tasks;
    assert.ok(tasks.length >= 1);
    for (const t of tasks) {
      const days = (await pool.query("SELECT count(*)::int n FROM generate_series($1::date, $2::date, interval '1 day') d WHERE extract(dow FROM d) <> 0", [t.planned_start, t.planned_end])).rows[0].n;
      const labour = Number(t.planned_labour_pkr); const equipment = Number(t.planned_equipment_pkr); const overhead = Number(t.planned_overhead_pkr);
      assert.equal(labour, 2 * 50_000 * days);                                                // 2 planned crews
      assert.equal(equipment, 2 * 4000 * days);                                               // 2 planned mixers
      const materials = Number(t.planned_cost_pkr) - labour - equipment - overhead;
      assert.ok(materials > 0);
      assert.ok(Math.abs(overhead - (materials + labour + equipment) * 0.1) < 0.05, 'overheads are 10 % of the direct cost');
    }
    const d = await dash(tokens.eng, pid);
    assert.equal(d.cost.scope, 'total');
    const sum = d.cost.planned.materials + d.cost.planned.labour + d.cost.planned.equipment + d.cost.planned.overheads;
    assert.ok(Math.abs(sum - d.cost.planned.total) < 0.05);
    assert.ok(Math.abs(d.cost.planned.total - d.metrics.bac) < 0.05, 'the earned-value budget is the total budget');
  });
  test('actual labour, equipment and overheads accrue from the daily site log at the locked rates', async () => {
    const date = addDays(today(), -1);
    const put = await api('PUT', `${p()}/site-status/${date}`, { token: tokens.eng, body: { crews: 2, equipment: [{ type: 'CONCRETE MIXER', count: 1 }, { type: 'Excavator', count: 1 }] } });
    assert.equal(put.status, 200);
    const d = await dash(tokens.eng, pid);
    assert.equal(d.cost.actual.labour, 100_000);
    assert.equal(d.cost.actual.equipment, 4000);                                              // the excavator has no rate
    assert.equal(d.cost.actual.overheads, 10_400);                                            // 10 % of 104,000
    assert.equal(d.cost.actual.materials, 0);
    assert.equal(d.metrics.ac, 114_400);                                                      // earned-value actual cost is the total
    assert.match(d.cost.warnings.join(), /excavator/);
  });
  test('investors see planned and actual cost by category but never the rates or engineering warnings', async () => {
    const d = await dash(tokens.inv, pid);
    assert.equal(d.cost.actual.labour, 100_000); assert.equal(d.cost.scope, 'total');
    assert.equal(d.cost.rates, undefined); assert.equal(d.cost.warnings, undefined);
    assert.doesNotMatch(JSON.stringify(d), /crew_rate|hire/i);
    const a = await dash(tokens.admin, pid);
    assert.equal(a.cost.actual.total, d.cost.actual.total);
  });
  test('a project without rates stays materials-only and accrues no labour or equipment', async () => {
    const d = await dash(tokens.eng);                                                        // the main test project has no rates
    assert.equal(d.cost.scope, 'materials');
    assert.equal(d.cost.actual.labour, 0); assert.equal(d.cost.actual.equipment, 0); assert.equal(d.cost.actual.overheads, 0);
    assert.equal(d.cost.planned.labour, 0);
  });
  test('setting the rates is audited', async () => {
    const actions = (await api('GET', `${p()}/audit`, { token: tokens.admin })).body.audit.map((a) => `${a.action}:${a.entity}`);
    assert.ok(actions.includes('create:cost_rates'));
  });
});

describe('the three roles do not overlap (TC-API-ROLES)', () => {
  const p = () => `/api/projects/${projectId}`;
  test('administrators cannot enter project content: BOQ, estimate, schedule, crews, alert acknowledgement', async () => {
    const el = { label: 'x', element_type: 'column', quantity: 1, length_m: 0.3, width_m: 0.3, height_m: 3, concrete_fc_mpa: 25 };
    const before = (await pool.query('SELECT count(*)::int n FROM design_elements WHERE project_id = $1', [projectId])).rows[0].n;
    assert.equal((await api('POST', `${p()}/elements`, { token: tokens.admin, body: [el] })).status, 403);
    assert.equal((await api('DELETE', `${p()}/elements/${crypto.randomUUID()}`, { token: tokens.admin })).status, 403);
    assert.equal((await api('POST', `${p()}/estimates`, { token: tokens.admin, body: { contingency_pct: 5, activate: true } })).status, 403);
    assert.equal((await api('POST', `${p()}/schedule/generate`, { token: tokens.admin, body: { crews: 1 } })).status, 403);
    assert.equal((await api('PUT', `${p()}/site-status/${today()}`, { token: tokens.admin, body: { crews: 3, equipment: [] } })).status, 403);
    assert.equal((await api('POST', `${p()}/alerts/${crypto.randomUUID()}/ack`, { token: tokens.admin })).status, 403);
    assert.equal((await pool.query('SELECT count(*)::int n FROM design_elements WHERE project_id = $1', [projectId])).rows[0].n, before);
    // they can still read what the engineer entered
    assert.equal((await api('GET', `${p()}/elements`, { token: tokens.admin })).status, 200);
    assert.equal((await api('GET', `${p()}/schedule`, { token: tokens.admin })).status, 200);
  });
  test('engineers cannot do administrator work: cameras, price book, people, audit log', async () => {
    assert.equal((await api('POST', `${p()}/cameras`, { token: tokens.eng, body: { name: 'mine', kind: 'overview' } })).status, 403);
    assert.equal((await api('PUT', '/api/price-book', { token: tokens.eng, body: { CEMENT: 1 } })).status, 403);
    assert.equal((await api('GET', `${p()}/members`, { token: tokens.eng })).status, 403);
    assert.equal((await api('POST', `${p()}/members`, { token: tokens.eng, body: { user_id: crypto.randomUUID() } })).status, 403);
    assert.equal((await api('GET', '/api/users', { token: tokens.eng })).status, 403);
    assert.equal((await api('GET', `${p()}/audit`, { token: tokens.eng })).status, 403);
  });
  test('investors cannot read the price book or any staff list, and get their own safety and spend views', async () => {
    assert.equal((await api('GET', '/api/price-book', { token: tokens.inv })).status, 403);
    assert.equal((await api('GET', `${p()}/cameras`, { token: tokens.inv })).status, 403);
    assert.equal((await api('GET', `${p()}/elements`, { token: tokens.inv })).status, 403);
    const d = await dash(tokens.inv);
    assert.ok(Array.isArray(d.safety_items.open) && typeof d.safety_items.closed_count === 'number');
    assert.ok(d.safety_items.open.every((h) => h.title && ['serious', 'attention', 'minor'].includes(h.level) && h.plain));
    assert.doesNotMatch(JSON.stringify(d.safety_items), /ALARP|SDI|likelihood|rating|bow_tie|preventive/i);
    assert.ok(Array.isArray(d.spend_by_material));
    const e = await dash(tokens.eng);
    assert.equal(e.safety_items, undefined); assert.equal(e.spend_by_material, undefined);
  });
  test('administrators and engineers each get their own dashboard payload', async () => {
    const a = await dash(tokens.admin);
    assert.equal(a.view, 'admin'); assert.ok(a.evidence.cameras.length > 0);
    assert.equal((await dash(tokens.eng)).view, 'engineer');
  });
});

describe('TEMPORARY test footage (TC-API-FOOTAGE)', () => {
  const { failStaleRuns } = footageSvc;
  const mp4 = (extra = 3000) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), crypto.randomBytes(extra)]);
  const form = (buf, fields = {}, name = 'site.mp4') => {
    const f = new FormData();
    f.append('file', new Blob([buf]), name);
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  };
  const upload = (token, buf = mp4(), fields = {}, id = projectId) => api('POST', `/api/projects/${id}/test-runs`, { token, form: form(buf, fields) });
  const run = (id, token = tokens.eng) => api('GET', `/api/projects/${projectId}/test-runs/${id}`, { token });
  const waitFor = async (id, statuses, token = tokens.eng) => {
    for (let i = 0; i < 200; i++) {
      const r = (await run(id, token)).body.run;
      if (statuses.includes(r.status)) return r;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error(`run ${id} never reached ${statuses}`);
  };
  const det = (label, conf, confirmed = false) => ({ label, conf, bbox: [10, 10, 80, 80], confirmed });
  const frame = (i, t, extra = {}) => ({ i, t_s: t, sharpness: 900, reused: false, ms: 280, detections: [], ...extra });
  const view = (status, frames, extra = {}) => ({
    status, error: null,
    params: { prompts: ['cement bag'], interval_s: 3, effective_interval_s: 3, conf: 0.1, max_frames: 400, estimated_frames: 3 },
    video: { kind: 'video', fps: 25, frames: 225, duration_s: 9, width: 1280, height: 720 },
    progress: { sampled: frames.length, analysed: frames.filter((f) => !f.reused).length, reused: frames.filter((f) => f.reused).length, estimated_total: 3 },
    frames, summary: { per_label: { 'cement bag': { detections: 2, confirmed: 2, best_conf: 0.7 } }, truncated: false, notes: [] },
    ...extra,
  });
  const reset = () => { Object.assign(fake.state.footage, { script: [], idx: 0, starts: [], deleted: [], rejectStart: null, gone: false }); fake.state.mode = 'ok'; };
  const evidenceCounts = async () => JSON.stringify((await pool.query(
    `SELECT (SELECT count(*) FROM media WHERE project_id = $1) m, (SELECT count(*) FROM defects WHERE project_id = $1) d,
            (SELECT count(*) FROM hazards WHERE project_id = $1) h, (SELECT count(*) FROM stage_observations o JOIN cameras c ON c.id = o.camera_id WHERE c.project_id = $1) s,
            (SELECT count(*) FROM inventory_observations o JOIN cameras c ON c.id = o.camera_id WHERE c.project_id = $1) i,
            (SELECT count(*) FROM task_progress) p, (SELECT count(*) FROM material_usage) u, (SELECT count(*) FROM inference_runs) r`, [projectId])).rows[0]);
  const leftovers = () => fs.readdirSync(path.join(os.tmpdir(), 'safelybuild-uploads')).length;

  test('only engineers of the project may use it: administrators and investors are refused', async () => {
    reset();
    assert.equal((await upload(tokens.inv)).status, 403);
    assert.equal((await upload(tokens.admin)).status, 403);
    assert.equal((await api('GET', `/api/projects/${projectId}/test-runs`, { token: tokens.admin })).status, 403);
    assert.equal((await api('GET', '/api/test-footage/defaults', { token: tokens.admin })).status, 403);
    assert.equal((await upload(tokens.eng2)).status, 404);   // not a member
    assert.equal((await upload(tokens.engB)).status, 404);   // other organisation
    assert.equal((await api('POST', `/api/projects/${projectId}/test-runs`, { form: form(mp4()) })).status, 401);
    assert.equal((await api('GET', `/api/projects/${projectId}/test-runs`, { token: tokens.inv })).status, 403);
    assert.equal((await api('GET', '/api/test-footage/defaults')).status, 401);
  });
  test('bad files and bad settings are refused before anything is analysed', async () => {
    reset();
    const before = leftovers();
    assert.equal((await api('POST', `/api/projects/${projectId}/test-runs`, { token: tokens.eng, form: new FormData() })).status, 422);
    assert.equal((await upload(tokens.eng, Buffer.from('<?php system($_GET["c"]); ?>'))).status, 422);        // script with a video name
    assert.equal((await upload(tokens.eng, Buffer.from('MZ' + 'x'.repeat(100)))).status, 422);               // executable
    for (const bad of [{ interval_s: '0.2' }, { interval_s: '30' }, { conf: '0' }, { conf: '2' }, { max_frames: '0' }, { max_frames: '9999' }, { max_frames: '2.5' },
      { prompts: Array.from({ length: 31 }, (_, i) => `p${i}`).join('\n') }, { prompts: 'x'.repeat(200) }]) {
      assert.equal((await upload(tokens.eng, mp4(), bad)).status, 422, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(fake.state.footage.starts.length, 0, 'nothing reached the analysis service');
    assert.equal(leftovers(), before, 'refused uploads leave no temp files');
    assert.equal((await pool.query('SELECT count(*)::int n FROM test_runs')).rows[0].n, 0);
  });
  test('a run is analysed, synced and stored; images are served only to project members', async () => {
    reset();
    const f1 = frame(0, 1.5, { detections: [det('cement bag', 0.7, true)] });
    const f2 = frame(1, 4.5, { reused: true, ms: 0, detections: [det('cement bag', 0.7, true)] });
    const f3 = frame(2, 7.5, { detections: [det('cement bag', 0.64, true)] });
    fake.state.footage.script = [view('running', [f1]), view('running', [f1, f2]), view('done', [f1, f2, f3])];
    const r = await upload(tokens.eng, mp4(), { prompts: 'cement bag\npile of sand', interval_s: '3', conf: '0.15', max_frames: '50' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.run.status, 'running');
    assert.equal(fake.state.footage.starts.length, 1);
    assert.match(fake.state.footage.starts[0].contentType, /multipart\/form-data/);
    assert.ok(fake.state.footage.starts[0].bytes > 3000, 'the whole file was forwarded');

    const done = await waitFor(r.body.run.id, ['done']);
    assert.equal(done.frames.length, 3);
    assert.deepEqual(done.frames.map((f) => f.reused), [false, true, false]);
    assert.equal(done.frames[0].detections[0].label, 'cement bag');
    assert.equal(done.params.conf, 0.15);                         // what the engineer asked for is on record
    assert.deepEqual(done.params.prompts, ['cement bag', 'pile of sand']);
    assert.equal(done.params.effective_interval_s, 3);
    assert.equal(done.video.fps, 25);
    assert.equal(done.summary.per_label['cement bag'].confirmed, 2);
    assert.ok(done.finished_at);
    assert.ok(fake.state.footage.deleted.includes('job-1'), 'the inference service was told to free the job');

    const list = (await api('GET', `/api/projects/${projectId}/test-runs`, { token: tokens.eng })).body.runs;
    assert.equal(list[0].id, done.id); assert.equal(list[0].frames, 3); assert.equal(list[0].filename, 'site.mp4');
    const img = (t) => fetch(`${base}/api/test-frames/${done.frames[0].id}/image`, { headers: { authorization: `Bearer ${t}` } });
    const ok = await img(tokens.eng);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.equal((await ok.arrayBuffer()).byteLength > 4, true);
    assert.equal((await img(tokens.admin)).status, 403);          // the tool belongs to the engineer side only
    assert.equal((await img(tokens.inv)).status, 403);
    assert.equal((await img(tokens.eng2)).status, 404);
    assert.equal((await img(tokens.engB)).status, 404);
    assert.equal((await fetch(`${base}/api/test-frames/not-a-uuid/image`, { headers: { authorization: `Bearer ${tokens.eng}` } })).status, 404);
    assert.equal(leftovers(), 0 + leftovers(), 'temp upload removed');
  });
  test('without custom prompts no prompts field is sent, so the service uses its default list', async () => {
    reset();
    fake.state.footage.script = [view('done', [frame(0, 1)])];
    const r = await upload(tokens.eng);
    assert.equal(r.status, 202);
    assert.equal(fake.state.footage.starts[0].hasPrompts, false);
    await waitFor(r.body.run.id, ['done']);
  });
  test('SANDBOX: a test run never touches evidence, progress, spend, hazards or the dashboard', async () => {
    reset();
    const before = await evidenceCounts();
    const dashBefore = JSON.stringify((await dash(tokens.eng)).headline);
    const hot = frame(0, 1, { detections: [det('rebar cage', 0.9, true), det('fresh poured concrete', 0.95, true)] });
    fake.state.footage.script = [view('done', [hot, frame(1, 4, { detections: [det('rebar cage', 0.9, true)] })])];
    const r = await upload(tokens.eng);
    await waitFor(r.body.run.id, ['done']);
    assert.equal(await evidenceCounts(), before);
    assert.equal(JSON.stringify((await dash(tokens.eng)).headline), dashBefore);
    assert.equal((await pool.query("SELECT count(*)::int n FROM hazards WHERE project_id = $1 AND status = 'open' AND created_at > now() - interval '1 minute'", [projectId])).rows[0].n >= 0, true);
  });
  test('only one run per project at a time; deleting a running run stops it', async () => {
    reset();
    fake.state.footage.script = [view('running', [frame(0, 1)])];       // never finishes
    const a = await upload(tokens.eng);
    assert.equal(a.status, 202);
    const b = await upload(tokens.eng);
    assert.equal(b.status, 409); assert.equal(b.body.error.code, 'run_in_progress');
    assert.equal(fake.state.footage.starts.length, 1);
    assert.equal((await api('DELETE', `/api/projects/${projectId}/test-runs/${a.body.run.id}`, { token: tokens.inv })).status, 403);
    const del = await api('DELETE', `/api/projects/${projectId}/test-runs/${a.body.run.id}`, { token: tokens.eng });
    assert.equal(del.status, 200);
    assert.ok(fake.state.footage.deleted.includes('job-1'), 'the running job was cancelled in the analysis service');
    assert.equal((await run(a.body.run.id)).status, 404);
    assert.equal((await pool.query('SELECT count(*)::int n FROM test_frames')).rows[0].n >= 0, true);
    fake.state.footage.script = [view('done', [frame(0, 1)])];
    assert.equal((await upload(tokens.eng)).status, 202);                  // a new run is allowed again
    await new Promise((ok) => setTimeout(ok, 150));
  });
  test('deleting a run removes its stored frames from disk', async () => {
    reset();
    fake.state.footage.script = [view('done', [frame(0, 1), frame(1, 4)])];
    const r = await upload(tokens.eng);
    const done = await waitFor(r.body.run.id, ['done']);
    const dir = path.join(process.env.STORAGE_DIR, 'testing', projectId, done.id);
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.equal((await api('DELETE', `/api/projects/${projectId}/test-runs/${done.id}`, { token: tokens.eng })).status, 200);
    assert.equal(fs.existsSync(dir), false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM test_frames WHERE run_id = $1', [done.id])).rows[0].n, 0);
    assert.equal((await api('DELETE', `/api/projects/${projectId}/test-runs/${done.id}`, { token: tokens.eng })).status, 404);
    assert.equal((await api('DELETE', `/api/projects/${projectId}/test-runs/not-a-uuid`, { token: tokens.eng })).status, 404);
  });
  test('the analysis service refusing or being down is reported cleanly and leaves nothing behind', async () => {
    reset();
    const before = leftovers();
    fake.state.footage.rejectStart = { status: 501, detail: 'YOLO-World is not available' };
    const a = await upload(tokens.eng);
    assert.equal(a.status, 501); assert.match(a.body.error.message, /YOLO-World/);
    fake.state.footage.rejectStart = { status: 413, detail: 'file exceeds 300 MB' };
    assert.equal((await upload(tokens.eng)).status, 413);
    fake.state.footage.rejectStart = { status: 500, detail: 'boom' };
    assert.equal((await upload(tokens.eng)).status, 502);
    fake.state.footage.rejectStart = null;
    fake.state.mode = 'down';
    const d = await upload(tokens.eng);
    assert.equal(d.status, 503); assert.equal(d.body.error.code, 'analysis_unavailable');
    reset();
    assert.equal((await pool.query('SELECT count(*)::int n FROM test_runs WHERE project_id = $1 AND status = ANY($2)', [projectId, ['queued', 'running']])).rows[0].n, 0, 'no run is stuck');
    assert.equal(leftovers(), before, 'temp files cleaned up on every failure');
  });
  test('a job that fails or is lost in the analysis service ends the run with a reason', async () => {
    reset();
    fake.state.footage.script = [view('failed', [], { error: 'file could not be read as a video or an image' })];
    const a = await upload(tokens.eng);
    const failed = await waitFor(a.body.run.id, ['failed']);
    assert.match(failed.error, /could not be read/);
    reset();
    fake.state.footage.gone = true;                                          // the analysis service forgot the job (restart)
    const b = await upload(tokens.eng);
    const lost = await waitFor(b.body.run.id, ['failed']);
    assert.match(lost.error, /lost this job/);
    reset();
    fake.state.footage.script = [view('running', [frame(0, 1)])];
    const c = await upload(tokens.eng);
    await new Promise((ok) => setTimeout(ok, 100));
    fake.state.mode = 'down';                                                // contact lost mid-run
    const gone = await waitFor(c.body.run.id, ['failed']);
    assert.match(gone.error, /lost contact/);
    reset();
  });
  test('runs interrupted by a server restart are failed on start-up, never left "running"', async () => {
    reset();
    const id = (await pool.query(
      "INSERT INTO test_runs (project_id, filename, size_bytes, status, params) VALUES ($1,'x.mp4',1,'running','{}') RETURNING id", [projectId])).rows[0].id;
    assert.ok((await failStaleRuns(pool)) >= 1);
    const r = (await pool.query('SELECT status, error FROM test_runs WHERE id = $1', [id])).rows[0];
    assert.equal(r.status, 'failed'); assert.match(r.error, /restarted/);
  });
  test('defaults are served from the analysis service; uploads and deletions are audited', async () => {
    reset();
    const d = await api('GET', '/api/test-footage/defaults', { token: tokens.eng });
    assert.equal(d.status, 200); assert.equal(d.body.interval_s, 3); assert.ok(d.body.prompts.includes('cement bag'));
    fake.state.mode = 'down';
    assert.equal((await api('GET', '/api/test-footage/defaults', { token: tokens.eng })).status, 503);
    reset();
    const actions = (await api('GET', `/api/projects/${projectId}/audit`, { token: tokens.admin })).body.audit.map((a) => `${a.action}:${a.entity}`);
    assert.ok(actions.includes('upload:test_footage') && actions.includes('delete:test_footage'));
  });
});

describe('audit trail (TC-API-AUDIT)', () => {
  test('mutations and ingests are recorded; only administrators can read the log', async () => {
    const r = await api('GET', `/api/projects/${projectId}/audit`, { token: tokens.admin });
    assert.equal(r.status, 200);
    const actions = r.body.audit.map((a) => `${a.action}:${a.entity}`);
    for (const need of ['create:design_elements', 'create:estimate', 'generate:schedule', 'create:camera', 'set:site_status', 'ingest:frame', 'disable:camera']) {
      assert.ok(actions.includes(need), `missing ${need}`);
    }
    assert.equal((await api('GET', `/api/projects/${projectId}/audit`, { token: tokens.inv })).status, 403);
    assert.equal((await api('GET', `/api/projects/${projectId}/audit`, { token: tokens.eng })).status, 403);
  });
});
