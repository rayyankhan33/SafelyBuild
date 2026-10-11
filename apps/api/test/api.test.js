// Integration tests: real Express app + real PostgreSQL (database safelybuild_test) + fake inference.
// Covers happy paths and the failure/edge cases required by docs/srs.md (TC-API-*).
import { startFakeInference } from './env.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const fake = await startFakeInference();
const { pool } = await import('../src/db/pool.js');
const { resetDatabase } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/http.js');
const { addDays, today } = await import('../src/domain/dates.js');

const PW = 'Test-Password-1';
let server, base;
const tokens = {};
let projectId, org2Project;
let taskIds = [];

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (email, password = PW) => api('POST', '/api/auth/login', { body: { email, password } });
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
function photoForm(buf = jpeg(), tag = 'general') {
  const f = new FormData();
  f.append('files', new Blob([buf], { type: 'image/jpeg' }), 'p.jpg');
  f.append('tag', tag);
  return f;
}

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
  const eng3 = await mk(org2.id, 'eng@b.test', 'engineer');
  await pool.query("INSERT INTO users (org_id, email, password_hash, full_name, role, is_active) VALUES ($1,'off@a.test',$2,'off','engineer',false)", [org.id, await hashPassword(PW)]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, e] of [['admin', 'admin@a.test'], ['eng', 'eng@a.test'], ['eng2', 'eng2@a.test'], ['inv', 'inv@a.test'], ['engB', 'eng@b.test']]) {
    tokens[k] = (await login(e)).body.token;
  }
  void eng3;
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
  test('disabled account cannot log in', async () => {
    assert.equal((await login('off@a.test')).status, 401);
  });
  test('repeated failures are rate limited', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await login('inv@a.test', 'bad');
    assert.equal(last.status, 429);
    assert.equal((await login('inv@a.test')).status, 429); // even the right password is blocked while limited
  });
  test('only admins can create users; short passwords refused', async () => {
    const body = { email: 'new@a.test', full_name: 'New', role: 'engineer', password: 'LongEnough1' };
    assert.equal((await api('POST', '/api/users', { token: tokens.eng, body })).status, 403);
    assert.equal((await api('POST', '/api/users', { token: tokens.admin, body: { ...body, password: 'short' } })).status, 422);
    assert.equal((await api('POST', '/api/users', { token: tokens.admin, body })).status, 201);
    assert.equal((await api('POST', '/api/users', { token: tokens.admin, body })).status, 409); // duplicate email
  });
});

describe('project setup, estimate and schedule (TC-API-SETUP)', () => {
  test('engineer creates project; investor cannot', async () => {
    const start = addDays(today(), -10);
    assert.equal((await api('POST', '/api/projects', { token: tokens.inv, body: { name: 'X', start_date: start } })).status, 403);
    assert.equal((await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'X', start_date: 'tomorrow' } })).status, 422);
    const r = await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'Test Block', location: 'Islamabad', start_date: start } });
    assert.equal(r.status, 201);
    projectId = r.body.project.id;
    // make investor and a second engineer members / non-members
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
  test('valid BOQ -> estimate -> activated budget -> schedule', async () => {
    const els = [
      { label: 'Footings', element_type: 'footing', quantity: 20, length_m: 1.5, width_m: 1.5, height_m: 0.5, concrete_fc_mpa: 25 },
      { label: 'Columns', element_type: 'column', quantity: 20, length_m: 0.4, width_m: 0.4, height_m: 3, concrete_fc_mpa: 30 },
      { label: 'Slab', element_type: 'slab', quantity: 1, length_m: 20, width_m: 15, thickness_m: 0.15, concrete_fc_mpa: 25 },
    ];
    assert.equal((await api('POST', `/api/projects/${projectId}/elements`, { token: tokens.eng, body: els })).status, 201);
    const est = await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: { contingency_pct: 5 } });
    assert.equal(est.status, 201);
    assert.ok(est.body.estimate.total_pkr > 0);
    const proj = (await api('GET', `/api/projects/${projectId}`, { token: tokens.eng })).body.project;
    assert.equal(proj.budget_pkr, est.body.estimate.total_pkr);

    const sch = await api('POST', `/api/projects/${projectId}/schedule/generate`, { token: tokens.eng, body: {} });
    assert.equal(sch.status, 201);
    const tasks = (await api('GET', `/api/projects/${projectId}/schedule`, { token: tokens.eng })).body.tasks;
    taskIds = tasks.map((t) => t.id);
    assert.equal(tasks.length, 3);
    const bac = tasks.reduce((s, t) => s + t.planned_cost_pkr, 0);
    assert.ok(Math.abs(bac - est.body.estimate.total_pkr) < 1, `task budgets (${bac}) must add up to the estimate (${est.body.estimate.total_pkr})`);
  });
  test('rate edits change the next estimate', async () => {
    const before = (await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: { contingency_pct: 5, activate: false } })).body.estimate.total_pkr;
    await api('PUT', `/api/projects/${projectId}/rates`, { token: tokens.eng, body: { CEMENT: 2800 } });
    const after = (await api('POST', `/api/projects/${projectId}/estimates`, { token: tokens.eng, body: { contingency_pct: 5, activate: false } })).body.estimate.total_pkr;
    assert.ok(after > before);
    await api('PUT', `/api/projects/${projectId}/rates`, { token: tokens.eng, body: { CEMENT: 1400 } });
  });
});

