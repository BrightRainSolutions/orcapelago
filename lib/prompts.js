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
- species: one of southern_resident | biggs | gray | humpback | minke |
  unidentified_orca | unidentified_baleen | other. Default to the section's
  species unless the report clearly says otherwise (e.g. a minke report inside
  the humpback section). species_raw: the text's own wording when present.
- pod_or_group: e.g. "T65A5", "T34s & T37s" — from the header or the report.
- individual_ids: explicit IDs only, e.g. ["T99C","CRC53","CRC-19313"].
- count: integer when stated ("4-6 orcas" -> 4). direction: as written
  ("northbound", "SE"), null when absent.
- behaviors: short tags from the text, e.g. ["traveling","breaching",
  "feeding","milling","hunting","tail slapping","surface active"].
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
  pod_or_group, individual_ids, count, direction, behaviors, location_raw,
  gps, summary, raw_excerpt, reporter, report_kind.
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
  return `You are an expert on Salish Sea marine geography (Puget Sound, San Juan
Islands, Gulf Islands, Hood Canal, and connecting waters), including named
points, passages, parks, ferry routes, and informal landmarks used by
whale watchers. For each location description below, return your best
coordinate estimate ON THE WATER adjacent to the named feature.
Return ONLY a JSON array, no prose, no code fences:
[{"input":..,"resolved_name":..,"lat":..,"lng":..,"confidence":"high"|"medium"|"low"|"none","reasoning":..}]
Keep "input" exactly as given. Use confidence "none" with null lat/lng when
unresolvable.`;
}

/** @param {string[]} locations */
export function geocodingUserPrompt(locations) {
  return `Location descriptions:\n${JSON.stringify(locations, null, 2)}`;
}
