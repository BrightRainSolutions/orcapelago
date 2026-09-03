// Score a regeocode proposal file BEFORE applying it.
//
// regeocode.mjs writes db/regeocode-proposed-*.json whether or not you asked
// it to write to the database. This reads that file and answers the only
// question that matters: are the new positions better than the old ones?
//
// "Better" is measured against the marine water mask — a whale that moves from
// land into water is an improvement, one that moves the other way is a
// regression. It is a proxy, not truth: a pin can move into water and still be
// in the wrong bay. But it is the one signal available without a human, and it
// is the failure a reader notices first.
//
// Free and read-only: no model call, no writes.
//
//   node scripts/score-proposals.mjs db/regeocode-proposed-261rows.json
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const { getSql } = await import('../lib/db.js');
const sql = getSql();

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/score-proposals.mjs <db/regeocode-proposed-*.json>');
  process.exit(1);
}
const { generated_for: scope, proposals } = JSON.parse(readFileSync(file, 'utf8'));

/** In-water flags for a set of points, one query. */
async function inWater(points) {
  if (!points.length) return [];
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const rows = await sql`
    with input as (
      select generate_subscripts(${lats}::float8[], 1) as i,
             unnest(${lats}::float8[]) as lat,
             unnest(${lngs}::float8[]) as lng
    )
    select i, exists (
      select 1 from water_areas_sub w
      where st_covers(w.geom, st_setsrid(st_makepoint(lng, lat), 4326)::geography)
    ) as wet
    from input order by i`;
  return rows.map((r) => r.wet);
}

const usable = proposals.filter((p) => p.before?.lat != null && Number.isFinite(p.lat));
const beforeWet = await inWater(usable.map((p) => p.before));
const afterWet = await inWater(usable.map((p) => ({ lat: p.lat, lng: p.lng })));

const R = 6371;
const km = (a, b) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = (((b.lng - a.lng) * Math.PI) / 180) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * R;
};

let rescued = 0, lost = 0, stayedWet = 0, stayedDry = 0;
const regressions = [];
const moves = [];
usable.forEach((p, i) => {
  const was = beforeWet[i], now = afterWet[i];
  if (!was && now) rescued++;
  else if (was && !now) { lost++; regressions.push(p); }
  else if (was) stayedWet++;
  else stayedDry++;
  moves.push(km(p.before, { lat: p.lat, lng: p.lng }));
});

const rows = usable.reduce((n, p) => n + p.ids.length, 0);
const pct = (n) => ((100 * n) / usable.length).toFixed(1) + '%';
const wetBefore = beforeWet.filter(Boolean).length;
const wetAfter = afterWet.filter(Boolean).length;
moves.sort((a, b) => a - b);

console.log(`proposals for: ${scope}`);
console.log(`${usable.length} strings covering ${rows} sightings\n`);
console.log(`in water BEFORE   ${wetBefore}  (${pct(wetBefore)})`);
console.log(`in water AFTER    ${wetAfter}  (${pct(wetAfter)})`);
console.log(`net change        ${wetAfter - wetBefore >= 0 ? '+' : ''}${wetAfter - wetBefore}\n`);
console.log(`  moved land -> water   ${rescued}   <- the win`);
console.log(`  moved water -> land   ${lost}   <- regressions`);
console.log(`  stayed in water       ${stayedWet}`);
console.log(`  stayed on land        ${stayedDry}`);
console.log(`\nmovement (km): median ${moves[Math.floor(moves.length / 2)]?.toFixed(2)}  max ${moves[moves.length - 1]?.toFixed(2)}`);

if (regressions.length) {
  console.log('\nREGRESSIONS — these were in water and would move onto land:');
  for (const p of regressions.slice(0, 12)) {
    console.log(`  ${p.location_raw.slice(0, 52)}`);
    console.log(`     ${p.before.lat.toFixed(4)},${p.before.lng.toFixed(4)}  ->  ${p.lat.toFixed(4)},${p.lng.toFixed(4)}`);
  }
  if (regressions.length > 12) console.log(`  ... and ${regressions.length - 12} more`);
}

// A verdict has to weigh MOVEMENT as well as water, because in-water alone is
// easy to satisfy wrongly: the previous run scored "apply it — 2 rescued, 0
// regressions" on a change whose median move was 15km, because a phrase-shaped
// gazetteer entry was dragging pins across the map into a different piece of
// water. Real corrections are mostly small; a large median move means
// something systematic is wrong, not that the geocoder got much better.
const net = wetAfter - wetBefore;
const median = moves[Math.floor(moves.length / 2)] ?? 0;
const bigMoves = moves.filter((m) => m > 25).length;
console.log('');
if (median > 5) {
  console.log(`VERDICT: inspect before applying. Median move is ${median.toFixed(1)}km —`);
  console.log('         corrections should be small. Something is relocating pins wholesale.');
} else if (bigMoves > usable.length * 0.1) {
  console.log(`VERDICT: inspect before applying. ${bigMoves} strings move more than 25km.`);
} else if (net > 0 && lost <= rescued / 4) {
  console.log(`VERDICT: apply it — ${rescued} rescued against ${lost} regressions, median move ${median.toFixed(2)}km.`);
} else if (net > 0) {
  console.log(`VERDICT: net positive but ${lost} regressions against ${rescued} rescues. Read the list.`);
} else {
  console.log('VERDICT: do not apply. The new positions are no better than the stored ones.');
}
console.log(`Apply with: node scripts/regeocode.mjs --from ${file}`);
