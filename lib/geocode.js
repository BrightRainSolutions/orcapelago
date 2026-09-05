// Geocoding chain (spec §6, architecture §5), applied per sighting:
//   1.  GPS in the report           → geo_method='gps'
//   2.  Gazetteer lookup            → geo_method='gazetteer'
//       (normalized exact match on gazetteer.name, then aliases — no fuzzy)
//   2b. Landmarks (GNIS reference)  → geo_method='landmark'
//       (unique exact match on water-class features only; the curated
//        gazetteer wins conflicts by running first)
//   3.  Claude geocode (batched, prompt seeded with anchor landmarks named in
//       the batch) → geo_method='ai', needs_review=true, and the model's
//       reasoning/confidence written onto the sighting row
//   3b. Water check — any estimate the marine mask says is on land goes back
//       to the model with its distance inland quoted at it. The retry is kept
//       only if it moves the point closer to water.
//   4.  Still nothing               → geo_method='unresolved', needs_review=true
import { parseGps } from './gps-parse.js';
import { parseJsonArray } from './extract.js';
import { MODEL, geocodingSystemPrompt, geocodingUserPrompt } from './prompts.js';

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const inBounds = (lat, lng) => lat > 45 && lat < 52 && lng > -130 && lng < -120;

/**
 * Total geocoding passes over a batch: one estimate, then one water-check
 * retry. Capped low on purpose — every attempt is a paid call over the whole
 * failing set, and a model that could not put the whale in water when told
 * exactly how far inland it was is unlikely to manage it on a third go.
 */
const MAX_ATTEMPTS = 2;



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
 * geo_method='gazetteer' with needs_review false, which is unreviewable.
 * Phrase-shaped names match phrase-shaped queries, and trigram scores in the
 * 0.4s against a few dozen rows are noise.
 *
 * Deleting it also removes the threshold, the margin, ties, the tie-break
 * distance rule, and the requirement that entries be named like places rather
 * than phrases: a phrase entry is now simply a good anchor and nothing else.
 * The handful of correct fuzzy hits it cost us still reach the model as
 * anchors.
 */
async function gazetteerLookup(locationRaw, gazetteer) {
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
 * The gazetteer stage above is exact-only for the same reason, and for a
 * worse one measured on the curated list itself. See gazetteerLookup.
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
 * Which landmarks are named in these location strings?
 *
 * Substring match on the pool, longest names first so a cap keeps the most
 * specific; names under 4 chars skipped as noise. Pure — unit tested.
 *
 * Callers now pass ONE string at a time, via anchorsFor. It used to be handed
 * a whole batch of 60, and the result was pasted at the top of the request as
 * a shared glossary. That was the design's real flaw, and the numbers took a
 * while to find because the cap looked like the problem:
 *
 * - At a cap of 40, 167 of 699 strings (23.9%) got no anchor at all despite
 *   one existing in the pool — long names crowded out short ones, so Langley,
 *   Ayock, Belfair and Clinton lost to longer names in the same batch.
 * - Raising the cap to 100 removed the starvation completely and changed
 *   nothing: 65.0% in water against 69.2% at 40, inside the run-to-run noise.
 *
 * Coverage was never the problem. The model could not tell which of 40
 * landmarks belonged to which of 60 descriptions, so it sometimes anchored a
 * Tacoma sighting on a Whidbey landmark. Pairing each description with its own
 * anchors took the same 120 strings from 62.5% to 81.7% in water and dropped
 * regressions from 21 to 5 — see geocodingUserPrompt in lib/prompts.js.
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


/**
 * The anchors for ONE location string.
 *
 * Same matching as pickAnchors — this is that function over a single string —
 * but it is the shape the prompt now uses: every description carries its own
 * anchors instead of sharing a batch-wide glossary. The cap is per string and
 * generous, because a description naming six places genuinely wants six.
 */
export const anchorsFor = (location, pool, max = 6) => pickAnchors([location], pool, max);

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

/** Split a list into fixed-size batches. 60 is the geocoding batch size. */
const BATCH = 60;
const batched = (items) => {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
};

/** Is a model answer usable as a position at all? */
const placeable = (r) =>
  !!r && r.confidence !== 'none' &&
  Number.isFinite(r.lat) && Number.isFinite(r.lng) && inBounds(r.lat, r.lng);

/**
 * One geocoding call. Both the first pass and the water-check retry go through
 * here so there is exactly one place that knows the model, the token ceiling
 * and the prompt shape.
 *
 * `items` are { input, anchors } — each description carrying its own
 * authoritative coordinates. `preamble` is prepended to the user message; the
 * retry uses it to quote the previous failure back at the model.
 */
async function callGeocoder(anthropic, items, preamble = '') {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: geocodingSystemPrompt(),
    messages: [{ role: 'user', content: preamble + geocodingUserPrompt(items) }]
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return parseJsonArray(text);
  } catch (err) {
    // Carry the evidence out with the error. A parse failure costs real money
    // to reproduce, and the response is the only thing that explains it — the
    // old re-geocode script dumped these to disk, and losing that with the
    // script meant the next failure was undiagnosable. lib/ cannot write files
    // (Netlify's filesystem is read-only), so the text rides on the error and
    // the caller decides what to do with it.
    err.rawResponse = text;
    err.message = `${err.message} | ${text.length} chars, starts: ${JSON.stringify(text.slice(0, 220))}`;
    throw err;
  }
}

