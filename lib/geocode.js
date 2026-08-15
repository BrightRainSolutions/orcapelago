// Geocoding chain (spec §6), applied per sighting:
//   1. GPS in the report            → geo_method='gps'
//   2. Catalog lookup               → geo_method='catalog'
//      (normalized exact match on gazetteer.name, then aliases, then fuzzy
//       trigram similarity ≥ 0.4 with a clear winner)
//   3. Claude geocode (one batched call for all misses) → geo_method='ai',
//      needs_review=true, upsert geocode_candidates (hit_count++ on repeats)
//   4. Still nothing                → geo_method='unresolved', needs_review=true
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

async function upsertCandidate(sql, locationRaw, suggestion) {
  const updated = await sql`
    update geocode_candidates set hit_count = hit_count + 1
    where location_raw = ${locationRaw} and status = 'pending'
    returning id`;
  if (updated.length) return;
  await sql`
    insert into geocode_candidates
      (location_raw, suggested_name, lat, lng, ai_confidence, ai_reasoning)
    values (${locationRaw}, ${suggestion?.resolved_name ?? null},
            ${suggestion?.lat ?? null}, ${suggestion?.lng ?? null},
            ${suggestion?.confidence ?? null}, ${suggestion?.reasoning ?? null})`;
}

/**
 * Resolve coordinates for extracted sightings, mutating each with
 * { lat, lng, gazetteer_id, geo_method, needs_review }.
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
      Object.assign(s, { lat: gps.lat, lng: gps.lng, gazetteer_id: null, geo_method: 'gps', needs_review: false });
    } else {
      Object.assign(s, { lat: null, lng: null, gazetteer_id: null, geo_method: 'unresolved', needs_review: true });
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

  // Stage 3: batched AI calls for the remaining distinct strings. Batches of
  // 60 keep each response (~80 output tokens per item) well under max_tokens.
  const misses = [...byLocation.keys()];
  if (misses.length) {
    try {
      const results = new Map();
      for (let i = 0; i < misses.length; i += 60) {
        const batch = misses.slice(i, i + 60);
        const msg = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: geocodingSystemPrompt(),
          messages: [{ role: 'user', content: geocodingUserPrompt(batch) }]
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
        await upsertCandidate(sql, locationRaw, usable ? r : r ?? null);
      }
    } catch (err) {
      warnings.push(`AI geocoding failed, ${misses.length} locations left unresolved: ${err.message}`);
    }
  }

  return { warnings };
}
