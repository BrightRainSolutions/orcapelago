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
const SEP = String.fromCharCode(10, 10);
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

Each item may carry an "anchors" list: authoritative coordinates (verified
places and USGS GNIS) for landmarks named in THAT description. They are
matched to the description, not to the batch — treat them as given facts.
Anchor on them and compute the described offset, rather than recalling the
landmark's position from memory: "half a mile north of Protection Island"
means half a mile north of the supplied Protection Island coordinate, and
"mid-channel between Alki Beach and Blake Island" means the midpoint of the
two supplied coordinates. An anchor marked "verified place" has been checked
by a person and outranks a federal entry of similar name.

An anchor tells you where a NAME is, not where the animal was. The offset,
the vantage-point rule and the on-the-water rule all still apply: a park or
marina anchor is where the observer stood. Items with no anchors are
resolved from your own knowledge as before.

Return ONLY a JSON array, no prose, no code fences:
[{"input":..,"resolved_name":..,"lat":..,"lng":..,"confidence":"high"|"medium"|"low"|"none","reasoning":..}]
Return one object per item, with "input" copied exactly from that item's
"input" string — not the whole item. Use confidence "none" with null lat/lng
when unresolvable.

Start the reply with "[". Do not explain your working before the JSON or
between objects — any offset arithmetic belongs in that object's "reasoning"
field, nowhere else.`;
  // Base rules, then the domain document, then worked examples.
  return [base, GEOCODING_DOMAIN].filter(Boolean).join(SEP);
}

/**
 * One geocoding request: each location paired with ITS OWN anchors.
 *
 * This used to be a shared glossary — up to 40 landmark lines at the top, then
 * a flat array of 60 strings — leaving the model to work out for itself which
 * coordinate belonged to which description. Two things were wrong with that.
 *
 * The cap was a batch-level budget, so a batch's long names crowded out its
 * short ones: 23.9% of strings got no anchor at all despite one existing in the
 * pool, and the losers were short common names like Langley and Clinton — the
 * ones that recur most. And even when the right anchor was in the header,
 * nothing said which of the 60 descriptions it belonged to.
 *
 * Pairing costs almost nothing. The same names repeat across a batch, but
 * duplicating a few dozen short JSON objects inside one payload is a few
 * hundred tokens — and it removes the cap, the name-length ordering, and the
 * ambiguity in a single change.
 *
 * @param {{input: string, anchors?: Array<{name: string, feature_class: string,
 *   county?: string, lat: number, lng: number}>}[]} items
 */
export function geocodingUserPrompt(items) {
  const payload = items.map((it) => {
    const row = { input: it.input };
    if (it.anchors?.length) {
      row.anchors = it.anchors.map((a) => ({
        name: a.name,
        type: a.feature_class,
        ...(a.county ? { county: a.county } : {}),
        lat: a.lat,
        lng: a.lng
      }));
    }
    return row;
  });
  return [
    'Locations to place. Where "anchors" is present, those coordinates are',
    'authoritative for the names in that description: compute the described',
    'offset from them rather than recalling the position yourself.',
    '',
    JSON.stringify(payload, null, 2)
  ].join('\n');
}
