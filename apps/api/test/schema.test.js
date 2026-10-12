// Design-vs-code consistency checks (TC-SCHEMA-*): the documented schema must be the real schema,
// the migrations must be repeatable, and database constraints must hold the invariants the
// application relies on.
import './env.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { pool } = await import('../src/db/pool.js');
const { resetDatabase, migrate } = await import('../src/db/migrate.js');
const { buildErd } = await import('../../../scripts/gen-erd.mjs');

before(() => resetDatabase(pool));
after(() => pool.end());

describe('schema', () => {
  test('docs/erd.md matches the live schema exactly', async () => {
    const file = fileURLToPath(new URL('../../../docs/erd.md', import.meta.url));
    assert.equal(fs.readFileSync(file, 'utf8'), await buildErd(pool), 'run `npm run docs:erd` and commit docs/erd.md');
  });
  test('migrations are idempotent', async () => {
    assert.deepEqual(await migrate(pool), []);
  });
  test('reference data is loaded: standards, materials, factors, productivity, hazard library', async () => {
    const n = async (t) => Number((await pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
    assert.ok(await n('standards_refs') >= 10);
    assert.equal(await n('material_catalog'), 5);
    assert.ok(await n('estimation_factors') >= 15);
    assert.equal(await n('productivity_rates'), 5);
    assert.equal(await n('price_book'), 5); // one price per material
    assert.ok(await n('hazard_library') >= 8);
  });
  test('every code-derived factor has a documented origin', async () => {
    const bad = (await pool.query("SELECT key FROM estimation_factors WHERE is_code_value AND standard_id IS NULL AND key NOT IN ('cement_bag_kg','steel_density')")).rows;
    assert.deepEqual(bad, []);
  });
});

describe('database constraints protect application invariants', () => {
  let ids;
  before(async () => {
    const org = (await pool.query("INSERT INTO organizations (name) VALUES ('o') RETURNING id")).rows[0].id;
    const user = (await pool.query("INSERT INTO users (org_id, email, password_hash, full_name, role) VALUES ($1,'a@b.test','x','A','engineer') RETURNING id", [org])).rows[0].id;
    const project = (await pool.query("INSERT INTO projects (org_id, name, start_date) VALUES ($1,'p','2026-01-01') RETURNING id", [org])).rows[0].id;
    ids = { org, user, project };
  });
  const rejects = (sql, params, code) => assert.rejects(() => pool.query(sql, params), (e) => (code ? e.code === code : true));

  test('emails must be lower-case and unique', async () => {
    await rejects("INSERT INTO users (org_id, email, password_hash, full_name, role) VALUES ($1,'UPPER@B.TEST','x','A','engineer')", [ids.org], '23514');
    await rejects("INSERT INTO users (org_id, email, password_hash, full_name, role) VALUES ($1,'a@b.test','x','A','engineer')", [ids.org], '23505');
  });
  test('one daily log per project per date', async () => {
    await pool.query("INSERT INTO daily_logs (project_id, log_date, author_id) VALUES ($1,'2026-02-01',$2)", [ids.project, ids.user]);
    await rejects("INSERT INTO daily_logs (project_id, log_date, author_id) VALUES ($1,'2026-02-01',$2)", [ids.project, ids.user], '23505');
  });
  test('risk rating is computed by the database and bounded 1-5', async () => {
    const h = (await pool.query("INSERT INTO hazards (project_id, source, category, title, likelihood, severity, identified_on) VALUES ($1,'auto_defect','c','t',4,5,'2026-02-01') RETURNING risk_rating", [ids.project])).rows[0];
    assert.equal(h.risk_rating, 20);
    await rejects("INSERT INTO hazards (project_id, source, category, title, likelihood, severity, identified_on) VALUES ($1,'auto_defect','c','t',6,1,'2026-02-01')", [ids.project], '23514');
  });
  test('progress is 0-100 and task dates are ordered', async () => {
    await rejects("INSERT INTO schedule_tasks (project_id, name, seq, planned_start, planned_end) VALUES ($1,'t',1,'2026-03-02','2026-03-01')", [ids.project], '23514');
  });
  test('negative quantities and rates are rejected', async () => {
    await rejects("UPDATE price_book SET rate_pkr = -5 WHERE material_id = 1", [], '23514');
  });
  test('only one open alert per dedupe key', async () => {
    const q = "INSERT INTO alerts (project_id, kind, level, dedupe_key, technical_msg, plain_msg) VALUES ($1,'budget','warning','k','t','p')";
    await pool.query(q, [ids.project]);
    await rejects(q, [ids.project], '23505');
    await pool.query("UPDATE alerts SET resolved_at = now() WHERE project_id = $1", [ids.project]);
    await pool.query(q, [ids.project]); // allowed again once the first is resolved
  });
  test('cameras: zone needs an element, yard needs a scale, kinds are restricted', async () => {
    const ins = (kind, el, scale) => pool.query("INSERT INTO cameras (project_id, name, kind, element_id, scale_m_per_px, key_hash) VALUES ($1,'c',$2,$3,$4,'h')", [ids.project, kind, el, scale]);
    await rejects("INSERT INTO cameras (project_id, name, kind, key_hash) VALUES ($1,'c','zone','h')", [ids.project], '23514');
    await rejects("INSERT INTO cameras (project_id, name, kind, key_hash) VALUES ($1,'c','yard','h')", [ids.project], '23514');
    await rejects("INSERT INTO cameras (project_id, name, kind, key_hash) VALUES ($1,'c','drone','h')", [ids.project], '23514');
    await ins('overview', null, null);
  });
  test('the same frame bytes cannot be stored twice for one camera', async () => {
    const cam = (await pool.query("SELECT id FROM cameras WHERE project_id = $1 LIMIT 1", [ids.project])).rows[0].id;
    const q = "INSERT INTO media (project_id, camera_id, storage_key, sha256, content_type, size_bytes) VALUES ($1,$2,$3,'samehash','image/jpeg',1)";
    await pool.query(q, [ids.project, cam, 'k/1']);
    await rejects(q, [ids.project, cam, 'k/2'], '23505');
  });
  test('hazards can only come from detection and cannot be closed without a closing date', async () => {
    await rejects("INSERT INTO hazards (project_id, source, category, title, likelihood, severity, identified_on) VALUES ($1,'manual','c','t',1,1,'2026-02-01')", [ids.project], '23514');
    await rejects("INSERT INTO hazards (project_id, source, category, title, likelihood, severity, status, identified_on) VALUES ($1,'auto_defect','c','t',1,1,'closed','2026-02-01')", [ids.project], '23514');
  });
  test('deleting a project cascades to its data', async () => {
    await pool.query('DELETE FROM projects WHERE id = $1', [ids.project]);
    assert.equal((await pool.query('SELECT count(*) FROM daily_logs WHERE project_id = $1', [ids.project])).rows[0].count, 0);
  });
});