/**
 * Which of these coordinates are NOT in marine water, and how far out?
 *
 * Returns { dist, lat, lng } keyed by location string, for the ones outside —
 * how far inland, and the exact point on the water nearest to it. A location
 * absent from the map is in water. One query for the whole set.
 *
 * The nearest-water point is a fact we already held and were discarding: the
 * KNN lookup that measures the distance also knows where that water is.
 *
 * The mask (water_areas_sub, migration 005) is WDFW's recreational marine
 * areas — Washington only. British Columbia, the outer coast and fresh water
 * are genuinely uncovered, so "outside the mask" is not the same as "wrong",
 * which is why the retry below is allowed to decline.
 */
async function inlandDistances(sql, entries) {
  if (!entries.length) return new Map();
  const rows = await sql`
    with input as (
      select unnest(${entries.map((e) => e.loc)}::text[]) as loc,
             unnest(${entries.map((e) => e.lat)}::float8[]) as lat,
             unnest(${entries.map((e) => e.lng)}::float8[]) as lng
    ), pts as (
      select loc, st_setsrid(st_makepoint(lng, lat), 4326)::geography g from input
    ), dry as (
      select p.loc, p.g from pts p
      where not exists (select 1 from water_areas_sub w where st_covers(w.geom, p.g))
    )
    select d.loc,
           round(st_distance(n.geom, d.g)::numeric) as dist,
           st_y(st_closestpoint(n.geom::geometry, d.g::geometry)) as wlat,
           st_x(st_closestpoint(n.geom::geometry, d.g::geometry)) as wlng
    from dry d
    cross join lateral (
      select w.geom from water_areas_sub w order by w.geom <-> d.g limit 1
    ) n`;
  return new Map(rows.map((r) => [r.loc, {
    dist: Number(r.dist), lat: Number(r.wlat), lng: Number(r.wlng)
  }]));
}

/** Compass direction from one point to another, for the retry hint. */
function bearing(from, to) {
  const rad = Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.cos(from.lat * rad);
  const dLat = to.lat - from.lat;
  const deg = (Math.atan2(dLng, dLat) / rad + 360) % 360;
  return ['north', 'northeast', 'east', 'southeast',
          'south', 'southwest', 'west', 'northwest'][Math.round(deg / 45) % 8];
}

/**
 * The retry preamble: each failed estimate quoted back with its distance
 * inland AND the direction of the nearest water.
 *
 * The distance alone said "you are wrong" without saying which way to go,
 * and it had already guessed once. The bearing and the nearest-water point
 * turn that into something actionable. Offered as the NEAREST water rather
 * than the answer, because the closest shoreline is not always the right one.
 *
 * The escape hatch in the last paragraph is load-bearing. Some of these
 * positions are correct and merely outside the mask's coverage; without
 * permission to decline, a model told to "fix" Telegraph Cove will move a
 * right answer to a wrong one.
 */
