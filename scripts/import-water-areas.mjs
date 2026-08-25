// Load the WDFW marine polygons into water_areas (migration 005).
//   node scripts/import-water-areas.mjs prod
// Idempotent: clears and reloads, since the table has no dependents.
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
if (!url) { console.error('usage: node scripts/import-water-areas.mjs dev|prod'); process.exit(1); }

// Salish Sea only. The outer-coast areas (Ilwaco, Westport, La Push, Neah Bay,
// Willapa, Grays Harbor, Oregon) are irrelevant here and would triple the load.
const KEEP = new Set(['5', '6', '7', '8-1', '8-2', '9', '10', '11', '12', '13']);

const sql = neon(url);
const ddl = readFileSync(join(root, 'db', 'migrations', '005_water_areas.sql'), 'utf8').replace(/--.*$/gm, '');
for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
  await sql(Object.assign([stmt], { raw: [stmt] }));
}
await sql`delete from water_areas`;

const gj = JSON.parse(readFileSync(join(root, 'db', 'wdfw-marine-areas.geojson'), 'utf8'));
let n = 0;
for (const f of gj.features) {
  if (!KEEP.has(f.properties.AreaName)) continue;
  // ST_Multi so a single-Polygon feature still fits the MultiPolygon column.
  await sql`
    insert into water_areas (area_name, area_title, wac, geom)
    values (${f.properties.AreaName}, ${f.properties.AreaTitle}, ${f.properties.WAC ?? null},
            st_multi(st_geomfromgeojson(${JSON.stringify(f.geometry)}))::geography)`;
  process.stdout.write(`\r  loaded ${++n}`);
}
console.log();
const [{ c }] = await sql`select count(*)::int as c from water_areas`;
const [{ km2 }] = await sql`select round((sum(st_area(geom))/1e6)::numeric) as km2 from water_areas`;
console.log(`water_areas: ${c} polygons, ${km2} km² of marine water`);
console.log(c === n ? 'ALL OK' : 'VERIFY FAILED');
