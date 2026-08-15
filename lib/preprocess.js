// Newsletter pre-processing (spec §5, §6) — pure functions, no API calls,
// covered by tests/preprocess.test.js against the sample newsletter fixture.
//
// Structure of a newsletter (ground truth: docs/sample-newsletters/):
//   photos-of-the-day noise → SUMMARY section → ANNOUNCEMENTS/promo →
//   species sections under ALL-CAPS banners → boilerplate footer.
// Within a species section, date/location headers ("Fri, Jul 10 - Puget
// Sound (T65A5)") own everything below them until the next header. Reports
// inside a header section are separated by lone "-" lines.

// ~3K tokens of input. Sized against the OUTPUT side: a dense chunk yields
// roughly one sighting per 200 input chars, and each sighting is ~150 output
// tokens — 12K chars ≈ 60 sightings ≈ 9K output tokens, comfortably inside
// the 32K max_tokens extraction ceiling (a 24K-char chunk overflowed 16K).
const MAX_CHUNK_CHARS = 12000;

// Banner → species key. Order-independent (distinct prefixes). The fixture
// uses "UNIDENTIFIED SPECIES"; the spec also names "UNIDENTIFIED KILLER
// WHALES" — support both.
export const SPECIES_BANNERS = [
  ['SOUTHERN RESIDENTS', 'southern_resident'],
  ["BIGG'S KILLER WHALES", 'biggs'],
  ['UNIDENTIFIED KILLER WHALES', 'unidentified_orca'],
  ['GRAY WHALES', 'gray'],
  ['HUMPBACK WHALES', 'humpback'],
  ['MINKE WHALES', 'minke'],
  ['UNIDENTIFIED BALEEN WHALES', 'unidentified_baleen'],
  ['UNIDENTIFIED SPECIES', 'other']
];

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12
};

const DOW = '(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)';
const MON = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*';
const HEADER_RE = new RegExp(
  `^${DOW}[.,]?\\s+(${MON})[.,]?\\s+(\\d{1,2})\\s*[-–]\\s*(.+)$`, 'i'
);

function normalize(text) {
  return text
    .replace(/[﻿​]/g, '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n');
}

/** Species banner on this line? → { name, species } | null */
export function bannerFor(line) {
  const norm = line.trim().replace(/[’‘]/g, "'").toUpperCase();
  for (const [name, species] of SPECIES_BANNERS) {
    if (norm === name || norm.startsWith(`${name} (`) || norm.startsWith(`${name}(`)) {
      return { name, species };
    }
  }
  return null;
}

/**
 * Parse a date/location header line.
 * "Thu, Jul 9 - Puget Sound (T65A5)" →
 *   { raw, month, day, waterBody: "Puget Sound", podGroup: "T65A5" }
 */
export function parseHeaderLine(line) {
  const m = line.trim().match(HEADER_RE);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = parseInt(m[2], 10);
  let waterBody = m[3].trim();
  let podGroup = null;
  const paren = waterBody.match(/^(.*?)\s*\(([^)]+)\)$/);
  if (paren) {
    waterBody = paren[1].trim();
    podGroup = paren[2].trim();
  }
  return { raw: line.trim(), month, day, waterBody, podGroup };
}

/**
 * Resolve a month/day header date to ISO using the newsletter's date for
 * the year, handling year wrap (Dec sightings in a Jan issue).
 */
