// Re-run geocoding for sightings whose position came from the AI.
//
// Why this exists: the geocoding chain improves over time — new gazetteer
// entries, a wider landmark import, better anchor seeding — but sightings
// keep whatever coordinate they were given on the day they were ingested.
// This replays the current chain over the old strings.
//
// Only touches rows that are still flagged AND still machine-placed
// (geo_method 'ai' or 'unresolved'). A human-reviewed position is never
// overwritten: 'manual', 'gps', 'catalog' and 'landmark' rows are excluded by
// the query, so a reviewer's work cannot be undone by a later re-run.
//
// Deliberately does NOT touch geocode_candidates. Replaying would inflate
// hit_count, which is meant to count how often a string was SEEN in a
// newsletter, not how often we asked about it.
//
//   node scripts/regeocode.mjs --newsletter "August 21, 2026 WS Report"
//   node scripts/regeocode.mjs --all --write
//
// Without --write it geocodes, reports what would change, and writes nothing
// to the database — but it ALWAYS saves both the current positions and the
// proposed ones to db/regeocode-*.json. Apply that file later with
// --from <file> and no API call is made. The first version of this script
// discarded the proposals on exit, which meant a dry run followed by a real
// run paid for the same geocoding twice.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const { getSql } = await import('../lib/db.js');
const { landmarkLookup, pickAnchors } = await import('../lib/geocode.js');
const { MODEL, geocodingSystemPrompt, geocodingUserPrompt } = await import('../lib/prompts.js');
const { parseJsonArray } = await import('../lib/extract.js');
const { default: Anthropic } = await import('@anthropic-ai/sdk');

const args = process.argv.slice(2);
const write = args.includes('--write');
const all = args.includes('--all');
const fromFile = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
// Sample size, for buying a measurement instead of the whole job.
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;
// Attempts per location, including the first. Failures here are systematic —
// road mile markers, channel axes — so a third ask mostly re-buys the same
// wrong answer. Two is the measured sweet spot.
const attempts = args.includes('--attempts') ? Number(args[args.indexOf('--attempts') + 1]) : 2;
const title = args[args.indexOf('--newsletter') + 1];
if (!all && (!args.includes('--newsletter') || !title || title.startsWith('--'))) {
  console.error('usage: node scripts/regeocode.mjs (--all | --newsletter "<title>") [--write]');
  process.exit(1);
}

const sql = getSql();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Apply a previously computed proposal set. No model call, no cost.
if (fromFile) {
  const saved = JSON.parse(readFileSync(fromFile, 'utf8'));
  let n = 0;
  for (const p of saved.proposals) {
    await sql`update sightings
              set lat = ${p.lat}, lng = ${p.lng}, geo_method = ${p.method},
                  gazetteer_id = ${p.gazetteer_id ?? null}, landmark_id = ${p.landmark_id ?? null},
                  needs_review = ${p.method === 'ai'}
              where id = any(${p.ids})`;
    n += p.ids.length;
  }
  console.log(`applied ${saved.proposals.length} proposals to ${n} rows from ${fromFile}`);
  process.exit(0);
}
// Newline as a value, not an escape: three patches to this file were silently
// mangled by backslash handling before this existed.
const NL = String.fromCharCode(10);
const log = (m) => console.log(m);
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const inBounds = (lat, lng) => lat > 45 && lat < 52 && lng > -130 && lng < -120;

const R = 6371;
function km(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = (((b.lng - a.lng) * Math.PI) / 180) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * R;
}

// --- what needs redoing ---
const rows = all
  ? await sql`select id, location_raw, raw_excerpt, lat, lng, geo_method from sightings
              where geo_method in ('ai','unresolved') and needs_review`
  : await sql`select s.id, s.location_raw, s.raw_excerpt, s.lat, s.lng, s.geo_method
              from sightings s join newsletters n on n.id = s.newsletter_id
              where s.geo_method in ('ai','unresolved') and s.needs_review and n.title = ${title}`;
if (!rows.length) {
  console.error('no matching flagged rows — check the newsletter title');
  process.exit(1);
}
const byLocation = new Map();
for (const r of rows) {
  if (!byLocation.has(r.location_raw)) byLocation.set(r.location_raw, []);
  byLocation.get(r.location_raw).push(r);
}
console.log(`${rows.length} flagged rows, ${byLocation.size} distinct strings`);

// --- backup before anything else ---
const stamp = `${rows.length}rows`;
const backup = join(root, 'db', `regeocode-before-${stamp}.json`);
const proposalFile = join(root, 'db', `regeocode-proposed-${stamp}.json`);
writeFileSync(backup, JSON.stringify(rows, null, 1));
console.log(`backup of current positions: ${backup}`);

