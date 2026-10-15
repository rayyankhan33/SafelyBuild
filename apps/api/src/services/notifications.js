// In-app notifications. Each notification belongs to one recipient; a user only ever sees their own.
// First use: every admin of the organisation is told when an engineer creates a project.
import { notFound } from '../http.js';

/** One notification per active admin in the organisation. Returns how many were created. */
export async function notifyAdmins(db, orgId, { kind, title, body, projectId = null }) {
  const r = await db.query(
    `INSERT INTO notifications (org_id, user_id, kind, title, body, project_id)
     SELECT $1, u.id, $2, $3, $4, $5 FROM users u WHERE u.org_id = $1 AND u.role = 'admin' AND u.is_active`,
    [orgId, kind, title, body, projectId]);
  return r.rowCount;
}

export async function listNotifications(db, userId, { limit = 30 } = {}) {
  const { rows } = await db.query(
    `SELECT id, kind, title, body, project_id, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]);
  const unread = (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId])).rows[0].n;
  return { notifications: rows, unread };
}

export async function markRead(db, userId, id) {
  const r = await db.query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rowCount) throw notFound('notification'); // someone else's notification looks the same as a missing one
}

export async function markAllRead(db, userId) {
  const r = await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return r.rowCount;
}