describe('access control (TC-API-RBAC)', () => {
  test('other organisation sees 404, not 403', async () => {
    assert.equal((await api('GET', `/api/projects/${projectId}`, { token: tokens.engB })).status, 404);
    assert.equal((await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.engB })).status, 404);
  });
  test('engineer who is not a member sees 404; admin sees all in org', async () => {
    assert.equal((await api('GET', `/api/projects/${projectId}`, { token: tokens.eng2 })).status, 404);
    assert.equal((await api('GET', `/api/projects/${projectId}`, { token: tokens.admin })).status, 200);
  });
  test('project list only contains accessible projects', async () => {
    assert.equal((await api('GET', '/api/projects', { token: tokens.eng2 })).body.projects.length, 0);
    assert.equal((await api('GET', '/api/projects', { token: tokens.inv })).body.projects.length, 1);
  });
  test('investor is read-only', async () => {
    for (const [m, p, b] of [
      ['POST', `/api/projects/${projectId}/elements`, { label: 'x', element_type: 'slab', length_m: 1, width_m: 1, thickness_m: 1, concrete_fc_mpa: 25 }],
      ['PUT', `/api/projects/${projectId}/logs/${today()}`, {}],
      ['POST', `/api/projects/${projectId}/hazards`, { title: 'h', category: 'c', likelihood: 1, severity: 1 }],
      ['PUT', `/api/projects/${projectId}/rates`, { CEMENT: 1 }],
    ]) {
      assert.equal((await api(m, p, { token: tokens.inv, body: b })).status, 403, `${m} ${p}`);
    }
  });
  test('malformed project id is a 404, not a 500', async () => {
    assert.equal((await api('GET', '/api/projects/not-a-uuid', { token: tokens.eng })).status, 404);
  });
});

describe('daily logs, spend and forecasts (TC-API-LOG)', () => {
  const day = (n) => addDays(today(), -n);
  const put = (date, body, token = tokens.eng) => api('PUT', `/api/projects/${projectId}/logs/${date}`, { token, body });

  test('future date, unknown task, decreasing progress are rejected', async () => {
    assert.equal((await put(addDays(today(), 2), {})).status, 422);
    assert.equal((await put(day(5), { progress: [{ task_id: '00000000-0000-4000-8000-000000000000', percent: 5 }] })).status, 422);
    assert.equal((await put(day(9) , { })).status, 200);
    assert.equal((await put(addDays(addDays(today(), -10), -3), {})).status, 422); // before project start
  });
  test('valid logs produce a forecast that matches the logged spend', async () => {
    const spendPlan = [[day(6), 10, 5], [day(5), 18, 5], [day(4), 25, 5], [day(3), 31, 5]];
    for (const [d, pct, bags] of spendPlan) {
      const r = await put(d, { workers_present: 20, progress: [{ task_id: taskIds[0], percent: pct }], materials: [{ material_code: 'CEMENT', quantity: bags, source: 'manual' }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.inv })).body;
    assert.equal(dash.setup_complete, true);
    assert.equal(dash.headline.budget.spent, 4 * 5 * 1400); // 4 days x 5 bags x PKR 1400
    assert.ok(dash.headline.percent_complete > 0);
    assert.ok(['on_track', 'at_risk', 'over_budget', 'under_budget'].includes(dash.headline.budget.status));
  });
  test('progress may not go down or jump above a later day', async () => {
    assert.equal((await put(day(2), { progress: [{ task_id: taskIds[0], percent: 20 }] })).status, 422);
    assert.equal((await put(day(7), { progress: [{ task_id: taskIds[0], percent: 50 }] })).status, 422); // later day (day 6) is only 10%
  });
  test('re-submitting a day replaces its entries instead of duplicating spend', async () => {
    await put(day(6), { materials: [{ material_code: 'CEMENT', quantity: 5 }] });
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.inv })).body;
    assert.equal(dash.headline.budget.spent, 4 * 5 * 1400);
  });
  test('regenerating the schedule after progress needs explicit confirmation', async () => {
    const r = await api('POST', `/api/projects/${projectId}/schedule/generate`, { token: tokens.eng, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'would_erase_progress');
  });
  test('insufficient data wording appears when there are too few logs (separate project)', async () => {
    const p = (await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'Fresh', start_date: day(3) } })).body.project;
    await api('POST', `/api/projects/${p.id}/elements`, { token: tokens.eng, body: { label: 'S', element_type: 'slab', length_m: 10, width_m: 10, thickness_m: 0.15, concrete_fc_mpa: 25 } });
    await api('POST', `/api/projects/${p.id}/estimates`, { token: tokens.eng, body: {} });
    await api('POST', `/api/projects/${p.id}/schedule/generate`, { token: tokens.eng, body: {} });
    const dash = (await api('GET', `/api/projects/${p.id}/dashboard`, { token: tokens.eng })).body;
    assert.equal(dash.headline.budget.status, 'insufficient_data');
    assert.equal(dash.headline.schedule.status === 'insufficient_data' || dash.headline.schedule.status === 'not_started', true);
  });
  test('dashboard before any schedule says setup is incomplete', async () => {
    const p = (await api('POST', '/api/projects', { token: tokens.eng, body: { name: 'Empty', start_date: day(1) } })).body.project;
    const dash = (await api('GET', `/api/projects/${p.id}/dashboard`, { token: tokens.eng })).body;
    assert.equal(dash.setup_complete, false);
  });
});

