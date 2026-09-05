// Verify the Neon database is set up correctly: schema, extension, indexes,
// seed data — then invoke the read functions end-to-end against it.
//   node scripts/check-db.mjs [--seed]   (--seed: seed gazetteer if empty)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// minimal .env loader (KEY=VALUE lines) — no dotenv dependency
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.DATABASE_URL) {
  console.error('FAIL: DATABASE_URL missing from .env');
  process.exit(1);
}
console.log('host:', new URL(env.DATABASE_URL).host);

const sql = neon(env.DATABASE_URL);
const runRaw = (text) =>
  sql.query ? sql.query(text) : sql(Object.assign([text], { raw: [text] }));

const tables = await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' order by 1`;
console.log('tables:', tables.map((t) => t.table_name).join(', ') || '(none)');

const expected = ['gazetteer', 'landmarks', 'newsletters', 'sightings'];
const missing = expected.filter((t) => !tables.some((r) => r.table_name === t));
if (missing.length) {
  console.error('FAIL: missing tables:', missing.join(', '));
  process.exit(1);
}

const ext = await sql`select 1 from pg_extension where extname = 'pg_trgm'`;
console.log('pg_trgm extension:', ext.length ? 'ok' : 'MISSING');

const idx = await sql`
  select indexname from pg_indexes
  where schemaname = 'public' and indexname like 'idx_%' order by 1`;
console.log('indexes:', idx.map((i) => i.indexname).join(', ') || '(none)');

const [{ n: gazCount }] = await sql`select count(*)::int as n from gazetteer`;
console.log('gazetteer rows:', gazCount);

if (gazCount === 0 && process.argv.includes('--seed')) {
  await runRaw(readFileSync(join(root, 'db', 'seed-gazetteer.sql'), 'utf8'));
  const [{ n }] = await sql`select count(*)::int as n from gazetteer`;
  console.log('seeded gazetteer rows:', n);
}

// End-to-end: invoke the actual function handlers against this database.
process.env.DATABASE_URL = env.DATABASE_URL;
const { default: getSightings } = await import('../netlify/functions/get-sightings.mjs');
const { default: getNewsletters } = await import('../netlify/functions/get-newsletters.mjs');

const sightingsRes = await getSightings(new Request('http://local/api/sightings?limit=10'));
const sightingsBody = await sightingsRes.json();
console.log(
  'get-sightings:', sightingsRes.status,
  '| cache:', sightingsRes.headers.get('cache-control'),
  '| features:', sightingsBody.features?.length ?? '(not geojson)'
);

const newslettersRes = await getNewsletters();
const newslettersBody = await newslettersRes.json();
console.log('get-newsletters:', newslettersRes.status, '| rows:', newslettersBody.newsletters?.length);

console.log(sightingsRes.status === 200 && newslettersRes.status === 200 ? 'ALL OK' : 'CHECK FAILED');
