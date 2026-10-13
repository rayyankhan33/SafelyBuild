// Starts the inference service with synthetic demo frames enabled (needed by `npm run db:seed`).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = path.join(root, 'services/inference/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
spawn(py, ['-m', 'uvicorn', 'service:app', '--app-dir', 'services/inference', '--port', '8000'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ENABLE_DEMO_FRAMES: '1' } });
