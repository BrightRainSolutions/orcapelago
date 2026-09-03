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
/**
 * Stage 2: resolve one location string against the gazetteer, EXACTLY.
 *
 * Name or alias, normalised for case and whitespace. No fuzzy matching.
 *
 * There used to be a pg_trgm stage here with a 0.4 floor and a 0.1 margin over
 * the runner-up, plus a tie-break that let GNIS answer first and compared how
 * far apart the tied candidates were. All of it is gone. Measured against the
 * real corpus it was net-harmful: of 52 strings it resolved, 19 landed on one
 * entry named "north side of Jones Island" — "north side of Hat Island" scored
 * 0.677 against it, "North side of James Island" 0.742, "N of Pt Robinson
 * (island side)" 0.467 and 145km wrong — every one stored as
 * geo_method='catalog' with needs_review false, which is unreviewable.
 * Phrase-shaped names match phrase-shaped queries, and trigram scores in the
 * 0.4s against a few dozen rows are noise.
 *
 * Deleting it also removes the threshold, the margin, ties, the tie-break
 * distance rule, and the requirement that entries be named like places rather
 * than phrases: a phrase entry is now simply a good anchor and nothing else.
 * The handful of correct fuzzy hits it cost us still reach the model as
 * anchors.
 */
async function catalogLookup(locationRaw, gazetteer) {
  const n = norm(locationRaw);
  return gazetteer.find((g) => norm(g.name) === n) ||
         gazetteer.find((g) => g.aliases.some((a) => norm(a) === n)) ||
         null;
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
/**
 * Reporter text with the preprocessor's bracketed expansions folded back in.
 *
 * Reports are full of "Pt [Point] Robinson" and "N [north] of X" — the
 * abbreviation followed by its expansion in brackets. That insertion lands in
 * the MIDDLE of a place name, so a substring search for "point robinson" finds
 * nothing and the model gets no anchor at all. Measured: 29 flagged strings
 * lose an anchor this way, almost all of them "Pt [Point] something".
 *
 * Two readings are produced because either can be the one that matches:
 * "Pt [Point] Robinson" -> "Point Robinson" (keep the expansion, drop the
 * abbreviation) and -> "Pt Robinson" (drop the brackets entirely).
 */
export function bracketReadings(text) {
  const expanded = text.replace(/\S+\s*\[([^\]]+)\]/g, '$1');
  const stripped = text.replace(/\s*\[[^\]]*\]/g, '');
  return [...new Set([text, expanded, stripped])];
}


export function pickAnchors(locations, landmarks, max = 40) {
  // Every reading of every location, so a name split by a bracketed expansion
  // is still found.
  const haystacks = locations.flatMap((l) => bracketReadings(l).map((r) => r.toLowerCase()));
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
  for (const [locationRaw, group] of byLocation) {
    const hit = await catalogLookup(locationRaw, gazetteer);
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

  // Stage 3: batched AI calls for the remaining distinct strings, 60 at a time.
  //
  // max_tokens is 16000, not the original 8000. The old estimate of ~80 output
  // tokens per item predates the geocoding domain document, which turned the
  // model's `reasoning` field into a full sentence — a real response came back
  // at 23,803 characters, cut off mid-word, and the whole batch was lost.
  // parseJsonArray salvages a truncated array now too, so this is belt and
  // braces: the ceiling should not be reached, and if it is, 57 of 60 answers
  // survive instead of none.
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
          max_tokens: 16000,
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