// --- stage 2: gazetteer (exact, alias, then trigram with a clear winner) ---
const gazetteer = await sql`select id, name, aliases, lat, lng from gazetteer`;
const resolved = new Map();
for (const [loc] of byLocation) {
  const n = norm(loc);
  let hit = gazetteer.find((g) => norm(g.name) === n) ||
            gazetteer.find((g) => g.aliases.some((a) => norm(a) === n));
  if (!hit) {
    const r = await sql`select id, name, lat, lng, similarity(lower(name), ${n}) as sim
                        from gazetteer where similarity(lower(name), ${n}) >= 0.4
                        order by sim desc limit 2`;
    if (r.length === 1 || (r.length === 2 && r[0].sim - r[1].sim >= 0.1)) hit = r[0];
  }
  if (hit) resolved.set(loc, { lat: hit.lat, lng: hit.lng, method: 'catalog', gazetteer_id: hit.id });
}

// --- stage 2b: landmarks (water classes only, enforced inside landmarkLookup) ---
const landmarks = await sql`select id, name, feature_class, county, lat, lng from landmarks`;
for (const [loc] of byLocation) {
  if (resolved.has(loc)) continue;
  const hit = landmarkLookup(loc, landmarks);
  if (hit) resolved.set(loc, { lat: hit.lat, lng: hit.lng, method: 'landmark', landmark_id: hit.id });
}

/**
 * Which of these coordinates are NOT in marine water?
 *
 * Returns metres-from-water keyed by location string, for the ones outside.
 * One query for the whole set rather than a round trip per point.
 */
async function inlandDistances(entries) {
  if (!entries.length) return new Map();
  const locs = entries.map((e) => e.loc);
  const lats = entries.map((e) => e.lat);
  const lngs = entries.map((e) => e.lng);
  const rows = await sql`
    with input as (
      select unnest(${locs}::text[]) as loc,
             unnest(${lats}::float8[]) as lat,
             unnest(${lngs}::float8[]) as lng
    ), pts as (
      select loc, st_setsrid(st_makepoint(lng, lat), 4326)::geography g from input
    )
    select p.loc,
           round((select st_distance(w.geom, p.g) from water_areas_sub w
                  order by w.geom <-> p.g limit 1)::numeric) as dist
    from pts p
    where not exists (select 1 from water_areas_sub w where st_covers(w.geom, p.g))`;
  return new Map(rows.map((r) => [r.loc, Number(r.dist)]));
}

// --- stage 3: AI, anchored on the gazetteer as well as GNIS ---
const gazAnchors = gazetteer.flatMap((g) => [
  { name: g.name, feature_class: 'verified place', lat: g.lat, lng: g.lng },
  ...(g.aliases ?? []).map((a) => ({ name: a, feature_class: 'verified place', lat: g.lat, lng: g.lng }))
]);
let misses = [...byLocation.keys()].filter((l) => !resolved.has(l));
if (limit) {
  misses = misses.slice(0, limit);
  console.log(`--limit ${limit}: sampling ${misses.length} of the unresolved strings`);
}
const batches = [];
for (let i = 0; i < misses.length; i += 60) batches.push(misses.slice(i, i + 60));
console.log(`gazetteer/landmark resolved ${resolved.size} free; ${misses.length} strings → ${batches.length} AI calls`);

// Concurrency 3, matching extraction. The production geocoder is still
// sequential (architecture §12) — this is what that fix would feel like.
let done = 0;
async function runBatch(batch) {
  const anchors = pickAnchors(batch, [...gazAnchors, ...landmarks]);
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: geocodingSystemPrompt(),
    messages: [{ role: 'user', content: geocodingUserPrompt(batch, anchors) }]
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  for (const r of parseJsonArray(text)) {
    if (r.confidence !== 'none' && Number.isFinite(r.lat) && Number.isFinite(r.lng) && inBounds(r.lat, r.lng)) {
      resolved.set(r.input, { lat: r.lat, lng: r.lng, method: 'ai' });
    }
  }
  console.log(`  batch ${++done}/${batches.length} (${anchors.length} anchors)`);
}
for (let i = 0; i < batches.length; i += 3) {
  await Promise.all(batches.slice(i, i + 3).map(runBatch));
}

