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

/** Fake inference service. `mode` can be switched per test: ok | down | slow-error | badimage. */
export function startFakeInference() {
  const state = { mode: 'ok', calls: [], findings: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.calls.push(req.url);
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (state.mode === 'down') return req.destroy();
      if (state.mode === 'error') return send(500, { detail: 'model crashed' });
      if (req.url.startsWith('/v1/defects')) {
        return send(200, { backend: 'fake', image_size: [640, 480], coverage: 0.2, findings: state.findings });
      }
      if (req.url.startsWith('/v1/activity')) return send(200, { change_ratio: 0.12, scene_similarity: 0.9, alignment_ok: true });
      if (req.url.startsWith('/v1/materials')) return send(200, { mode: 'simulated', simulated: true, proposals: [{ material_code: 'CEMENT', quantity: 10, unit: 'bag', confidence: 0.5 }], note: 'x' });
      if (req.url === '/health') return send(200, { status: 'ok' });
      send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    process.env.INFERENCE_URL = `http://127.0.0.1:${server.address().port}`;
    resolve({ state, close: () => new Promise((r) => server.close(r)) });
  }));
}
