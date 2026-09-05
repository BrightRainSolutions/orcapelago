// Apply + verify migration 007 (reasoning onto sightings, drop candidates).
//   node db/migrations/apply-007.mjs --yes
//
// Targets whatever DATABASE_URL points at, like every other script, and prints
// the host before doing anything. The older apply-00N runners take dev|prod and
// read two different variables; this one does not, because the dev/prod switch
// here is a hand-edit of DATABASE_URL and "prod" would be a lie the moment that
// variable points at a branch. This migration DROPS A TABLE, so it asks.
//
// Reports how many rows carried reasoning across before the table is dropped,
// because that number cannot be recovered afterwards.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = env.DATABASE_URL;
if (!url) {
  console.error('FAIL: DATABASE_URL missing from .env');
  process.exit(1);
}
console.log(`target: ${new URL(url).host}`);
if (!process.argv.includes('--yes')) {
  console.error('');
  console.error('This DROPS geocode_candidates on the database above.');
  console.error('Re-run with --yes if that is the one you mean.');
  process.exit(1);
}
const sql = neon(url);

const [before] = await sql`
  select count(*)::int as n from information_schema.tables
  where table_name = 'geocode_candidates'`;
if (before.n) {
  const [c] = await sql`select count(*)::int as n from geocode_candidates where ai_reasoning is not null`;
  console.log(`geocode_candidates present, ${c.n} rows carry reasoning`);
} else {
  console.log('geocode_candidates already gone — re-running is safe');
}

const ddl = readFileSync(join(root, 'db', 'migrations', '007_reasoning_on_sightings.sql'), 'utf8')
  .replace(/--.*$/gm, '');
for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
  await sql(Object.assign([stmt], { raw: [stmt] }));
}
console.log('DDL applied');

const [after] = await sql`
  select count(*)::int as total,
         count(ai_reasoning)::int as with_reasoning
  from sightings where geo_method = 'ai'`;
const [gone] = await sql`
  select count(*)::int as n from information_schema.tables
  where table_name = 'geocode_candidates'`;
console.log(`sightings: ${after.with_reasoning} of ${after.total} AI rows now carry reasoning`);
console.log(`geocode_candidates dropped: ${gone.n === 0 ? 'yes' : 'NO'}`);
console.log(gone.n === 0 && after.with_reasoning > 0 ? 'ALL OK' : 'VERIFY FAILED');
