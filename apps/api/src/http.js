// Small HTTP helpers shared by all routes: error type, async wrapper, validation, auth, RBAC.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db/pool.js';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const bad = (message, details) => new HttpError(422, 'validation_error', message, details);

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse req[part] with a zod schema; throws a 422 listing every problem. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw bad('invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const uuid = z.string().uuid();

// ------------------------------------------------------------------ authentication
export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id }, config.jwtSecret, { expiresIn: config.jwtTtl });
}

export const requireAuth = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'unauthenticated', 'missing bearer token');
  let payload;
  try {
    payload = jwt.verify(h.slice(7), config.jwtSecret);
  } catch {
    throw new HttpError(401, 'unauthenticated', 'invalid or expired token');
  }
  // re-read the user so deactivation / role changes take effect immediately
  const { rows } = await pool.query(
    'SELECT id, org_id, email, full_name, role, pec_number, is_active FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0] || !rows[0].is_active) throw new HttpError(401, 'unauthenticated', 'account disabled');
  req.user = rows[0];
  next();
});

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'forbidden', `requires role: ${roles.join(' or ')}`));
  next();
};

/**
 * Loads :pid into req.project and enforces tenancy + membership.
 *  - project from another organisation  -> 404 (existence is not revealed)
 *  - admin                              -> all projects in their org
 *  - engineer / investor                -> only projects they are a member of
 *  - write=true                         -> investors are refused (read-only role)
 */
export const projectAccess = ({ write = false } = {}) => wrap(async (req, _res, next) => {
  const pid = req.params.pid;
  if (!uuid.safeParse(pid).success) throw notFound('project');
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1 AND org_id = $2', [pid, req.user.org_id]);
  if (!rows[0]) throw notFound('project');
  if (req.user.role !== 'admin') {
    const m = await pool.query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [pid, req.user.id]);
    if (!m.rowCount) throw notFound('project');
  }
  if (write && req.user.role === 'investor') throw new HttpError(403, 'forbidden', 'investors have read-only access');
  req.project = rows[0];
  next();
});

/**
 * Append to the audit trail. The actor is recorded both as a user id (cleared if the account is later
 * deleted) and as text, so the trail still says who did it. `req.actor` overrides the label (cameras).
 */
export async function audit(db, req, action, entity, entityId, details = {}) {
  const label = req.actor ?? (req.user ? `${req.user.full_name} (${req.user.role})` : null);
  await db.query(
    'INSERT INTO audit_log (project_id, user_id, actor_label, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.project?.id ?? null, req.user?.id ?? null, label, action, entity, entityId ?? null, details]);
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'malformed JSON body' } });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'too_large', message: 'file too large' } });
  if (err?.code === '23505') return res.status(409).json({ error: { code: 'conflict', message: 'already exists' } });
  if (err?.code === '23503') return res.status(422).json({ error: { code: 'validation_error', message: 'references a record that does not exist' } });
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'unexpected server error' } });
}

/** Tiny in-memory limiter for login attempts: 5 failures per 15 minutes per email+ip. */
export function makeLoginLimiter({ max = 5, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  return {
    blocked(key) {
      const now = Date.now();
      const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      hits.set(key, arr);
      return arr.length >= max;
    },
    fail(key) { hits.set(key, [...(hits.get(key) ?? []), Date.now()]); },
    reset(key) { hits.delete(key); },
  };
}
