// Thin fetch wrapper. Token lives in sessionStorage (cleared when the tab closes).
const KEY = 'sb_session';
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

export const session = {
  get: () => safe(() => JSON.parse(sessionStorage.getItem(KEY))),
  set: (s) => safe(() => sessionStorage.setItem(KEY, JSON.stringify(s))),
  clear: () => safe(() => sessionStorage.removeItem(KEY)),
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `request failed (${status})`);
    this.status = status;
    this.details = body?.error?.details;
  }
}

export async function api(method, path, body) {
  const s = session.get();
  const headers = {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (s?.token) headers.authorization = `Bearer ${s.token}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Is the API running?' } });
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401 && s) { session.clear(); window.location.assign('/login'); }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export async function fetchBlobUrl(path) {
  const s = session.get();
  const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${s?.token}` } });
  if (!res.ok) throw new Error('image unavailable');
  return URL.createObjectURL(await res.blob());
}

// ---- formatting helpers
export function pkr(n) {
  if (n === null || n === undefined) return '-';
  const a = Math.abs(n); const sign = n < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}PKR ${(a / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `${sign}PKR ${(a / 1e5).toFixed(2)} lakh`;
  return `${sign}PKR ${Math.round(a).toLocaleString('en-PK')}`;
}
export const pkrFull = (n) => `PKR ${Math.round(n).toLocaleString('en-PK')}`;
export const dateText = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-');
export const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const isoToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/** status keyword -> { tone, label, icon } ; tone maps to the fixed status palette. Icon + label always shown. */
const S = {
  low: ['good', 'Low risk', '✓'], moderate: ['warning', 'Moderate', '!'], high: ['serious', 'High', '▲'], critical: ['critical', 'Critical', '✕'], no_data: ['neutral', 'No inspections yet', '–'],
  on_track: ['good', 'On track', '✓'], ahead: ['good', 'Ahead of schedule', '✓'], under_budget: ['good', 'Under budget', '✓'], completed: ['good', 'Completed', '✓'],
  at_risk: ['warning', 'At risk', '!'], over_budget: ['critical', 'Over budget', '✕'], behind: ['critical', 'Behind schedule', '✕'], completed_late: ['serious', 'Completed late', '▲'],
  insufficient_data: ['neutral', 'Gathering data', '…'], not_started: ['neutral', 'Not started', '–'], no_budget: ['neutral', 'No budget set', '–'],
};
export const statusInfo = (k, overrides = {}) => {
  const [tone, label, icon] = S[k] ?? ['neutral', k, '–'];
  return { tone, label: overrides[k] ?? label, icon };
};
