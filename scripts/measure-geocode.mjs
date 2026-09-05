// Is the geocoder better than what is already stored? Measure before paying.
//
// Runs the REAL chain (lib/geocode.js, the same code the ingest uses) over a
// sample of location strings already in the database, and compares where it
// puts them against where they currently sit.
//
// Writes nothing. geocodeSightings has no database writes left in it — the last
// one went with geocode_candidates in migration 007 — so it reads the
// gazetteer, landmarks and water mask, calls the model, and mutates JavaScript
// objects. That is what makes this safe to point at production.
//
//   node scripts/measure-geocode.mjs --dry            free: cost + baseline
//   node scripts/measure-geocode.mjs --limit 120      billed: runs the model
//   node scripts/measure-geocode.mjs --limit 120 --newsletter <uuid>
//
// The comparison is PAIRED — the same strings, before and after — which is why
// ~120 is enough to see a real change. What matters is how many strings move
// land->water against how many move the other way, not the precision of either
// percentage on its own.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.DATABASE_URL) {
  console.error('FAIL: DATABASE_URL missing from .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const write = args.includes('--write');
const all = args.includes('--all') || write;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : (write ? 1e9 : 120);
const nlArg = args.includes('--newsletter') ? args[args.indexOf('--newsletter') + 1] : null;
if (dry && write) {
  console.error('FAIL: --dry and --write are opposites');
  process.exit(1);
}

const { getSql } = await import('../lib/db.js');
const { geocodeSightings, composeAnchors, anchorsFor } = await import('../lib/geocode.js');
const { MODEL, geocodingSystemPrompt, geocodingUserPrompt } = await import('../lib/prompts.js');
const Anthropic = (await import('@anthropic-ai/sdk')).default;
const sql = getSql();
console.log('reading: ' + new URL(process.env.DATABASE_URL).host);

const [nl] = nlArg
  ? await sql`select id, title from newsletters where id = ${nlArg}`
  : await sql`select id, title from newsletters order by pasted_at desc limit 1`;
if (!nl) {
  console.error('FAIL: newsletter not found');
  process.exit(1);
}

// One row per distinct string, carrying its CURRENT position as the control.
//
// `--all` widens this to include 'unresolved' rows — strings the chain never
// placed at all. They have no before-position, so they sit outside the paired
// comparison, but there is no reason to leave them behind on a real re-geocode:
// they are the worst rows in the newsletter and cost the same to attempt.
const rows = all
  ? await sql`
      select distinct on (location_raw) location_raw, raw_excerpt, lat, lng
      from sightings
      where newsletter_id = ${nl.id} and geo_method in ('ai', 'unresolved')
      order by location_raw, id`
  : await sql`
      select distinct on (location_raw) location_raw, raw_excerpt, lat, lng
      from sightings
      where newsletter_id = ${nl.id} and geo_method = 'ai' and lat is not null
      order by location_raw, id`;
const sample = rows.slice(0, limit);
const unplaced = sample.filter((r) => r.lat == null).length;
console.log(`${nl.title}: ${rows.length} distinct strings, taking ${sample.length}` +
            (unplaced ? ` (${unplaced} currently unplaced)` : ''));
if (write) console.log('MODE: --write — results will be saved to this database');
console.log('');

/** Wet/dry for a set of points, one query. */
async function wetFlags(pts) {
  if (!pts.length) return [];
  const lats = pts.map((p) => Number(p.lat));
  const lngs = pts.map((p) => Number(p.lng));
  const out = await sql`
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
  return out.map((r) => r.wet);
}

// Baseline, over the rows that HAVE a current position. Keyed by index so an
// unplaced row is simply absent rather than a false "was on land".
const placedNow = sample.map((r, i) => ({ r, i })).filter((x) => x.r.lat != null);
const beforeFlags = await wetFlags(placedNow.map((x) => x.r));
const before = new Map(placedNow.map((x, k) => [x.i, beforeFlags[k]]));
const wetBefore = beforeFlags.filter(Boolean).length;
const comparable = placedNow.length;
const pct = (n, d = comparable) => ((100 * n) / d).toFixed(1) + '%';

if (dry) {
  // Free: count the tokens the run would send, and stop.
  const probe = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const pool = composeAnchors(
    await sql`select id, name, aliases, lat, lng from gazetteer`,
    await sql`select id, name, feature_class, county, lat, lng from landmarks`
  );
  const locs = sample.map((r) => r.location_raw);
  let inTok = 0;
  for (let i = 0; i < locs.length; i += 60) {
    const b = locs.slice(i, i + 60);
    const counted = await probe.messages.countTokens({
      model: MODEL,
      system: geocodingSystemPrompt(),
      messages: [{
        role: 'user',
        content: geocodingUserPrompt(b.map((loc) => ({ input: loc, anchors: anchorsFor(loc, pool) })))
      }]
    });
    inTok += counted.input_tokens;
  }
  const calls = Math.ceil(locs.length / 60);
  const outTok = calls * 7000;                     // ~7k output per 60-item batch, measured
  const retries = Math.ceil(calls * 0.4);          // ~40% of estimates land on land
  const est = ((inTok * 3 + outTok * 15) / 1e6) * (1 + retries / Math.max(calls, 1));
  console.log(`currently in water: ${wetBefore}/${sample.length} (${pct(wetBefore)})`);
  console.log(`${calls} call(s) plus about ${retries} retry call(s); ${inTok} input tokens`);
  console.log(`ESTIMATED COST  $${est.toFixed(2)}`);
  console.log('');
  console.log('No model call was made. Re-run without --dry to spend it.');
  process.exit(0);
}

// Tally real spend by wrapping the client the library is handed.
const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let inTok = 0;
let outTok = 0;
let calls = 0;
const anthropic = {
  messages: {
    create: async (params) => {
      const msg = await real.messages.create(params);
      inTok += msg.usage.input_tokens;
      outTok += msg.usage.output_tokens;
      calls++;
      return msg;
    }
  }
};

const trial = sample.map((r) => ({ location_raw: r.location_raw, raw_excerpt: r.raw_excerpt }));
const { warnings } = await geocodeSightings(trial, sql, anthropic, (m) => console.log('  ' + m));
for (const w of warnings) console.log('WARNING: ' + w);

const results = trial.map((t, i) => ({ i, ...t, was: sample[i] }));
const got = results.filter((p) => p.lat != null);
const after = await wetFlags(got.map((p) => ({ lat: p.lat, lng: p.lng })));
const afterWet = new Map(got.map((p, k) => [p.i, after[k]]));

const R = 6371;
const rad = Math.PI / 180;
const km = (a, b) => {
  const dLat = (Number(b.lat) - Number(a.lat)) * rad;
  const dLng = (Number(b.lng) - Number(a.lng)) * rad * Math.cos(Number(a.lat) * rad);
  return Math.sqrt(dLat * dLat + dLng * dLng) * R;
};

let rescued = 0;
let lost = 0;
let stayedWet = 0;
let stayedDry = 0;
let dropped = 0;
let newlyPlaced = 0;
let newlyPlacedWet = 0;
const moves = [];
const regressions = [];
for (const p of results) {
  const had = before.has(p.i);              // false = was 'unresolved', no position
  if (p.lat == null) { if (had) dropped++; continue; }
  const now = afterWet.get(p.i);
  if (!had) { newlyPlaced++; if (now) newlyPlacedWet++; continue; }
  const was = before.get(p.i);
  if (!was && now) rescued++;
  else if (was && !now) { lost++; regressions.push(p); }
  else if (was) stayedWet++;
  else stayedDry++;
  moves.push(km(p.was, p));
}
moves.sort((a, b) => a - b);
// Compare like with like: only rows that had a position to begin with.
const wetAfter = [...afterWet.entries()].filter(([i, w]) => w && before.has(i)).length;

console.log('');
console.log(`in water BEFORE   ${wetBefore}/${comparable}  (${pct(wetBefore)})`);
console.log(`in water AFTER    ${wetAfter}/${comparable}  (${pct(wetAfter)})`);
console.log('');
console.log(`  land -> water   ${rescued}   <- the win`);
console.log(`  water -> land   ${lost}   <- regressions`);
console.log(`  stayed wet      ${stayedWet}`);
console.log(`  stayed dry      ${stayedDry}`);
if (dropped) console.log(`  no answer       ${dropped}`);
if (newlyPlaced) {
  console.log(`  newly placed    ${newlyPlaced} previously unresolved (${newlyPlacedWet} in water)`);
}
console.log('');
const median = moves[Math.floor(moves.length / 2)];
console.log(`movement (km): median ${median?.toFixed(2)}  max ${moves[moves.length - 1]?.toFixed(2)}`);
for (const p of regressions.slice(0, 8)) {
  console.log('  REGRESSION ' + JSON.stringify(p.location_raw.slice(0, 48)));
  console.log(`    ${Number(p.was.lat).toFixed(4)},${Number(p.was.lng).toFixed(4)} -> ${p.lat.toFixed(4)},${p.lng.toFixed(4)}`);
}

const cost = (inTok * 3 + outTok * 15) / 1e6;
console.log('');
console.log(`SPENT  $${cost.toFixed(3)}   (${calls} calls, ${inTok} in / ${outTok} out)`);
if (!write) {
  console.log(`geocoding the whole newsletter would be about $${((cost / sample.length) * rows.length).toFixed(2)} at this rate`);
  console.log('');
  console.log('Nothing was written.');
} else {
  // Save the new positions, one statement per distinct location string.
  //
  // Scoped hard: this newsletter, and only rows still carrying a machine
  // placement. `geo_method in ('ai','unresolved')` means a pin someone moved by
  // hand ('manual') or resolved from the gazetteer is never
  // touched, however this script is invoked. No backup file is written because
  // the backup is production — this run targets a branch, and the parent still
  // holds the original positions.
  console.log('');
  let updated = 0;
  let cleared = 0;
  const byMethod = {};
  for (const p of results) {
    if (p.lat == null) continue;
    // Carry through whatever the CHAIN decided, not a hardcoded 'ai'.
    //
    // geocodeSightings runs every stage, so a string that now matches a
    // gazetteer entry added since the last ingest comes back as 'gazetteer' with
    // needs_review false. Stamping those 'ai' would throw away a free, verified
    // resolution, re-flag a settled row, and misreport provenance — the one
    // thing geo_method exists to record.
    const rowsOut = await sql`
      update sightings
         set lat = ${p.lat}, lng = ${p.lng},
             geo_method = ${p.geo_method}, needs_review = ${p.needs_review},
             gazetteer_id = ${p.gazetteer_id ?? null},
             landmark_id = ${p.landmark_id ?? null},
             ai_reasoning = ${p.ai_reasoning ?? null},
             ai_confidence = ${p.ai_confidence ?? null}
       where newsletter_id = ${nl.id}
         and location_raw = ${p.location_raw}
         and geo_method in ('ai', 'unresolved')
      returning id`;
    updated += rowsOut.length;
    byMethod[p.geo_method] = (byMethod[p.geo_method] ?? 0) + rowsOut.length;
    if (!before.has(p.i)) cleared += rowsOut.length;
  }
  console.log(`WROTE  ${updated} sightings across ${results.filter((p) => p.lat != null).length} location strings`);
  if (cleared) console.log(`       ${cleared} of them had no position at all before`);
  console.log('       by method: ' + Object.entries(byMethod).map(([k, v]) => `${k} ${v}`).join(', '));

  const [check] = await sql`
    with p as (
      select st_setsrid(st_makepoint(lng, lat), 4326)::geography g
      from sightings
      where newsletter_id = ${nl.id} and geo_method = 'ai' and lat is not null
    )
    select count(*)::int as total,
           count(*) filter (where exists (
             select 1 from water_areas_sub w where st_covers(w.geom, p.g)))::int as wet
    from p`;
  console.log('');
  console.log(`newsletter now: ${check.wet}/${check.total} AI sightings in water ` +
              `(${((100 * check.wet) / check.total).toFixed(1)}%)`);
}
