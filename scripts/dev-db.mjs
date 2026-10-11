// Starts a local PostgreSQL for development without Docker or a system install.
// Uses the `embedded-postgres` npm package (real PostgreSQL binaries). Data lives in .pgdata/.
// Usage: npm run db:start   (leave running; Ctrl+C stops it cleanly)
// For production-like setups use docker-compose.yml instead.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseDir = path.join(root, '.pgdata');
const port = Number(process.env.PGPORT || 5432);
const DB = process.env.PGDATABASE || 'safelybuild';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres', // local development only
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'], // UTF-8 so names/notes in any script are stored safely
});

const fresh = !fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(DB);
console.log(`PostgreSQL ready on port ${port}, database "${DB}" (${fresh ? 'newly created' : 'existing data'}).`);
console.log('Press Ctrl+C to stop.');

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30); // keep alive
