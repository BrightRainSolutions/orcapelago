// Apply + verify migration 003 (landmarks table + sightings.landmark_id).
//   node scripts/apply-003.mjs dev|prod
// Idempotent: skips if the landmarks table already exists.
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
  console.error('usage: node scripts/apply-003.mjs dev|prod');
  process.exit(1);
}
console.log(`target: ${target} (${new URL(url).host})`);
const sql = neon(url);

const existing = await sql`
  select 1 from information_schema.tables where table_name = 'landmarks'`;
if (existing.length) {
  console.log('landmarks table already exists — skipping DDL');
} else {
  // The HTTP driver runs one statement per call. Strip ALL -- comments FIRST
  // (full-line and trailing), then split on ';' — comments can contain
  // semicolons and a leading comment block makes a statement look skippable.
  // Both failure modes caught on the dev branch, 2026-08-19. (Safe here: no
  // string literals in this DDL contain '--'.)
  const ddl = readFileSync(join(root, 'db', 'migrations', '003_landmarks.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
    await sql(Object.assign([stmt], { raw: [stmt] }));
  }
  console.log('DDL applied');
}

const [tbl] = await sql`select count(*)::int as n from landmarks`;
const [fk] = await sql`
  select data_type, is_nullable from information_schema.columns
  where table_name = 'sightings' and column_name = 'landmark_id'`;
const idx = await sql`
  select indexname from pg_indexes where tablename = 'landmarks' order by 1`;
console.log(`landmarks rows: ${tbl.n}; sightings.landmark_id:`, fk, '; indexes:', idx.map((i) => i.indexname).join(', '));
console.log(fk?.data_type === 'uuid' && fk?.is_nullable === 'YES' ? 'ALL OK' : 'VERIFY FAILED');