describe('photo analysis, hazards, alerts (TC-API-PHOTO)', () => {
  const up = (buf, tag, date = today()) => api('POST', `/api/projects/${projectId}/logs/${date}/media`, { token: tokens.eng, form: photoForm(buf, tag) });

  test('non-image upload is rejected even with an image content-type', async () => {
    const r = await up(Buffer.from('<?php echo 1; ?>'));
    assert.equal(r.status, 422);
  });
  test('upload with no file is rejected', async () => {
    const r = await api('POST', `/api/projects/${projectId}/logs/${today()}/media`, { token: tokens.eng, form: new FormData() });
    assert.equal(r.status, 422);
  });
  test('violation defect creates a hazard, raises safety status and an alert', async () => {
    fake.state.mode = 'ok';
    fake.state.findings = [{ defect_type: 'honeycombed_concrete', score: 0.5, severity: 'High', is_violation: true, bbox: [10, 10, 200, 200], confidence: null, backend: 'fake' }];
    const r = await up(jpeg(), 'general');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.uploads[0].analysis.defects.status, 'succeeded');
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.eng })).body;
    assert.equal(dash.risk.hazards.length, 1);
    assert.equal(dash.risk.hazards[0].title, 'Honeycombed concrete');
    assert.ok(dash.risk.hazards[0].bow_tie.preventive.length > 0);
    assert.ok(['high', 'critical'].includes(dash.headline.safety.status));
    assert.ok(dash.alerts.some((a) => a.kind === 'risk'));
  });
  test('a second detection of the same defect does not duplicate the hazard', async () => {
    await up(jpeg(), 'general');
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.eng })).body;
    assert.equal(dash.risk.hazards.length, 1);
  });
  test('investor view hides engineering detail but keeps plain-language status', async () => {
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.inv })).body;
    assert.equal(dash.risk, undefined);
    assert.equal(dash.standards, undefined);
    assert.equal(dash.estimate, undefined);
    assert.doesNotMatch(JSON.stringify(dash.alerts), /SDI|CPI|EAC|ALARP/);
    assert.ok(dash.headline.safety.text.length > 10);
  });
  test('engineer view carries standards, estimate mixes and hazard categories', async () => {
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.eng })).body;
    assert.ok(dash.standards.some((s) => s.code === 'ACI 211.1'));
    assert.ok(dash.estimate.mixes.length >= 1);
    assert.equal(dash.risk.hazards[0].category, 'Structural integrity');
    assert.ok(dash.risk.sdi && typeof dash.risk.sdi.sdi === 'number');
  });
  test('closing the hazard lowers the overall safety status', async () => {
    const dash = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.eng })).body;
    const before = dash.risk.safety.worst_rating;
    const h = dash.risk.hazards[0];
    assert.equal((await api('PATCH', `/api/projects/${projectId}/hazards/${h.id}`, { token: tokens.inv, body: { status: 'closed' } })).status, 403);
    assert.equal((await api('PATCH', `/api/projects/${projectId}/hazards/${h.id}`, { token: tokens.eng, body: { status: 'closed' } })).status, 200);
    const after = (await api('GET', `/api/projects/${projectId}/dashboard`, { token: tokens.eng })).body;
    assert.ok(after.risk.safety.worst_rating < before);
  });
  test('inference service down: photo is still saved, run marked failed, system alert raised, then cleared', async () => {
    fake.state.mode = 'down';
    const r = await up(jpeg(), 'general');
    assert.equal(r.status, 201);
    assert.equal(r.body.uploads[0].analysis.defects.status, 'failed');
    const mediaId = r.body.uploads[0].media.id;
    const file = await fetch(`${base}/api/media/${mediaId}/file`, { headers: { authorization: `Bearer ${tokens.eng}` } });
    assert.equal(file.status, 200);
    const run = (await pool.query("SELECT status, error FROM inference_runs WHERE media_id = $1 AND kind = 'defects'", [mediaId])).rows[0];
    assert.equal(run.status, 'failed');
    assert.match(run.error, /unreachable|timed out/);
    const open = (await pool.query("SELECT 1 FROM alerts WHERE project_id = $1 AND kind = 'system' AND resolved_at IS NULL", [projectId])).rowCount;
    assert.equal(open, 1);

    fake.state.mode = 'ok';
    fake.state.findings = [];
    await up(jpeg(), 'general');
    const still = (await pool.query("SELECT 1 FROM alerts WHERE project_id = $1 AND kind = 'system' AND resolved_at IS NULL", [projectId])).rowCount;
    assert.equal(still, 0);
  });
  test('inference service returning 500 is recorded as a failed run, not a crash', async () => {
    fake.state.mode = 'error';
    const r = await up(jpeg(), 'general');
    assert.equal(r.status, 201);
    assert.match(r.body.uploads[0].analysis.defects.error, /model crashed/);
    fake.state.mode = 'ok';
  });
  test('overview photos compare with the previous overview photo; material photos return proposals', async () => {
    const a = await up(jpeg(), 'overview');
    assert.equal(a.body.uploads[0].analysis.activity.status, 'skipped');
    const b = await up(jpeg(), 'overview');
    assert.equal(b.body.uploads[0].analysis.activity.status, 'succeeded');
    const m = await up(jpeg(), 'material');
    assert.equal(m.body.uploads[0].analysis.materials.proposals[0].material_code, 'CEMENT');
  });
  test('photos are only served to members of the project', async () => {
    const id = (await pool.query('SELECT id FROM media WHERE project_id = $1 LIMIT 1', [projectId])).rows[0].id;
    const ok = await fetch(`${base}/api/media/${id}/file`, { headers: { authorization: `Bearer ${tokens.inv}` } });
    const no = await fetch(`${base}/api/media/${id}/file`, { headers: { authorization: `Bearer ${tokens.engB}` } });
    const no2 = await fetch(`${base}/api/media/${id}/file`, { headers: { authorization: `Bearer ${tokens.eng2}` } });
    assert.equal(ok.status, 200); assert.equal(no.status, 404); assert.equal(no2.status, 404);
  });
  test('regression: a missing photo file returns an error without cache headers', async () => {
    // found during manual testing: cache headers were set before the file read failed, so a browser cached the 500
    const m = (await pool.query(
      `INSERT INTO media (project_id, tag, storage_key, sha256, content_type, size_bytes, uploaded_by)
       SELECT $1, 'general', 'missing/none.jpg', 'x', 'image/jpeg', 1, id FROM users WHERE email = 'eng@a.test' RETURNING id`, [projectId])).rows[0];
    const res = await fetch(`${base}/api/media/${m.id}/file`, { headers: { authorization: `Bearer ${tokens.eng}` } });
    assert.equal(res.status, 500);
    assert.ok(!(res.headers.get('cache-control') ?? '').includes('max-age'));
  });
});

describe('audit trail (TC-API-AUDIT)', () => {
  test('mutations are recorded with the acting user', async () => {
    const r = await api('GET', `/api/projects/${projectId}/audit`, { token: tokens.eng });
    assert.equal(r.status, 200);
    const actions = r.body.audit.map((a) => `${a.action}:${a.entity}`);
    for (const need of ['create:design_elements', 'create:estimate', 'generate:schedule', 'upsert:daily_log', 'upload:media']) {
      assert.ok(actions.includes(need), `missing ${need}`);
    }
    assert.equal((await api('GET', `/api/projects/${projectId}/audit`, { token: tokens.inv })).status, 403);
  });
});
