// Geocoding chain (spec §6, architecture §5), applied per sighting:
//   1.  GPS in the report           → geo_method='gps'
//   2.  Catalog lookup              → geo_method='catalog'
//       (normalized exact match on gazetteer.name, then aliases, then fuzzy
//        trigram similarity ≥ 0.4 with a clear winner)
//   2b. Landmarks (GNIS reference)  → geo_method='landmark'
//       (same exact/trigram discipline; the curated gazetteer wins conflicts
//        by running first)
//   3.  Claude geocode (batched, prompt seeded with anchor landmarks named in
//       the batch) → geo_method='ai', needs_review=true, upsert
//       geocode_candidates (hit_count += group size on repeats)
//   4.  Still nothing               → geo_method='unresolved', needs_review=true
import { parseGps } from './gps-parse.js';
import { parseJsonArray } from './extract.js';
import { MODEL, geocodingSystemPrompt, geocodingUserPrompt } from './prompts.js';

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const inBounds = (lat, lng) => lat > 45 && lat < 52 && lng > -130 && lng < -120;

/** Stage 2: resolve one location string against the catalog. */
async function catalogLookup(locationRaw, gazetteer, sql) {
  const n = norm(locationRaw);
  const exact = gazetteer.find((g) => norm(g.name) === n);
  if (exact) return exact;
  const alias = gazetteer.find((g) => g.aliases.some((a) => norm(a) === n));
  if (alias) return alias;
  // Fuzzy via pg_trgm; require ≥0.4 and a clear winner over the runner-up.
  const rows = await sql`
    select id, name, lat, lng, similarity(lower(name), ${n}) as sim
    from gazetteer
    where similarity(lower(name), ${n}) >= 0.4
    order by sim desc limit 2`;
  if (rows.length === 1) return rows[0];
  if (rows.length === 2 && rows[0].sim - rows[1].sim >= 0.1) return rows[0];
  return null;
}

/**
 * Stage 2b: UNIQUE EXACT name matches only — deliberately narrower than the
 * gazetteer stage, for two measured reasons (2026-08-19, prod backlog):
 *
 * 1. Duplicate names are real here (84 in the WA import — eight Rocky
 *    Points). An ambiguous exact match falls through to AI, which receives
 *    every same-name landmark as an anchor (with county) and disambiguates
 *    from the report's own context.
 * 2. No trigram threshold separates good from bad against 1,509 federal
 *    names: "Active Pass"→"Active Cove" (25km wrong, the true match is
 *    Canadian and absent) scored 0.438 while legitimate forms like
 *    "Pt Robinson"→"Point Robinson" scored 0.478–0.588. And the legitimate
 *    fuzzy forms are mostly preposition phrases ("mouth of Penn Cove") —
 *    which the anchor-seeded AI resolves better than a centroid snap would.
 *    Landmarks resolve nouns; the model parses the prepositions.
 *
 * The gazetteer stage keeps its trigram path: that list is small, curated,
 * and alias-bearing, where fuzzy is safe and earns its keep.
 */
export function landmarkLookup(locationRaw, landmarks) {
  const n = norm(locationRaw);
  const exact = landmarks.filter((l) => norm(l.name) === n);
  return exact.length === 1 ? exact[0] : null;
}

/**
 * Anchor seeding for the AI call: landmarks whose names appear inside the
 * batch's location strings, so the model offsets from authoritative
 * coordinates instead of recalling them from memory ("half a mile north of
 * Protection Island" anchors on the real Protection Island).
 *
 * Longest names first so the cap keeps the most specific anchors; names
 * under 4 chars skipped as substring-match noise. Pure — unit tested.
 */
export function pickAnchors(locations, landmarks, max = 40) {
  const haystacks = locations.map((l) => l.toLowerCase());
  const sorted = [...landmarks].sort((a, b) => b.name.length - a.name.length);
  const anchors = [];
  for (const lm of sorted) {
    if (anchors.length >= max) break;
    const needle = lm.name.toLowerCase();
    if (needle.length < 4) continue;
    if (haystacks.some((h) => h.includes(needle))) anchors.push(lm);
  }
  return anchors;
}

/**
 * Record — or bump — a pending candidate for a location we could not resolve.
 *
 * `count` is how many sightings sit at this location in THIS ingest, and
 * hit_count accumulates that rather than incrementing once per run. The
 * distinction matters because the review queue is ordered by hit_count desc:
 * the number has to mean "sightings a promote would fix", otherwise the
 * ordering is wrong. Incrementing per run counted *newsletters*, which sorted
 * a location with five flagged sightings below one with a single sighting.
 */
