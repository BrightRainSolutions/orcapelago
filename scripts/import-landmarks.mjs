// Import GNIS marine features into the landmarks table (architecture §12).
//   node scripts/import-landmarks.mjs <DomesticNames_XX.txt> dev|prod
//
// Filters the pipe-delimited GNIS DomesticNames file to marine feature
// classes inside the Salish Sea bbox (spec companion note), validates, and
// bulk-inserts. Idempotent: `on conflict (gnis_id) do nothing`, so re-running
// against a refreshed GNIS file only adds what's new.
//
// DEDUPE CAVEAT: `on conflict (gnis_id) do nothing` only protects rows that
// HAVE a gnis_id. Manual landmarks (source='manual', gnis_id=null) are
// invisible to it — so if a feature is later accepted into GNIS and appears in
// a refreshed file, importing produces a second row for the same place. As of
// 2026-08-20 that applies to Hidden Beach. Check for name collisions against
// source='manual' rows after any re-import.
//
// Class list decided 2026-08-19 from profiling the real WA file — note GNIS
// files passages/sounds/harbors under Bay, reefs/shoals under Bar,
// points/heads under Cape. Populated Place deliberately excluded (inland
// centroids). Land features (beaches, bluffs) deliberately INCLUDED.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

// Water features label the map AND resolve positions; populated places do
// neither — they are imported solely to anchor the AI geocoder, which is why
// lib/geocode.js filters stage 2b to WATER_CLASSES and get-landmarks.mjs
// ships only the labellable classes. Re-running is safe: the insert ends in
// `on conflict (gnis_id) do nothing`, and sightings.landmark_id is a NO
// ACTION foreign key, so existing rows must keep their ids.
const CLASSES = new Set(['Bay', 'Cape', 'Island', 'Bar', 'Beach', 'Cliff', 'Pillar', 'Gut', 'Channel', 'Sea', 'Populated Place']);
const BBOX = { latMin: 46.9, latMax: 50.0, lngMin: -125.5, lngMax: -121.9 };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const [file, target] = process.argv.slice(2);
const url = target === 'dev' ? env.DEV_DATABASE_URL : target === 'prod' ? env.DATABASE_URL : null;
if (!file || !url) {
  console.error('usage: node scripts/import-landmarks.mjs <DomesticNames_XX.txt> dev|prod');
  process.exit(1);
}
console.log(`target: ${target} (${new URL(url).host})`);

// --- parse + filter ---
// GNIS ships with a UTF-8 BOM, which would corrupt the first column name.
const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
const col = Object.fromEntries(lines[0].split('|').map((h, i) => [h, i]));
for (const required of ['feature_id', 'feature_name', 'feature_class', 'county_name', 'prim_lat_dec', 'prim_long_dec']) {
  if (!(required in col)) {
    console.error(`FAIL: column "${required}" missing — GNIS format changed?`);
    process.exit(1);
  }
}

const rows = [];
const byClass = {};
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const f = line.split('|');
  const cls = f[col.feature_class];
  if (!CLASSES.has(cls)) continue;
  const lat = parseFloat(f[col.prim_lat_dec]);
  const lng = parseFloat(f[col.prim_long_dec]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
  if (lat < BBOX.latMin || lat > BBOX.latMax || lng < BBOX.lngMin || lng > BBOX.lngMax) continue;
  rows.push({
    gnis_id: f[col.feature_id],
    name: f[col.feature_name].trim(),
    feature_class: cls,
    lat,
    lng,
    county: f[col.county_name]?.trim() || null
  });
  byClass[cls] = (byClass[cls] ?? 0) + 1;
}

// --- validate before touching the database ---
console.log(`filtered: ${rows.length} rows`, byClass);
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
if (rows.length < 1000 || rows.length > 5000) fail(`row count ${rows.length} outside sane range — check filters`);
const ids = new Set(rows.map((r) => r.gnis_id));
if (ids.size !== rows.length) fail('duplicate gnis_id in filtered set');
for (const probe of ['Penn Cove', 'Bush Point', 'Alki Beach', 'Protection Island', 'Saratoga Passage']) {
  if (!rows.some((r) => r.name === probe)) fail(`probe "${probe}" not in filtered set`);
}
if (!rows.every((r) => r.name.length > 0)) fail('empty name');

// --- load: batched multi-row inserts (the HTTP driver is one statement per
// call, so literals are built by hand; names carry apostrophes — escape) ---
const sql = neon(url);
const esc = (s) => (s === null ? 'null' : `'${s.replace(/'/g, "''")}'`);
let inserted = 0;
for (let i = 0; i < rows.length; i += 100) {
  const batch = rows.slice(i, i + 100);
  const values = batch
    .map((r) => `(${esc(r.gnis_id)}, ${esc(r.name)}, ${esc(r.feature_class)}, ${r.lat}, ${r.lng}, ${esc(r.county)})`)
    .join(',\n');
  const stmt = `insert into landmarks (gnis_id, name, feature_class, lat, lng, county)
    values ${values}
    on conflict (gnis_id) do nothing`;
  await sql(Object.assign([stmt], { raw: [stmt] }));
  inserted += batch.length;
  process.stdout.write(`\r  sent ${inserted}/${rows.length}`);
}
console.log();

// --- verify in the database ---
const [{ n }] = await sql`select count(*)::int as n from landmarks`;
const dbClasses = await sql`select feature_class, count(*)::int as n from landmarks group by 1 order by 2 desc`;
console.log(`landmarks table now holds ${n} rows:`, Object.fromEntries(dbClasses.map((r) => [r.feature_class, r.n])));
const [penn] = await sql`select name, feature_class, lat, lng from landmarks where name = 'Penn Cove'`;
console.log('probe:', penn);
console.log(n >= rows.length && penn ? 'ALL OK' : 'VERIFY FAILED');
