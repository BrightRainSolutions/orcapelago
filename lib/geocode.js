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

/**
 * How far apart two tied gazetteer candidates may be before the tie is worth
 * breaking at all (kilometres).
 *
 * Measured against the whole corpus (2,102 distinct strings, 9 ties): the ties
 * fall into two groups with nothing in between — five Lime Kiln phrasings whose
 * candidates sit 0.2 km apart, one pair 4.7 km apart, then 15 km, 38 km and
 * 143 km. Below this line the choice barely matters at map scale; above it,
 * the far cases turned out to be ones where NEITHER candidate was right
 * ("Dash Point" is in Federal Way, not Bush Point or Point No Point), which is
 * the failure the margin rule was built to prevent.
 */
const TIE_BREAK_KM = 5;

/** Great-circle-ish distance in km; equirectangular is ample at this scale. */
function distanceKm(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = (((b.lng - a.lng) * Math.PI) / 180) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 6371;
}

/**
 * Landmark classes that may RESOLVE a sighting's position (stage 2b).
 *
 * The landmarks table serves three consumers with three different needs:
 * map labels (water features), stage 2b lookup (water features), and anchor
 * seeding for the AI (everything, towns included). Populated places are
 * imported for the third — a report saying "across from Bangor, midchannel"
 * wants Bangor's coordinate as a starting point — but they must never satisfy
 * the second: a town centroid is a point on land, and stage 2b marks its
 * results needs_review=false. That would be a silent, unreviewable, wrong
 * position, strictly worse than the AI guess it replaced.
 */
const WATER_CLASSES = new Set([
  'Bay', 'Cape', 'Island', 'Bar', 'Beach', 'Cliff', 'Pillar', 'Gut', 'Channel', 'Sea'
]);

/**
 * Real place names that are also ordinary nouns. Washington has populated
 * places called Beach, Cove, Home, Summit and Bayview, and substring anchor
 * matching would fire on "Wonn Rd beach access" and seed the model with a
 * hamlet 80km away. Six names, measured against the full import.
 */
const GENERIC_NAMES = new Set(['beach', 'cove', 'home', 'summit', 'bayview', 'view']);

/** Stage 2: resolve one location string against the catalog. */
async function catalogLookup(locationRaw, gazetteer, sql) {
  const n = norm(locationRaw);
  const exact = gazetteer.find((g) => norm(g.name) === n);
  if (exact) return { hit: exact };
  const alias = gazetteer.find((g) => g.aliases.some((a) => norm(a) === n));
  if (alias) return { hit: alias };
  // Fuzzy via pg_trgm; require ≥0.4 and a clear winner over the runner-up.
  const rows = await sql`
    select id, name, lat, lng, similarity(lower(name), ${n}) as sim
    from gazetteer
    where similarity(lower(name), ${n}) >= 0.4
    order by sim desc limit 2`;
  if (rows.length === 1) return { hit: rows[0] };
  if (rows.length === 2 && rows[0].sim - rows[1].sim >= 0.1) return { hit: rows[0] };
  // A tie is HELD, not discarded. GNIS gets first refusal — it resolves
  // "Dash Point" and "Ayock Point" correctly, and both of those are ties whose
  // candidates are tens of kilometres apart. Only if GNIS has nothing does the
  // caller consider breaking the tie, and only when the candidates are close
  // enough that the choice cannot be badly wrong.
  if (rows.length === 2) return { tie: { top: rows[0], runnerUp: rows[1], apartKm: distanceKm(rows[0], rows[1]) } };
  return {};
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
  // WATER_CLASSES, not the whole table — see the constant for why.
  const exact = landmarks.filter((l) => WATER_CLASSES.has(l.feature_class) && norm(l.name) === n);
  return exact.length === 1 ? exact[0] : null;
}

/**
 * Build the anchor list for a geocoding call: verified places first, and any
 * GNIS feature they supersede removed.
 *
 * A gazetteer entry exists to say which coordinate a name means — that is its
 * documented job, and why "Andrews Bay" being in two counties is settled here
 * rather than in the federal data. If the lookup chain lets the gazetteer beat
 * GNIS, the anchor list must too: handing the model BOTH a verified place and
 * the federal feature it was created to override just gives it two answers to
 * the same question.
 *
 * Several same-named GNIS features are still sent together on purpose. Eight
 * Rocky Points with their counties let the model disambiguate from the
 * report's own context; that is a different case from one a person has already
 * settled.
 */
