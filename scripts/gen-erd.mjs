// Generates docs/erd.md (Mermaid ER diagram) from the live PostgreSQL schema, so the diagram
// can never drift from the migrations. A test (apps/api/test/schema.test.js) fails if it does.
// Usage: npm run docs:erd
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/erd.md');

export async function buildErd(db) {
  const cols = (await db.query(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.ordinal_position
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'schema_migrations'
    ORDER BY c.table_name, c.ordinal_position`)).rows;
  const keys = (await db.query(`
    SELECT tc.table_name, kcu.column_name, tc.constraint_type
    FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')`)).rows;
  const fks = (await db.query(`
    SELECT cl.relname AS child, pt.relname AS parent, a.attname AS child_col, a.attnotnull AS required
    FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class pt ON pt.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
    WHERE k.contype = 'f' AND n.nspname = 'public' ORDER BY cl.relname, pt.relname, a.attname`)).rows;

  const pk = new Set(keys.filter((k) => k.constraint_type === 'PRIMARY KEY').map((k) => `${k.table_name}.${k.column_name}`));
  const fk = new Set(fks.map((f) => `${f.child}.${f.child_col}`));
  const byTable = {};
  for (const c of cols) (byTable[c.table_name] ??= []).push(c);

  const lines = ['erDiagram'];
  for (const [t, cs] of Object.entries(byTable)) {
    lines.push(`  ${t} {`);
    for (const c of cs) {
      const type = (c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type === 'ARRAY' ? `${c.udt_name.replace(/^_/, '')}_array` : c.data_type).replace(/ /g, '_');
      const flag = pk.has(`${t}.${c.column_name}`) ? 'PK' : fk.has(`${t}.${c.column_name}`) ? 'FK' : '';
      lines.push(`    ${type} ${c.column_name}${flag ? ` ${flag}` : ''}`);
    }
    lines.push('  }');
  }
  const seen = new Set();
  for (const f of fks) {
    const key = `${f.parent}-${f.child}-${f.child_col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${f.parent} ${f.required ? '||--o{' : '|o--o{'} ${f.child} : "${f.child_col}"`);
  }
  return `# Entity-relationship diagram (generated)\n\nGenerated from the live PostgreSQL schema by \`npm run docs:erd\`. Do not edit by hand: the test \`schema.test.js\` fails if this file drifts from the migrations.\n\n\`\`\`mermaid\n${lines.join('\n')}\n\`\`\`\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pool } = await import('../apps/api/src/db/pool.js');
  const { migrate } = await import('../apps/api/src/db/migrate.js');
  await migrate(pool);
  fs.writeFileSync(OUT, await buildErd(pool));
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
  await pool.end();
}
