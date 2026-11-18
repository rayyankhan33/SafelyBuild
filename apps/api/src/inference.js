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

async function call(path, form, query = '', headers = undefined) {
  let res;
  try {
    res = await fetch(`${config.inferenceUrl}${path}${query}`, {
      method: 'POST', body: form, headers, signal: AbortSignal.timeout(config.inferenceTimeoutMs),
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

export function analyseDefects(buf, contentType, { minViolation = 'Medium', backend = null } = {}) {
  const f = new FormData();
  f.append('image', blob(buf, contentType), 'upload');
  return call('/v1/defects', f, `?min_violation=${encodeURIComponent(minViolation)}${backend ? `&backend=${encodeURIComponent(backend)}` : ''}`);
}

export function analyseActivity(prevBuf, prevType, currBuf, currType) {
  const f = new FormData();
  f.append('previous', blob(prevBuf, prevType), 'previous');
  f.append('current', blob(currBuf, currType), 'current');
  return call('/v1/activity', f);
}

export function analyseStage(buf, contentType, elementType, { backend = null } = {}) {
  const f = new FormData();
  f.append('image', blob(buf, contentType), 'frame');
  return call('/v1/stage', f, `?element_type=${encodeURIComponent(elementType)}${backend ? `&backend=${encodeURIComponent(backend)}` : ''}`);
}

export function analyseInventory(buf, contentType, scaleMPerPx) {
  const f = new FormData();
  f.append('image', blob(buf, contentType), 'frame');
  return call('/v1/inventory', f, `?scale_m_per_px=${encodeURIComponent(scaleMPerPx)}`);
}

/** Tamper and fault screening of one frame against earlier frames of the same camera (newest first). */
export function analyseHealth(buf, contentType, refs = []) {
  const f = new FormData();
  f.append('image', blob(buf, contentType), 'frame');
  for (const r of refs) f.append('refs', blob(r.buffer, r.contentType), 'ref');
  return call('/v1/health', f);
}

/**
 * Completion forecast from a percent-complete history (services/inference/schedule_forecast, docs/handoff-schedule-assistant.md section 4).
 * payload: {start_date, as_of, observations: [{day, pct}], planned_duration_days?, planned_pct_now?, floors?, pace_factor?}
 * Resolves to {baseline, ml, blend, model_version}. Throws InferenceError like every other call.
 */
export function scheduleForecast(payload) {
  return call('/v1/schedule/forecast', JSON.stringify(payload), '', { 'content-type': 'application/json' });
}

export async function inferenceHealth() {
  try {
    const res = await fetch(`${config.inferenceUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? { ok: true, ...(await res.json()) } : { ok: false };
  } catch {
    return { ok: false };
  }
}
