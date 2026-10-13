// Pretend to be a site camera: posts image files to the ingest endpoint with a camera key, using the
// current time as the capture time (the server rejects frames whose clock is off).
//
//   node scripts/camera-sim.mjs --key <cameraId.secret> --file frame.jpg
//   node scripts/camera-sim.mjs --key <cameraId.secret> --folder ./frames --interval 5
//
// Get a key from an administrator: Evidence tab -> "Install a camera" (shown once), or POST /api/projects/:pid/cameras.
// Options: --url http://localhost:4000 (default)   --interval seconds between frames (folder mode, default 5)
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const base = args.url || 'http://localhost:4000';
if (!args.key || !(args.file || args.folder)) {
  console.error('usage: node scripts/camera-sim.mjs --key <cameraId.secret> (--file <image> | --folder <dir> [--interval s])');
  process.exit(2);
}
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' };

async function send(file) {
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) { console.log(`skip ${file}: not an image`); return; }
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  form.append('captured_at', new Date().toISOString());
  const res = await fetch(`${base}/api/ingest/frame`, { method: 'POST', headers: { 'x-camera-key': args.key }, body: form });
  const body = await res.json().catch(() => ({}));
  console.log(`${res.status} ${path.basename(file)}`, res.ok ? JSON.stringify(body.analysis) : body.error?.message);
}

const files = args.file ? [args.file] : fs.readdirSync(args.folder).sort().map((f) => path.join(args.folder, f));
for (const [i, f] of files.entries()) {
  await send(f);
  if (i < files.length - 1) await new Promise((r) => setTimeout(r, Number(args.interval || 5) * 1000));
}