const landFeedback = (batch, inland) =>
  `Your previous estimates for these locations fell on land. A whale cannot be on land.

${batch.map((b) => {
  const w = inland.get(b.loc);
  return `- ${JSON.stringify(b.loc)} was placed at ${b.lat}, ${b.lng}, which is ` +
         `${Math.round(w.dist)} m inland. The nearest water lies ${bearing(b, w)}; ` +
         `the SHORELINE there is at ${w.lat.toFixed(4)}, ${w.lng.toFixed(4)} — put the ` +
         `animal in open water beyond that point, not on it.`;
}).join('\n')}

Re-estimate each one, on the water.

IMPORTANT: if a location is genuinely outside Washington marine waters — British Columbia, the outer Pacific coast, or fresh water such as the Lake Washington Ship Canal — then it is correct as it stands and the land check simply does not cover it. Return your original coordinate unchanged in that case rather than moving it.

`;
/**
 * Resolve coordinates for extracted sightings, mutating each with
 * { lat, lng, gazetteer_id, landmark_id, geo_method, needs_review }.
 * `log` is an optional progress sink so a long ingest reports as it goes;
 * it defaults to a no-op, so tests and one-off callers need not pass one.
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function geocodeSightings(sightings, sql, anthropic, log = () => {}) {
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

  // Stage 2: gazetteer, once per distinct raw string.
  const gazetteer = await sql`select id, name, aliases, lat, lng from gazetteer`;
  const unresolved = () => sightings.filter((s) => s.geo_method === 'unresolved');
  const byLocation = new Map();
  for (const s of unresolved()) {
    if (!byLocation.has(s.location_raw)) byLocation.set(s.location_raw, []);
    byLocation.get(s.location_raw).push(s);
  }
  for (const [locationRaw, group] of byLocation) {
    const hit = await gazetteerLookup(locationRaw, gazetteer);
    if (hit) {
      for (const s of group) {
        Object.assign(s, { lat: hit.lat, lng: hit.lng, gazetteer_id: hit.id, geo_method: 'gazetteer', needs_review: false });
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
    // Gazetteer first: these are places a person verified, and several exist
    // precisely BECAUSE the federal data lacks them (Hidden Beach). Until now
    // they only ever resolved on an exact string match, so a phrase like
    // "1.5 miles north of Hidden Beach" got no anchor at all and the model
    // guessed — twice, to two different coordinates. pickAnchors sorts by name
    // length and Array.sort is stable, so on a length tie the verified entry
    // keeps priority over the federal one.
    const anchorPool = composeAnchors(gazetteer, landmarks);
    const results = new Map();

    // Per-batch error handling, NOT one try around the whole stage. A single
    // malformed response used to leave every remaining location unresolved
    // for the entire ingest — seen on 2026-08-24 when the model emitted a raw
    // newline inside a JSON string. One bad batch now costs that batch only.
    const batches = batched(misses);
    for (const [i, batch] of batches.entries()) {
      try {
        const items = batch.map((loc) => ({ input: loc, anchors: anchorsFor(loc, anchorPool) }));
        for (const r of await callGeocoder(anthropic, items)) results.set(r.input, r);
        const withAnchors = items.filter((it) => it.anchors.length).length;
        log(`geocode batch ${i + 1}/${batches.length} (${batch.length} locations, ` +
            `${withAnchors} with anchors)`);
      } catch (err) {
        warnings.push(
          `AI geocoding batch ${i + 1} failed (${batch.length} locations ` +
          `left for review): ${err.message}`
        );
      }
    }

    // Stage 3b: the water check.
    //
    // The prompt has always asked for a coordinate on the water, and until now
    // nothing ever checked whether it got one — roughly a third of estimated
    // positions land outside marine water. This closes the loop mechanically:
    // anything the mask rejects goes back to the model with its own failure
    // quoted at it.
    //
    // A retry is kept ONLY when it moves the point closer to water, so the
    // pass can never make a position worse than the one it replaced. That
    // guarantee is what makes it safe to run unattended in the ingest.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      const placed = [...results.values()].filter(placeable)
        .map((r) => ({ loc: r.input, lat: r.lat, lng: r.lng }));
      let inland;
      try {
        inland = await inlandDistances(sql, placed);
      } catch (err) {
        // Pre-005 database, or PostGIS missing. Positions stand as estimated.
        warnings.push(`water mask unavailable (${err.message}) — geocode retry skipped`);
        break;
      }
      const retryable = placed.filter((p) => inland.has(p.loc));
      if (!retryable.length) break;
      log(`attempt ${attempt}: ${retryable.length} of ${placed.length} estimates landed outside water`);

      const proposals = [];
      const retryBatches = batched(retryable);
      for (const [i, batch] of retryBatches.entries()) {
        try {
          const items = batch.map((b) => ({ input: b.loc, anchors: anchorsFor(b.loc, anchorPool) }));
          const parsed = await callGeocoder(anthropic, items, landFeedback(batch, inland));
          for (const r of parsed) if (placeable(r)) proposals.push(r);
        } catch (err) {
          warnings.push(
            `Geocode retry batch ${i + 1} failed (${batch.length} locations kept ` +
            `their first position): ${err.message}`
          );
        }
      }

      const after = await inlandDistances(sql, proposals.map((r) => ({ loc: r.input, lat: r.lat, lng: r.lng })));
      let improved = 0;
      for (const r of proposals) {
        const was = inland.get(r.input)?.dist ?? 0;
        const now = after.get(r.input)?.dist ?? 0;   // absent from the map = in water
        if (now < was) { results.set(r.input, r); improved++; }
      }
      log(`attempt ${attempt}: ${improved} improved, ${proposals.length - improved} kept their original position`);
    }

    // The model's own account of the placement rides along on the sighting.
    // It used to go to geocode_candidates, a second review surface used once
    // in 2,447 rows (migration 007). Reasoning is the most useful thing there
    // is when judging a coordinate — "placing in the water just off the pier"
    // tells you the vantage-point rule landed — so it belongs on the row the
    // review queue already opens, not in a table of its own.
    //
    // Written for unresolved strings too: a `confidence: 'none'` answer with a
    // stated reason is exactly what a reviewer needs in order to write the
    // gazetteer entry that fixes it.
    for (const [locationRaw, group] of byLocation) {
      const r = results.get(locationRaw);
      for (const s of group) {
        s.ai_reasoning = r?.reasoning ?? null;
        s.ai_confidence = r?.confidence ?? null;
      }
      if (placeable(r)) {
        for (const s of group) {
          Object.assign(s, { lat: r.lat, lng: r.lng, geo_method: 'ai', needs_review: true });
        }
      }
    }
  }

  return { warnings };
}
