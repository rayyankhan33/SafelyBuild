// One-command development launcher:  npm run dev
// Starts PostgreSQL, the inference service, the API and the web app in the right order, loads the
// demo project on first run, prefixes every log line with the service name, and stops everything
// on Ctrl+C. Each service can still be started alone with its own npm script.
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const py = path.join(root, 'services/inference/.venv', win ? 'Scripts/python.exe' : 'bin/python');
const children = [];
let stopping = false;

const color = { db: 36, inference: 35, api: 32, web: 33, seed: 90 };
function log(name, line) {
  console.log(`\x1b[${color[name] ?? 0}m[${name}]\x1b[0m ${line}`);
}

// npm is a .cmd file on Windows and needs a shell; pass one command string to avoid arg-escaping warnings
const launch = (cmd, args, env = {}) => (win && cmd === 'npm'
  ? spawn(`npm ${args.join(' ')}`, { cwd: root, shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }));

function start(name, cmd, args, env = {}) {
  const child = launch(cmd, args, env);
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.filter((l) => l.trim()).forEach((l) => log(name, l));
    });
  };
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', (code) => {
    if (!stopping) { log(name, `exited with code ${code}; stopping everything`); shutdown(1); }
  });
  children.push(child);
  return child;
}

function run(name, cmd, args) {
  return new Promise((resolve, reject) => {
    const c = launch(cmd, args);
    c.stdout.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => log(name, l)));
    c.stderr.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => log(name, l)));
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code})`))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, probe, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    if (stopping) return;
    if (await probe().catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready within ${seconds}s`);
}
// Ready means a real query succeeds: the port opens before PostgreSQL finishes crash recovery.
const dbReady = (port) => async () => {
  const c = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/safelybuild`, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.query('SELECT 1'); return true; } catch { return false; } finally { await c.end().catch(() => {}); }
};
const http = (url) => async () => (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping...');
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (win) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  log('db', 'starting PostgreSQL...');
  start('db', 'node', ['scripts/dev-db.mjs']);
  await waitFor('PostgreSQL', dbReady(5432));

  log('inference', 'starting image analysis...');
  start('inference', py, ['-m', 'uvicorn', 'service:app', '--app-dir', 'services/inference', '--port', '8000'], { ENABLE_DEMO_FRAMES: '1' });
  await waitFor('inference service', http('http://localhost:8000/health'), 60);

  await run('seed', 'node', ['--env-file-if-exists=.env', 'apps/api/src/db/seed.js']);

  start('api', 'node', ['--env-file-if-exists=.env', 'apps/api/src/server.js']);
  await waitFor('API', http('http://localhost:4000/api/health'), 30);
  start('web', 'npm', ['run', 'web']);
  await waitFor('web app', http('http://localhost:5173'), 60);

  console.log('\n\x1b[1mSafelyBuild is running:  http://localhost:5173\x1b[0m   (Ctrl+C stops everything)');
  console.log('Demo logins: top of apps/api/src/db/seed.js\n');
} catch (e) {
  console.error(`\n${e.message}`);
  shutdown(1);
}
