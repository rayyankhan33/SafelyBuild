-- Migration 005: account deletion and admin notifications.
--
-- 1. notifications: in-app messages to a user (first use: every admin is told when a project is created).
-- 2. audit_log.actor_label: who acted, as text at the time of the action, so the trail still names the
--    person after their account is deleted.
-- 3. Every foreign key that points at users(id) now survives the user's deletion: references from
--    NOT NULL columns (membership, notifications) are removed with the user; references from nullable
--    columns (created_by, uploaded_by, acknowledged_by, ...) become NULL. Projects, estimates, frames and
--    alerts created by a deleted user are kept.

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),           -- recipient (re-pointed to CASCADE below)
  kind        text NOT NULL,                                -- e.g. 'project_created'
  title       text NOT NULL,
  body        text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);

ALTER TABLE audit_log ADD COLUMN actor_label text;
UPDATE audit_log a SET actor_label = u.full_name || ' (' || u.role || ')' FROM users u WHERE u.id = a.user_id AND a.actor_label IS NULL;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS tbl, a.attname, a.attnotnull
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND con.confrelid = 'users'::regclass AND array_length(con.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE %s',
                   r.tbl, r.conname, r.attname, CASE WHEN r.attnotnull THEN 'CASCADE' ELSE 'SET NULL' END);
  END LOOP;
END $$;
