// Must be imported FIRST by integration tests: points the app at an isolated test database and a
// fake inference server before any module reads configuration.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const TEST_DB = 'safelybuild_test';

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB])).rowCount) {
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
}
await admin.end();

process.env.DATABASE_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
process.env.STORAGE_DIR = fileURLToPath(new URL('../../../.test-storage', import.meta.url));
process.env.INFERENCE_TIMEOUT_MS = '3000';
process.env.TEST_POLL_MS = '30';           // test-footage runs are polled quickly in tests
process.env.TEST_POLL_MAX_FAILURES = '3';
process.env.TEST_UPLOAD_TIMEOUT_MS = '4000';

/** Fake inference service. `mode` can be switched per test: ok | down | slow-error | badimage. */
export function startFakeInference() {
  const state = {
    mode: 'ok', calls: [], findings: [], stage: 0, fraction: null, items: [],
    // test-footage job: `script` is the list of job views served in order (the last one repeats)
    footage: { script: [], idx: 0, starts: [], deleted: [], rejectStart: null, gone: false },
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.calls.push(req.url);
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (state.mode === 'down') return req.socket.destroy();
      if (state.mode === 'error') return send(500, { detail: 'model crashed' });
      if (req.url.startsWith('/v1/test/')) {
        const f = state.footage;
        const m = req.url.match(/^\/v1\/test\/jobs\/([^/]+)(?:\/frames\/(\d+)\.jpg)?$/);
        if (req.url === '/v1/test/defaults') return send(200, { prompts: ['cement bag', 'pile of sand'], interval_s: 3, conf: 0.1, max_frames: 400, min_interval_s: 1, max_interval_s: 10, available: true });
        if (req.method === 'POST' && req.url === '/v1/test/jobs') {
          f.starts.push({ bytes: Buffer.concat(chunks).length, hasPrompts: Buffer.concat(chunks).toString('latin1').includes('name="prompts"'), contentType: req.headers['content-type'] });
          if (f.rejectStart) return send(f.rejectStart.status, { detail: f.rejectStart.detail });
          return send(202, { id: `job-${f.starts.length}` });
        }
        if (m && req.method === 'DELETE') { f.deleted.push(m[1]); return send(200, { ok: true }); }
        if (m && m[2] !== undefined) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`frame-${m[2]}`)])); }
        if (m && req.method === 'GET') {
          if (f.gone) return send(404, { detail: 'no such job' });
          return send(200, { ...f.script[Math.min(f.idx++, f.script.length - 1)], id: m[1] });
        }
        return send(404, {});
      }
      if (req.url.startsWith('/v1/defects')) {
        return send(200, { backend: 'fake', image_size: [640, 480], coverage: 0.2, findings: state.findings });
      }
      if (req.url.startsWith('/v1/activity')) return send(200, { change_ratio: 0.12, scene_similarity: 0.9, alignment_ok: true });
      if (req.url.startsWith('/v1/stage')) return send(200, { backend: 'fake', reliability: 'unvalidated', stage: state.stage, fraction: state.fraction, evidence: {}, model: { backend: 'fake', version: '0' } });
      if (req.url.startsWith('/v1/inventory')) return send(200, { backend: 'fake', reliability: 'unvalidated', items: state.items, model: { backend: 'fake', version: '0' } });
      if (req.url === '/health') return send(200, { status: 'ok' });
      send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    process.env.INFERENCE_URL = `http://127.0.0.1:${server.address().port}`;
    resolve({ state, close: () => new Promise((r) => server.close(r)) });
  }));
}
