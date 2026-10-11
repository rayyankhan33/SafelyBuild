// Applies db/migrations/*.sql in filename order, once each, recording them in schema_migrations.
// CLI: npm run db:migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTx } from './pool.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

export async function migrate(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await withTx(db, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

/** Test helper: wipe the public schema and re-apply every migration. */
export async function resetDatabase(db = pool) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  return migrate(db);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  await pool.end();
}
