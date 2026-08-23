// Apply + verify migration 004 (PostGIS extension).
//   node scripts/apply-004.mjs dev|prod
// Idempotent: create extension if not exists, and verifies the version.
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
  console.error('usage: node scripts/apply-004.mjs dev|prod');
  process.exit(1);
}
console.log(`target: ${target} (${new URL(url).host})`);
const sql = neon(url);

const [ext] = await sql`select extversion from pg_extension where extname = 'postgis'`;
if (ext) {
  console.log('postgis already installed, version', ext.extversion);
} else {
  const ddl = readFileSync(join(root, 'db', 'migrations', '004_postgis.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
    await sql(Object.assign([stmt], { raw: [stmt] }));
  }
  console.log('DDL applied');
}

const [now] = await sql`select extversion from pg_extension where extname = 'postgis'`;
const [check] = await sql`
  select round(st_distance(
    st_setsrid(st_makepoint(-123.1524506, 48.5158709), 4326)::geography,
    st_setsrid(st_makepoint(-123.1578, 48.5165), 4326)::geography
  )::numeric, 1) as metres`;
console.log('postgis version:', now?.extversion);
console.log('sanity check — lighthouse to webcam point:', check.metres, 'm (expected ~400)');
console.log(now && Number(check.metres) > 300 && Number(check.metres) < 500 ? 'ALL OK' : 'VERIFY FAILED');