async function upsertCandidate(sql, locationRaw, suggestion, count) {
  const updated = await sql`
    update geocode_candidates set hit_count = hit_count + ${count}
    where location_raw = ${locationRaw} and status = 'pending'
    returning id`;
  if (updated.length) return;
  await sql`
    insert into geocode_candidates
      (location_raw, suggested_name, lat, lng, ai_confidence, ai_reasoning, hit_count)
    values (${locationRaw}, ${suggestion?.resolved_name ?? null},
            ${suggestion?.lat ?? null}, ${suggestion?.lng ?? null},
            ${suggestion?.confidence ?? null}, ${suggestion?.reasoning ?? null},
            ${count})`;
}

/**
 * Resolve coordinates for extracted sightings, mutating each with
 * { lat, lng, gazetteer_id, landmark_id, geo_method, needs_review }.
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function geocodeSightings(sightings, sql, anthropic) {
  const warnings = [];

  // Stage 1: GPS — model-reported coords (bounds-checked), then our own parse
  // of the location text and excerpt.
  for (const s of sightings) {
    const gps =
      (s.gps && inBounds(s.gps.lat, s.gps.lng) && s.gps) ||
      parseGps(s.location_raw) ||
      (s.raw_excerpt && parseGps(s.raw_excerpt));
    if (gps) {
      Object.assign(s, { lat: gps.lat, lng: gps.lng, gazetteer_id: null, landmark_id: null, geo_method: 'gps', needs_review: false });
    } else {
      Object.assign(s, { lat: null, lng: null, gazetteer_id: null, landmark_id: null, geo_method: 'unresolved', needs_review: true });
    }
    delete s.gps;
  }

  // Stage 2: catalog, once per distinct raw string.
  const gazetteer = await sql`select id, name, aliases, lat, lng from gazetteer`;
  const unresolved = () => sightings.filter((s) => s.geo_method === 'unresolved');
  const byLocation = new Map();
  for (const s of unresolved()) {
    if (!byLocation.has(s.location_raw)) byLocation.set(s.location_raw, []);
    byLocation.get(s.location_raw).push(s);
  }
  for (const [locationRaw, group] of byLocation) {
    const hit = await catalogLookup(locationRaw, gazetteer, sql);
    if (hit) {
      for (const s of group) {
        Object.assign(s, { lat: hit.lat, lng: hit.lng, gazetteer_id: hit.id, geo_method: 'catalog', needs_review: false });
      }
      byLocation.delete(locationRaw);
    }
  }

  // Stage 2b: landmarks. Tolerate the table not existing (pre-003 database)
  // so geocoding never hard-fails on an environment mismatch.
  let landmarks = [];
  try {
    landmarks = await sql`select id, name, feature_class, county, lat, lng from landmarks`;
  } catch (err) {
    warnings.push(`landmarks unavailable (${err.message}) — stage 2b and anchor seeding skipped`);
  }
  if (landmarks.length) {
    for (const [locationRaw, group] of byLocation) {
      const hit = landmarkLookup(locationRaw, landmarks);
      if (hit) {
        for (const s of group) {
          Object.assign(s, { lat: hit.lat, lng: hit.lng, landmark_id: hit.id, geo_method: 'landmark', needs_review: false });
        }
        byLocation.delete(locationRaw);
      }
    }
  }

  // Stage 3: batched AI calls for the remaining distinct strings. Batches of
  // 60 keep each response (~80 output tokens per item) well under max_tokens.
  const misses = [...byLocation.keys()];
  if (misses.length) {
    try {
      const results = new Map();
      for (let i = 0; i < misses.length; i += 60) {
        const batch = misses.slice(i, i + 60);
        const anchors = pickAnchors(batch, landmarks);
        const msg = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: geocodingSystemPrompt(),
          messages: [{ role: 'user', content: geocodingUserPrompt(batch, anchors) }]
        });
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        for (const r of parseJsonArray(text)) results.set(r.input, r);
      }
      for (const [locationRaw, group] of byLocation) {
        const r = results.get(locationRaw);
        const usable =
          r && r.confidence !== 'none' &&
          Number.isFinite(r.lat) && Number.isFinite(r.lng) && inBounds(r.lat, r.lng);
        if (usable) {
          for (const s of group) {
            Object.assign(s, { lat: r.lat, lng: r.lng, geo_method: 'ai', needs_review: true });
          }
        }
        // group.length = sightings at this location, all of them needs_review
        // whether the AI resolved it or it stayed unresolved.
        await upsertCandidate(sql, locationRaw, usable ? r : r ?? null, group.length);
      }
    } catch (err) {
      warnings.push(`AI geocoding failed, ${misses.length} locations left unresolved: ${err.message}`);
    }
  }

  return { warnings };
}
