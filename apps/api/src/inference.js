// HTTP client for the Python inference service (services/inference/service.py).
// Contract documented in docs/design.md section 4. Every call has a timeout; failures are
// thrown as InferenceError so callers can record a failed run instead of losing the upload.
import { config } from './config.js';

export class InferenceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(path, form, query = '') {
  let res;
  try {
    res = await fetch(`${config.inferenceUrl}${path}${query}`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(config.inferenceTimeoutMs),
    });
  } catch (e) {
    throw new InferenceError(e.name === 'TimeoutError' ? 'inference service timed out' : `inference service unreachable (${e.cause?.code ?? e.message})`);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail ?? msg; } catch { /* keep status text */ }
    throw new InferenceError(`inference service refused the request: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
  }
  return res.json();
}

const blob = (buf, type) => new Blob([buf], { type: type || 'application/octet-stream' });

export function analyseDefects(buf, contentType, { minViolation = 'Medium' } = {}) {
  const f = new FormData();
  f.append('image', blob(buf, contentType), 'upload');
  return call('/v1/defects', f, `?min_violation=${encodeURIComponent(minViolation)}`);
}

export function analyseActivity(prevBuf, prevType, currBuf, currType) {
  const f = new FormData();
  f.append('previous', blob(prevBuf, prevType), 'previous');
  f.append('current', blob(currBuf, currType), 'current');
  return call('/v1/activity', f);
}

export function proposeMaterials(buf, contentType) {
  const f = new FormData();
  f.append('image', blob(buf, contentType), 'upload');
  return call('/v1/materials', f);
}

export async function inferenceHealth() {
  try {
    const res = await fetch(`${config.inferenceUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? { ok: true, ...(await res.json()) } : { ok: false };
  } catch {
    return { ok: false };
  }
}
