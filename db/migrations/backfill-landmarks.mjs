// Retroactively resolve flagged sightings against the landmarks table —
// the same stage-2b lookup new ingests get, applied to the backlog.
//   node scripts/backfill-landmarks.mjs dev|prod --dry-run   measure only
//   node scripts/backfill-landmarks.mjs dev|prod             apply
//
// For each distinct location_raw among needs_review sightings: UNIQUE EXACT
// name match against landmarks (fuzzy is deliberately excluded — see
// landmarkLookup in lib/geocode.js for the measured reasoning). Hits update
// the sightings (geo_method='landmark', needs_review=false, landmark_id set)
// and retire the matching pending geocode_candidate
// (status='resolved_by_landmark' — non-pending drops it from the admin queue).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { landmarkLookup } from '../../lib/geocode.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const target = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const url = target === 'dev' ? env.DEV_DATABASE_URL : target === 'prod' ? env.DATABASE_URL : null;
if (!url) {
  console.error('usage: node scripts/backfill-landmarks.mjs dev|prod [--dry-run]');
  process.exit(1);
}
console.log(`target: ${target} (${new URL(url).host})${dryRun ? ' — DRY RUN, no writes' : ''}`);
const sql = neon(url);

const locations = await sql`
  select location_raw, count(*)::int as n
  from sightings where needs_review
  group by location_raw order by n desc`;
const landmarks = await sql`select id, name, feature_class, county, lat, lng from landmarks`;
console.log(`${locations.length} distinct flagged locations; ${landmarks.length} landmarks`);

let hits = 0;
let sightingsFixed = 0;
const samples = [];
for (const { location_raw, n } of locations) {
  const hit = landmarkLookup(location_raw, landmarks);
  if (!hit) continue;
  hits++;
  sightingsFixed += n;
  if (samples.length < 15) {
    samples.push(`${n}× "${location_raw}" → ${hit.name} (${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)})`);
  }
  if (!dryRun) {
    await sql`
      update sightings set lat = ${hit.lat}, lng = ${hit.lng},
        landmark_id = ${hit.id}, geo_method = 'landmark', needs_review = false
      where location_raw = ${location_raw} and needs_review = true`;
    await sql`
      update geocode_candidates set status = 'resolved_by_landmark'
      where location_raw = ${location_raw} and status = 'pending'`;
  }
}

console.log(`\n${hits} locations match landmarks → ${sightingsFixed} sightings ${dryRun ? 'would be' : ''} resolved`);
console.log('samples:');
for (const s of samples) console.log(' ', s);
if (!dryRun) {
  const [{ n: remaining }] = await sql`select count(*)::int as n from sightings where needs_review`;
  const [{ n: pending }] = await sql`select count(*)::int as n from geocode_candidates where status = 'pending'`;
  console.log(`\nremaining flagged sightings: ${remaining}; pending candidates: ${pending}`);
}
