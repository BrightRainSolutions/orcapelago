import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Domain rules for placing a sighting, kept as markdown in docs/ so it can be
 * read and edited as prose rather than as a string literal.
 *
 * Measured over five A/B trials of 50 real location strings: adding it raised
 * the share of estimates landing in marine water from 55.6% to 62.8%, and
 * narrowed the spread from 47-63% to 60-65%. Almost all of the gain is in NOT
 * re-breaking strings that were already placed correctly (52% -> 68%); it
 * barely moves the genuinely hard ones (53% -> 55%). It buys consistency,
 * not skill.
 *
 * Read at module load. If the file is missing — a deployed function bundle
 * that did not include it — geocoding degrades to the shorter prompt with a
 * warning rather than failing.
 */
function loadDomainDoc() {
  try {
    return readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'geocoding-domain.md'),
      'utf8'
    );
  } catch {
    console.warn('[orcapelago] geocoding-domain.md not found — using the short prompt');
    return null;
  }
}
const GEOCODING_DOMAIN = loadDomainDoc();

// Prompt templates for extraction and geocoding (spec §6).

export const MODEL = 'claude-sonnet-4-6';

/**
 * Extraction system prompt. The user message carries one newsletter chunk
 * plus inherited context; the model returns a strict JSON array.
 */
export function extractionSystemPrompt() {
  return `You extract whale sightings from Orca Network newsletter text (Salish Sea, WA/BC).
You receive one section of a newsletter plus its inherited context: the species
section banner it came from, the newsletter's publication date, and (when the
text is a continuation) the date/location header it falls under.

Newsletter structure:
- Date/location headers look like "Thu, Jul 9 - Puget Sound (T65A5)": day+date,
  general water body, and often pod/matriline or individual IDs in parentheses.
  Everything below a header inherits its date, water body, and pod/group until
  the next header, unless a report overrides them.
- Reports are separated by lone "-" lines. Three kinds:
  1. Timestamped narrative reports: "HH:MM - text" with a reporter name on a
     nearby line. One reporter block may contain several timestamps — each
     timestamped update with a location is its own sighting (report_kind
     "timestamped").
  2. Form submissions with labeled fields (Name, Date & Time of Sighting,
     Location, Coordinates, Whale Type, Number & Behavior...) — one sighting
     each (report_kind "form_submission").
  3. Photo captions / relay notes — looser prose; extract when a date and a
     location are recoverable (report_kind "header_summary").

Rules:
- One sighting per timestamped report with a location; one per form submission.
- sighting_date: inherit from the section header, formatted YYYY-MM-DD using
  the newsletter date's year. sighting_time: 24h "HH:MM" or null.
- species: one of southern_resident | northern_resident | biggs | gray |
  humpback | minke | unidentified_orca | unidentified_baleen | other. Default
  to the section's species unless the report clearly says otherwise (e.g. a
  minke report inside the humpback section). Northern Residents are the
  A/B/C/D/G/H/I/R clan pods (e.g. A42s, I15s) reported mainly in northern
  Georgia Strait and Johnstone Strait; do not confuse them with Southern
  Residents (J/K/L pods). species_raw: the text's own wording when present.
- pod_or_group: e.g. "T65A5", "T34s & T37s" — from the header or the report.
- individual_ids: explicit IDs only, e.g. ["T99C","CRC53","CRC-19313"].
- count: integer when stated ("4-6 orcas" -> 4). direction: as written
  ("northbound", "SE"), null when absent.
- behaviors: short tags from the text, e.g. ["traveling","breaching",
  "feeding","milling","hunting","tail slapping","surface active"].
- detection_methods: how the whales were detected, zero or more of exactly:
  "visual" (seen directly — from shore, boat, or ferry), "hydrophone" (heard
  on a hydrophone; note the location then describes the sensor, not the
  animal), "webcam" (spotted on a remote camera feed). "Heard on the Lime
  Kiln hydrophone and seen on the webcam" is ["hydrophone","webcam"]. Use []
  when the text does not say how.
- location_raw: the exact location text from the report, verbatim. Skip
  reports with no resolvable location at all.
- gps: {"lat":..,"lng":..} when coordinates appear in the report in any
  format, else null.
- summary: one factual sentence. raw_excerpt: the report's source lines
  verbatim, trimmed to 400 characters. reporter: the name line/credit when
  present, else null.
- Do not invent locations, times, counts, or IDs. Use null for anything you
  cannot support.
- Return ONLY a JSON array, no prose, no code fences. Objects have exactly
  these keys: sighting_date, sighting_time, species, species_raw,
  pod_or_group, individual_ids, count, direction, behaviors,
  detection_methods, location_raw, gps, summary, raw_excerpt, reporter,
  report_kind.
  Return [] if the section contains no extractable sightings.`;
}

/** @param {{speciesBanner: string, carriedHeader: string|null, text: string}} chunk */
export function extractionUserPrompt(chunk, newsletterDate) {
  const parts = [
    `Newsletter publication date: ${newsletterDate}`,
    `Species section: ${chunk.speciesBanner}`
  ];
  if (chunk.carriedHeader) {
    parts.push(`This text is a continuation under the header: ${chunk.carriedHeader}`);
  }
  parts.push('', 'Newsletter section text:', chunk.text);
  return parts.join('\n');
}

export function geocodingSystemPrompt() {
  const base = `You are an expert on Salish Sea marine geography (Puget Sound, San Juan
Islands, Gulf Islands, Hood Canal, and connecting waters), including named
points, passages, parks, ferry routes, and informal landmarks used by
whale watchers. For each location description below, return your best
coordinate estimate ON THE WATER adjacent to the named feature.

A list of authoritative landmark coordinates (USGS GNIS) may be provided.
When a description references one of those landmarks — directly ("off Bush
Point") or relationally ("half a mile north of Protection Island",
"mid-channel between Alki Beach and Blake Island") — anchor on the provided
coordinate and compute the described offset from it, rather than recalling
the landmark's position from memory. Descriptions with no matching anchor
are resolved from your own knowledge as before.

Return ONLY a JSON array, no prose, no code fences:
[{"input":..,"resolved_name":..,"lat":..,"lng":..,"confidence":"high"|"medium"|"low"|"none","reasoning":..}]
Keep "input" exactly as given. Use confidence "none" with null lat/lng when
unresolvable.`;
  return GEOCODING_DOMAIN ? `${base}

${GEOCODING_DOMAIN}` : base;
}

/**
 * @param {string[]} locations
 * @param {Array<{name: string, feature_class: string, lat: number, lng: number}>} anchors
 */
export function geocodingUserPrompt(locations, anchors = []) {
  const parts = [];
  if (anchors.length) {
    parts.push(
      'Authoritative landmark coordinates (anchor on these when referenced):',
      ...anchors.map(
        (a) => `- ${a.name} (${a.feature_class}${a.county ? `, ${a.county} County` : ''}): ${a.lat}, ${a.lng}`
      ),
      ''
    );
  }
  parts.push(`Location descriptions:\n${JSON.stringify(locations, null, 2)}`);
  return parts.join('\n');
}
