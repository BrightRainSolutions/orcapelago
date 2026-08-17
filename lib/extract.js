// Extraction stage (spec §6): per-chunk Claude calls + strict-JSON parsing,
// then cross-chunk dedupe.
import { MODEL, extractionSystemPrompt, extractionUserPrompt } from './prompts.js';

const SPECIES_KEYS = new Set([
  'southern_resident', 'northern_resident', 'biggs', 'gray', 'humpback', 'minke',
  'unidentified_orca', 'unidentified_baleen', 'other'
]);

/**
 * Recover complete objects from a truncated JSON array (response cut off at
 * max_tokens): trim back to the last parseable object boundary and close
 * the array.
 */
export function salvageTruncatedArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let candidate = text.slice(start);
  for (let i = 0; i < 500; i++) {
    const cut = candidate.lastIndexOf('}');
    if (cut === -1) return null;
    candidate = candidate.slice(0, cut + 1);
    try {
      const parsed = JSON.parse(`${candidate}]`);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* trim further back */ }
    candidate = candidate.slice(0, -1);
  }
  return null;
}

/** Parse a model response that should be a bare JSON array. */
export function parseJsonArray(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
  } catch { /* fall through to bracket extraction */ }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error(`No JSON array in response: ${trimmed.slice(0, 120)}`);
  const parsed = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Response JSON is not an array');
  return parsed;
}

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const asStr = (v, max = 1000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Validate/coerce one raw model sighting; null → drop (with reason pushed to warnings). */
function normalizeSighting(raw, chunk, warnings) {
  const date = asStr(raw.sighting_date, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    warnings.push(`dropped sighting without valid date (${chunk.speciesBanner}): ${asStr(raw.location_raw, 60) ?? '?'}`);
    return null;
  }
  const locationRaw = asStr(raw.location_raw, 500);
  if (!locationRaw) {
    warnings.push(`dropped sighting without location_raw on ${date}`);
    return null;
  }
  const species = SPECIES_KEYS.has(raw.species) ? raw.species : chunk.species;
  const time = asStr(raw.sighting_time, 8);
  const gps =
    raw.gps && Number.isFinite(raw.gps.lat) && Number.isFinite(raw.gps.lng)
      ? { lat: raw.gps.lat, lng: raw.gps.lng }
      : null;
  return {
    sighting_date: date,
    sighting_time: time && /^\d{1,2}:\d{2}/.test(time) ? time : null,
    species,
    species_raw: asStr(raw.species_raw, 100),
    pod_or_group: asStr(raw.pod_or_group, 200),
    individual_ids: asArray(raw.individual_ids),
    count: Number.isFinite(raw.count) ? Math.round(raw.count) : null,
    direction: asStr(raw.direction, 50),
    behaviors: asArray(raw.behaviors),
    location_raw: locationRaw,
    gps,
    summary: asStr(raw.summary, 500),
    raw_excerpt: asStr(raw.raw_excerpt, 600),
    reporter: asStr(raw.reporter, 200),
    report_kind: ['header_summary', 'timestamped', 'form_submission'].includes(raw.report_kind)
      ? raw.report_kind
      : null
  };
}

/** Dedupe across chunk boundaries: same date+time+location_raw → keep one. */
export function dedupeSightings(sightings) {
  const seen = new Set();
  return sightings.filter((s) => {
    const key = `${s.sighting_date}|${s.sighting_time ?? ''}|${s.location_raw.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Run extraction over all chunks. A chunk that fails (API error, bad JSON)
 * is recorded as a warning and skipped; only total failure should abort the
 * ingest, and that is the caller's call based on `warnings` vs results.
 * @param {Array<{species,speciesBanner,carriedHeader,text}>} chunks
 * @param {import('@anthropic-ai/sdk').default} anthropic
 * @param {string} newsletterDate ISO date of the newsletter
 * @returns {Promise<{ sightings: Array<object>, warnings: string[] }>}
 */
export async function extractSightings(chunks, anthropic, newsletterDate, { onProgress, concurrency = 3 } = {}) {
  const perChunk = new Array(chunks.length);
  const warnings = [];
  let next = 0;
  let finished = 0;
  let running = 0;

  async function processChunk(i) {
    const chunk = chunks[i];
    const rows = [];
    try {
      // Streamed because the SDK rejects non-streaming requests with a
      // max_tokens this large; finalMessage() gives the same shape back.
      const msg = await anthropic.messages
        .stream({
          model: MODEL,
          max_tokens: 32000,
          system: extractionSystemPrompt(),
          messages: [{ role: 'user', content: extractionUserPrompt(chunk, newsletterDate) }]
        })
        .finalMessage();
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let parsed;
      if (msg.stop_reason === 'max_tokens') {
        parsed = salvageTruncatedArray(text);
        if (!parsed) throw new Error('response truncated at max_tokens, salvage failed');
        warnings.push(`chunk ${i + 1}/${chunks.length} (${chunk.speciesBanner}) truncated at max_tokens; salvaged ${parsed.length} sightings — some may be missing`);
      } else {
        try {
          parsed = parseJsonArray(text);
        } catch (parseErr) {
          parsed = salvageTruncatedArray(text);
          if (!parsed) throw parseErr;
          warnings.push(`chunk ${i + 1}/${chunks.length} (${chunk.speciesBanner}) returned malformed JSON; salvaged ${parsed.length} sightings`);
        }
      }
      for (const raw of parsed) {
        const s = normalizeSighting(raw, chunk, warnings);
        if (s) rows.push(s);
      }
    } catch (err) {
      warnings.push(`chunk ${i + 1}/${chunks.length} (${chunk.speciesBanner}) failed: ${err.message}`);
    }
    perChunk[i] = rows;
  }

  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      running++;
      await processChunk(i);
      running--;
      onProgress?.(++finished, chunks.length, perChunk.filter(Boolean).flat().length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker())
  );

  return { sightings: dedupeSightings(perChunk.flat()), warnings };
}
