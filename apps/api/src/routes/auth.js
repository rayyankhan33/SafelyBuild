import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import {
  HttpError, audit, checkPassword, hashPassword, makeLoginLimiter, parse, requireAuth, requireRole, signToken, wrap,
} from '../http.js';

export const router = Router();
const limiter = makeLoginLimiter();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const key = `${email.toLowerCase()}|${req.ip}`;
  if (limiter.blocked(key)) throw new HttpError(429, 'too_many_attempts', 'too many failed logins; try again in 15 minutes');
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const u = rows[0];
  // same message for unknown user and wrong password, so accounts cannot be enumerated
  if (!u || !u.is_active || !(await checkPassword(password, u.password_hash))) {
    limiter.fail(key);
    throw new HttpError(401, 'invalid_credentials', 'incorrect email or password');
  }
  limiter.reset(key);
  res.json({ token: signToken(u), user: publicUser(u) });
}));

router.get('/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

const newUser = z.object({
  email: z.string().email(), full_name: z.string().min(1).max(120),
  password: z.string().min(8, 'at least 8 characters'), role: z.enum(['admin', 'engineer', 'investor']),
  pec_number: z.string().max(40).optional(),
});

router.post('/users', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const b = parse(newUser, req.body);
  const { rows } = await pool.query(
    `INSERT INTO users (org_id, email, password_hash, full_name, role, pec_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.org_id, b.email.toLowerCase(), await hashPassword(b.password), b.full_name, b.role, b.pec_number ?? null]);
  await audit(pool, req, 'create', 'user', rows[0].id, { role: b.role });
  res.status(201).json({ user: publicUser(rows[0]) });
}));

router.get('/users', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE org_id = $1 ORDER BY full_name', [req.user.org_id]);
  res.json({ users: rows.map(publicUser) });
}));

export const publicUser = (u) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, pec_number: u.pec_number ?? null, org_id: u.org_id });
