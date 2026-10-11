import pg from 'pg';
import { config } from '../config.js';

// DATE columns are returned as 'YYYY-MM-DD' strings and NUMERIC as numbers, so the pure domain
// code (which works on ISO date strings and numbers) can consume rows directly.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => Number(v)); // bigint (audit_log id) fits in a double here

export function makePool(url = config.databaseUrl) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export const pool = makePool();

/** Run fn inside a transaction; commits on success, rolls back on any error. */
export async function withTx(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