export function headerDateToIso(month, day, newsletterIso) {
  let year = parseInt(newsletterIso.slice(0, 4), 10);
  const newsletterMonth = parseInt(newsletterIso.slice(5, 7), 10);
  if (month - newsletterMonth > 6) year -= 1;
  if (newsletterMonth - month > 6) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseNewsletterDate(lines) {
  for (const line of lines.slice(0, 10)) {
    const m = line.trim().match(/^([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (m && MONTHS[m[1].toLowerCase()]) {
      const month = MONTHS[m[1].toLowerCase()];
      return {
        title: m[0],
        iso: `${m[3]}-${String(month).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
      };
    }
  }
  return { title: null, iso: null };
}

const isReportSeparator = (line) => /^-(\s*·)?\s*$/.test(line.trim());

/** Split one oversized header-section's body at report separators. */
function splitSectionBody(bodyLines, maxChars) {
  const parts = [];
  let current = [];
  let currentLen = 0;
  for (const line of bodyLines) {
    if (isReportSeparator(line) && currentLen > maxChars) {
      parts.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length) parts.push(current.join('\n'));
  return parts;
}

/**
 * @param {string} rawText  full pasted newsletter text
 * @returns {{
 *   title: string|null,
 *   newsletterDate: string|null,           // ISO
 *   dateRange: {from: string, to: string}|null,  // min/max of header dates
 *   summaryText: string|null,
 *   chunks: Array<{ species: string, speciesBanner: string,
 *                   carriedHeader: string|null, text: string }>
 * }}
 */
export function preprocessNewsletter(rawText) {
  const lines = normalize(rawText).split('\n');
  const { title, iso: newsletterDate } = parseNewsletterDate(lines);

  // Landmarks. Footer cut is a hard stop for everything.
  let footerIdx = lines.findIndex((l) =>
    /^ABOUT ORCA NETWORK/i.test(l.trim()) || /^Orca Network is a 501/i.test(l.trim())
  );
  if (footerIdx === -1) footerIdx = lines.length;

  const banners = [];
  for (let i = 0; i < footerIdx; i++) {
    const b = bannerFor(lines[i]);
    if (b) banners.push({ idx: i, ...b });
  }

  // SUMMARY: from the "SUMMARY" line to ANNOUNCEMENTS (or first banner).
  let summaryText = null;
  const summaryStart = lines.findIndex((l) => l.trim() === 'SUMMARY');
  if (summaryStart !== -1 && summaryStart < footerIdx) {
    let summaryEnd = lines.findIndex(
      (l, i) => i > summaryStart && /^ANNOUNCEMENTS\b/i.test(l.trim())
    );
    if (summaryEnd === -1 || summaryEnd > footerIdx) {
      summaryEnd = banners.length ? banners[0].idx : footerIdx;
    }
    summaryText = lines.slice(summaryStart + 1, summaryEnd).join('\n').trim() || null;
  }

  // Species sections → header sections → packed chunks.
  const chunks = [];
  const headerDates = [];

  for (let b = 0; b < banners.length; b++) {
    const { species, name: speciesBanner } = banners[b];
    const start = banners[b].idx + 1;
    const end = b + 1 < banners.length ? banners[b + 1].idx : footerIdx;
    const sectionLines = lines.slice(start, end);

    // Find header lines within this species section.
    const headerIdxs = [];
    for (let i = 0; i < sectionLines.length; i++) {
      if (parseHeaderLine(sectionLines[i])) headerIdxs.push(i);
    }

    // Header sections: [sectionStart..firstHeader) is headerless preamble.
    const sections = [];
    const bounds = [0, ...headerIdxs, sectionLines.length];
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = bounds[i];
      const to = bounds[i + 1];
      if (from === to) continue;
      const text = sectionLines.slice(from, to).join('\n').trim();
      if (!text) continue;
      const header = headerIdxs.includes(from) ? parseHeaderLine(sectionLines[from]) : null;
      if (header && newsletterDate) {
        headerDates.push(headerDateToIso(header.month, header.day, newsletterDate));
      }
      sections.push({ header, text });
    }

    // Pack whole header-sections into chunks; split only oversized sections.
    let bufText = [];
    let bufLen = 0;
    const flush = () => {
      if (bufLen) chunks.push({ species, speciesBanner, carriedHeader: null, text: bufText.join('\n\n') });
      bufText = [];
      bufLen = 0;
    };
    for (const sec of sections) {
      if (sec.text.length > MAX_CHUNK_CHARS) {
        flush();
        const bodyLines = sec.text.split('\n');
        const parts = splitSectionBody(bodyLines, MAX_CHUNK_CHARS);
        parts.forEach((part, i) => {
          chunks.push({
            species,
            speciesBanner,
            carriedHeader: i === 0 ? null : sec.header?.raw ?? null,
            text: part
          });
        });
        continue;
      }
      if (bufLen && bufLen + sec.text.length > MAX_CHUNK_CHARS) flush();
      bufText.push(sec.text);
      bufLen += sec.text.length + 2;
    }
    flush();
  }

  const sortedDates = [...headerDates].sort();
  const dateRange = sortedDates.length
    ? { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] }
    : null;

  return { title, newsletterDate, dateRange, summaryText, chunks };
}