// --- retry: the model is TOLD the answer was on land, and asked again ---
//
// The prompt has always asked for a coordinate on the water and has never
// been checked. This closes that loop mechanically: anything the water mask
// rejects goes back with its own failure quoted at it.
//
// Retries are capped and the outcome is kept only if it is an improvement,
// so a retry can never make a position worse than the one it replaced.
for (let attempt = 2; attempt <= attempts; attempt++) {
  const placed = [...resolved.entries()]
    .filter(([, r]) => r.method === 'ai')
    .map(([loc, r]) => ({ loc, lat: r.lat, lng: r.lng }));
  const inland = await inlandDistances(placed);
  const retryable = placed.filter((p) => inland.get(p.loc) > 0);
  if (!retryable.length) break;

  log(`attempt ${attempt}: ${retryable.length} of ${placed.length} landed outside water`);
  const retryBatches = [];
  for (let i = 0; i < retryable.length; i += 60) retryBatches.push(retryable.slice(i, i + 60));

  const improved = [];
  await Promise.all(retryBatches.map(async (batch) => {
    const locs = batch.map((b) => b.loc);
    const anchors = pickAnchors(locs, [...gazAnchors, ...landmarks]);
    // Quote each failure back with its distance. Note the escape hatch: some
    // of these are correct and merely outside Washington's catch areas, and a
    // model forced to "fix" Telegraph Cove would move a right answer.
    const feedback = batch
      .map((b) => `- ${JSON.stringify(b.loc)} was placed at ${b.lat}, ${b.lng}, which is ${Math.round(inland.get(b.loc))} m inland.`)
      .join(NL);
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: geocodingSystemPrompt(),
      messages: [{
        role: 'user',
        content:
          'Your previous estimates for these locations fell on land. A whale cannot be on land.' + NL + NL +
          feedback + NL + NL +
          'Re-estimate each one, on the water.' + NL + NL +
          'IMPORTANT: if a location is genuinely outside Washington marine waters - British Columbia, ' +
          'the outer Pacific coast, or freshwater such as the Lake Washington Ship Canal - then it is ' +
          'correct as it stands and the land check simply does not cover it. Return your original ' +
          'coordinate unchanged in that case rather than moving it.' + NL + NL +
          geocodingUserPrompt(locs, anchors)
      }]
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    for (const r of parseJsonArray(text)) {
      if (r.confidence !== 'none' && Number.isFinite(r.lat) && Number.isFinite(r.lng) && inBounds(r.lat, r.lng)) {
        improved.push({ loc: r.input, lat: r.lat, lng: r.lng });
      }
    }
  }));

  // Keep a retry only when it actually moved the point closer to water.
  const after = await inlandDistances(improved);
  let better = 0;
  for (const cand of improved) {
    const was = inland.get(cand.loc) ?? 0;
    const now = after.has(cand.loc) ? after.get(cand.loc) : 0;   // absent = in water
    if (now < was) {
      resolved.set(cand.loc, { ...resolved.get(cand.loc), lat: cand.lat, lng: cand.lng });
      better++;
    }
  }
  log(`attempt ${attempt}: ${better} improved, ${improved.length - better} kept their original position`);
}

// --- what changed ---
const moves = [];
let freed = 0, unresolvedStill = 0;
for (const [loc, group] of byLocation) {
  const r = resolved.get(loc);
  if (!r) { unresolvedStill += group.length; continue; }
  if (r.method !== 'ai') freed += group.length;
  const before = group[0];
  if (before.lat != null) moves.push({ loc, d: km(before, r), method: r.method });
}
moves.sort((a, b) => b.d - a.d);
const dist = moves.map((m) => m.d).sort((a, b) => a - b);
const pct = (p) => (dist.length ? dist[Math.floor(dist.length * p)].toFixed(2) : '—');
console.log(`\nresolved without AI now: ${freed} rows | still unresolved: ${unresolvedStill}`);
console.log(`movement (km): median ${pct(0.5)}  p90 ${pct(0.9)}  max ${dist.length ? dist[dist.length - 1].toFixed(2) : '—'}`);
console.log(`moved >1km: ${dist.filter((d) => d > 1).length} | >10km: ${dist.filter((d) => d > 10).length} | barely moved (<0.2km): ${dist.filter((d) => d < 0.2).length}`);
console.log('\nBIGGEST MOVES:');
for (const m of moves.slice(0, 12)) console.log(`  ${m.d.toFixed(1).padStart(7)} km  [${m.method}]  ${m.loc.slice(0, 58)}`);

// Persist the proposals whether or not we write, so geocoding just paid for
// can be applied — or audited — without repeating it.
const proposals = [];
for (const [loc, group] of byLocation) {
  const r = resolved.get(loc);
  if (!r) continue;
  proposals.push({
    location_raw: loc,
    ids: group.map((g) => g.id),
    before: { lat: group[0].lat, lng: group[0].lng },
    ...r
  });
}
writeFileSync(proposalFile, JSON.stringify({ generated_for: title ?? 'all', proposals }, null, 1));
console.log(`
proposals saved: ${proposalFile}`);

if (!write) {
  console.log('DRY RUN — database untouched. Apply for free with:');
  console.log(`  node scripts/regeocode.mjs --from ${proposalFile}`);
  process.exit(0);
}

let updated = 0;
for (const [loc, group] of byLocation) {
  const r = resolved.get(loc);
  if (!r) continue;
  const ids = group.map((g) => g.id);
  await sql`update sightings
            set lat = ${r.lat}, lng = ${r.lng}, geo_method = ${r.method},
                gazetteer_id = ${r.gazetteer_id ?? null}, landmark_id = ${r.landmark_id ?? null},
                needs_review = ${r.method === 'ai'}
            where id = any(${ids})`;
  updated += ids.length;
}
console.log(`\nupdated ${updated} rows`);
