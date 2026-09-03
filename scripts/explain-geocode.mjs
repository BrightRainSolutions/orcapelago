// Why did THIS location string land where it did?
//
// Walks the real geocoding chain for one or more strings and reports what each
// stage saw and decided.
//
// Always free and read-only: it makes no model call and writes nothing. Where
// the chain would reach the AI, it reports that and shows the anchors the
// model would be given, rather than spending money to find out.
//
//   node scripts/explain-geocode.mjs "north end of Reach Island area"
//   node scripts/explain-geocode.mjs "Dash Point" "Lime Kiln camera"
//   node scripts/explain-geocode.mjs --stored          (all 1,680 flagged strings)
//
// Built for review sessions: when a pin is somewhere absurd, paste the
// location text in here and the answer is usually obvious in one line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const { getSql } = await import('../lib/db.js');
const { landmarkLookup, pickAnchors, composeAnchors } = await import('../lib/geocode.js');
const { parseGps } = await import('../lib/gps-parse.js');

const sql = getSql();
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const args = process.argv.slice(2);
const stored = args.includes('--stored');
let queries = args.filter((a) => !a.startsWith('--'));
if (stored) {
  queries = (await sql`
    select distinct location_raw from sightings
    where needs_review and location_raw is not null order by location_raw`).map((r) => r.location_raw);
}
if (!queries.length) {
  console.error('usage: node scripts/explain-geocode.mjs "<location text>" [more...] | --stored');
  process.exit(1);
}

const gazetteer = await sql`select id, name, aliases, lat, lng from gazetteer`;
const landmarks = await sql`select id, name, feature_class, county, lat, lng from landmarks`;
const anchorPool = composeAnchors(gazetteer, landmarks);

const pos = (r) => `${Number(r.lat).toFixed(4)}, ${Number(r.lng).toFixed(4)}`;

for (const q of queries) {
  const n = norm(q);
  console.log('\n' + '─'.repeat(72));
  console.log(JSON.stringify(q));

  // What the database currently holds for it, if anything.
  const [current] = await sql`
    select geo_method, needs_review, lat, lng, count(*) over () from sightings
    where location_raw = ${q} limit 1`;
  if (current) {
    console.log(`  stored now      ${current.geo_method}${current.needs_review ? ' (flagged)' : ''} at ${pos(current)}`);
  }

  // 1. GPS
  const gps = parseGps(q);
  if (gps) {
    console.log(`  1 GPS           RESOLVES -> ${pos(gps)}  (coordinates in the text)`);
    continue;
  }
  console.log('  1 GPS           no coordinates in the text');

  // 2. Gazetteer
  const exact = gazetteer.find((g) => norm(g.name) === n);
  const alias = gazetteer.find((g) => g.aliases.some((a) => norm(a) === n));
  if (exact) {
    console.log(`  2 gazetteer     RESOLVES -> "${exact.name}" ${pos(exact)}  (exact name)`);
    continue;
  }
  if (alias) {
    console.log(`  2 gazetteer     RESOLVES -> "${alias.name}" ${pos(alias)}  (exact alias)`);
    continue;
  }
  console.log('  2 gazetteer     no exact name or alias match');

  // 2b. GNIS — gets first refusal, ahead of any tie-break
  const lm = landmarkLookup(q, landmarks);
  if (lm) {
    console.log(`  2b GNIS         RESOLVES -> "${lm.name}" (${lm.feature_class}, ${lm.county} Co) ${pos(lm)}`);
    continue;
  }
  const sameName = landmarks.filter((l) => norm(l.name) === n);
  console.log(`  2b GNIS         ${sameName.length > 1 ? `${sameName.length} features share this name — ambiguous, skipped` : 'no unique exact match'}`);

  // 3. AI — what it would be given
  const anchors = pickAnchors([q], anchorPool, 6);
  console.log(`  3 AI            would estimate it, with ${anchors.length} anchor(s)`);
  for (const a of anchors) console.log(`                    - ${a.name} (${a.feature_class}) ${pos(a)}`);
  if (!anchors.length) console.log('                    (none — the model has nothing authoritative to offset from)');
}
console.log('');
