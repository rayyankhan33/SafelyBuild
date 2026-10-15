// Object storage behind a two-method interface. Sprint 1 stores files on local disk; swapping to
// S3/MinIO means re-implementing put() and read() only (the DB keeps just the storage_key).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp' };
export const ALLOWED_TYPES = Object.keys(EXT);

export async function put(projectId, buffer, contentType) {
  const ext = EXT[contentType];
  if (!ext) throw new Error(`unsupported content type ${contentType}`);
  const key = `${projectId}/${crypto.randomUUID()}.${ext}`;
  const file = resolve(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  return { key, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
}

export const read = (key) => fs.readFile(resolve(key));

// TEMPORARY test-footage frames live under testing/, apart from evidence.
export async function putTestFrame(projectId, runId, i, buffer) {
  const key = `testing/${projectId}/${runId}/${i}.jpg`;
  const file = resolve(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  return key;
}
export const removeTestRun = (projectId, runId) => fs.rm(resolve(`testing/${projectId}/${runId}`), { recursive: true, force: true });

function resolve(key) {
  const full = path.resolve(config.storageDir, key);
  // refuse keys that escape the storage directory (path traversal)
  if (!full.startsWith(path.resolve(config.storageDir) + path.sep)) throw new Error('invalid storage key');
  return full;
}

/** Sniff the real format from magic bytes: never trust the client's Content-Type. */
export function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}
