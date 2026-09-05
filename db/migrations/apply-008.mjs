// Apply + verify migration 008 (geo_method 'catalog' -> 'gazetteer').
//   node db/migrations/apply-008.mjs --yes
//
// Targets whatever DATABASE_URL points at, and prints the host first. Must be
// applied together with the code change: a database holding both values would
// hide the old rows from anything matching on the new name.
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
  console.error("This rewrites geo_method on every 'catalog' row of the database above.");
  console.error('Re-run with --yes if that is the one you mean.');
  process.exit(1);
}
const sql = neon(url);

const [before] = await sql`
  select count(*) filter (where geo_method = 'catalog')::int as legacy,
         count(*) filter (where geo_method = 'gazetteer')::int as renamed
  from sightings`;
console.log(`before: ${before.legacy} 'catalog', ${before.renamed} 'gazetteer'`);

const ddl = readFileSync(join(root, 'db', 'migrations', '008_gazetteer_geo_method.sql'), 'utf8')
  .replace(/--.*$/gm, '');
for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
  await sql(Object.assign([stmt], { raw: [stmt] }));
}

const [after] = await sql`
  select count(*) filter (where geo_method = 'catalog')::int as legacy,
         count(*) filter (where geo_method = 'gazetteer')::int as renamed
  from sightings`;
console.log(`after:  ${after.legacy} 'catalog', ${after.renamed} 'gazetteer'`);
console.log('distinct geo_method values now:');
for (const r of await sql`select geo_method, count(*)::int as n from sightings group by geo_method order by n desc`) {
  console.log(`  ${String(r.n).padStart(5)}  ${r.geo_method}`);
}
console.log(after.legacy === 0 ? 'ALL OK' : 'VERIFY FAILED');
