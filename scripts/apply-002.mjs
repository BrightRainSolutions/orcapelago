// Apply + verify migration 002 (detection_methods). Same procedure for the
// rehearsal branch and production:
//   node scripts/apply-002.mjs dev    → uses DEV_DATABASE_URL
//   node scripts/apply-002.mjs prod   → uses DATABASE_URL
// Idempotent: skips the ALTER if the column already exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const target = process.argv[2];
const url = target === 'dev' ? env.DEV_DATABASE_URL : target === 'prod' ? env.DATABASE_URL : null;
if (!url) {
  console.error('usage: node scripts/apply-002.mjs dev|prod (and the matching URL in .env)');
  process.exit(1);
}
console.log(`target: ${target} (${new URL(url).host})`);
const sql = neon(url);

const existing = await sql`
  select data_type, column_default, is_nullable
  from information_schema.columns
  where table_name = 'sightings' and column_name = 'detection_methods'`;
if (existing.length) {
  console.log('column already exists — skipping ALTER');
} else {
  const ddl = readFileSync(join(root, 'db', 'migrations', '002_detection_methods.sql'), 'utf8');
  // This driver version has no sql.query(); fake a tagged-template call.
  await sql(Object.assign([ddl], { raw: [ddl] }));
  console.log('ALTER applied');
}

const [col] = await sql`
  select data_type, column_default, is_nullable
  from information_schema.columns
  where table_name = 'sightings' and column_name = 'detection_methods'`;
console.log('column:', col);
if (col.data_type !== 'ARRAY' || col.is_nullable !== 'NO') {
  console.error('FAIL: column shape unexpected');
  process.exit(1);
}

const [{ n }] = await sql`select count(*)::int as n from sightings`;
const [empty] = await sql`select detection_methods from sightings limit 1`;
console.log(`rows: ${n}; existing row default reads back as:`, empty.detection_methods);

// Round-trip: insert with the new column, read back, delete.
const [{ id: newsletterId }] = await sql`select id from newsletters limit 1`;
const [inserted] = await sql`
  insert into sightings
    (newsletter_id, sighting_date, species, location_raw, detection_methods)
  values (${newsletterId}, '2000-01-01', 'other', '__migration_002_test__', ${['hydrophone', 'webcam']})
  returning id, detection_methods`;
console.log('round-trip insert:', inserted.detection_methods);
await sql`delete from sightings where id = ${inserted.id}`;
const ok = inserted.detection_methods.length === 2 && inserted.detection_methods[0] === 'hydrophone';
console.log('test row deleted;', ok ? 'ROUND-TRIP OK' : 'ROUND-TRIP FAILED');

// The real read path, against this target.
process.env.DATABASE_URL = url;
const { default: getSightings } = await import('../netlify/functions/get-sightings.mjs');
const res = await getSightings(new Request('http://local/api/sightings?limit=3'));
const body = await res.json();
const first = body.features?.[0]?.properties ?? {};
console.log(
  `get-sightings: ${res.status}; feature carries detection_methods:`,
  'detection_methods' in first, `(value: ${JSON.stringify(first.detection_methods)})`
);
console.log(res.status === 200 && 'detection_methods' in first && ok ? 'ALL OK' : 'VERIFY FAILED');