export function composeAnchors(gazetteer, landmarks) {
  const verified = gazetteer.flatMap((g) => [
    { name: g.name, feature_class: 'verified place', lat: g.lat, lng: g.lng },
    ...(g.aliases ?? []).map((a) => ({ name: a, feature_class: 'verified place', lat: g.lat, lng: g.lng }))
  ]);
  const shadowed = new Set(verified.map((v) => norm(v.name)));
  return [...verified, ...landmarks.filter((l) => !shadowed.has(norm(l.name)))];
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
    if (GENERIC_NAMES.has(needle)) continue;
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
  // Ties parked here until GNIS has had its turn (stage 2c below).
  const heldTies = new Map();
  for (const [locationRaw, group] of byLocation) {
    const { hit, tie } = await catalogLookup(locationRaw, gazetteer, sql);
    if (hit) {
      for (const s of group) {
        Object.assign(s, { lat: hit.lat, lng: hit.lng, gazetteer_id: hit.id, geo_method: 'catalog', needs_review: false });
      }
      byLocation.delete(locationRaw);
    } else if (tie) {
      heldTies.set(locationRaw, tie);
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

  // Stage 2c: break the ties GNIS could not answer, but only when the two
  // candidates are close enough that picking the wrong one is a small error.
  // Flagged for review because we genuinely chose between two — needs_review
  // false has to keep meaning "nobody guessed".
  for (const [locationRaw, tie] of heldTies) {
    const group = byLocation.get(locationRaw);
    if (!group) continue;                      // GNIS resolved it after all
    if (tie.apartKm > TIE_BREAK_KM) {
      warnings.push(
        `gazetteer tie for "${locationRaw.slice(0, 40)}": "${tie.top.name}" and ` +
        `"${tie.runnerUp.name}" are ${tie.apartKm.toFixed(1)}km apart — too far ` +
        `to choose, sent to AI`
      );
      continue;
    }
    for (const s of group) {
      Object.assign(s, {
        lat: tie.top.lat, lng: tie.top.lng, gazetteer_id: tie.top.id,
        geo_method: 'catalog', needs_review: true
      });
    }
    byLocation.delete(locationRaw);
  }

  // Stage 3: batched AI calls for the remaining distinct strings. Batches of
  // 60 keep each response (~80 output tokens per item) well under max_tokens.
  const misses = [...byLocation.keys()];
  if (misses.length) {
    const results = new Map();
    // Per-batch error handling, NOT one try around the whole stage. A single
    // malformed response used to leave every remaining location unresolved
    // for the entire ingest — seen on 2026-08-24 when the model emitted a raw
    // newline inside a JSON string. One bad batch now costs that batch only.
    for (let i = 0; i < misses.length; i += 60) {
      const batch = misses.slice(i, i + 60);
      try {
        // Gazetteer first: these are places a person verified, and several
        // exist precisely BECAUSE the federal data lacks them (Hidden Beach).
        // Until now they only ever resolved on an exact string match, so a
        // phrase like "1.5 miles north of Hidden Beach" got no anchor at all
        // and the model guessed — twice, to two different coordinates.
        // pickAnchors sorts by name length and Array.sort is stable, so on a
        // length tie the verified entry keeps priority over the federal one.
        const anchors = pickAnchors(batch, composeAnchors(gazetteer, landmarks));
        const msg = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: geocodingSystemPrompt(),
          messages: [{ role: 'user', content: geocodingUserPrompt(batch, anchors) }]
        });
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        for (const r of parseJsonArray(text)) results.set(r.input, r);
      } catch (err) {
        warnings.push(
          `AI geocoding batch ${Math.floor(i / 60) + 1} failed (${batch.length} locations ` +
          `left for review): ${err.message}`
        );
      }
    }

    try {
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
      warnings.push(`Persisting geocode results failed: ${err.message}`);
    }
  }

  return { warnings };
}
