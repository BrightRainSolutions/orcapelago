// Pre-flight a newsletter before ingesting it. Runs the real preprocessor and
// reports exactly what extraction would receive — chunk count (= number of
// Claude calls), the parsed publication date, which species banners were
// recognised, and any ALL-CAPS line that looks like a section header but is
// not in SPECIES_BANNERS.
//
// That last check is the important one: an unrecognised banner is not treated
// as a section start, so its sightings are swallowed into the PRECEDING
// section and extracted under the wrong species. No error is raised. The
// July 29, 2026 issue lost its Northern Resident and Dolphin sections this way.
//
// Pure: no API calls, no database, no .env. Free and instant — run it on every
// newsletter before spending money on an ingest.
//
//   node scripts/dry-run.mjs docs/sightings-newsletters/2026-07-29-whale-sighting-report.txt
//
// Exit 1 if the newsletter would abort (no date, no sections) OR would ingest
// "successfully" while misfiling sightings under the wrong species.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  preprocessNewsletter,
  bannerFor,
  parseHeaderLine,
  SPECIES_BANNERS
} from '../lib/preprocess.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/dry-run.mjs <newsletter.txt>');
  process.exit(1);
}

const raw = readFileSync(resolve(root, file), 'utf8');
const lines = raw.split(/\r?\n/);
const r = preprocessNewsletter(raw);
const rule = (c = '-') => console.log(c.repeat(64));

rule('=');
console.log('FILE           ', file);
console.log('raw lines      ', lines.length, '| chars', raw.length);
rule();
console.log('title parsed   ', r.title ?? '*** NONE — INGEST WILL FAIL ***');
console.log('newsletter date', r.newsletterDate ?? '*** NONE — INGEST WILL FAIL ***');
console.log('date range     ', r.dateRange ? `${r.dateRange.from} → ${r.dateRange.to}` : '(none)');
console.log('summary block  ', r.summaryText ? `${r.summaryText.length} chars` : '(none)');
console.log('chunks         ', r.chunks.length, '→ that many Claude calls');

// Which supported banners actually appear in this issue.
const found = new Set();
for (const l of lines) {
  const b = bannerFor(l);
  if (b) found.add(b.name);
}
rule();
console.log('BANNERS RECOGNISED:');
for (const [name] of SPECIES_BANNERS) {
  console.log(`  ${found.has(name) ? '✓' : '·'} ${name}`);
}

// The preprocessor's own verdict — the authoritative signal. It flags an
// ALL-CAPS line only when date headers follow it, i.e. when it is actually
// behaving like a section start. These same warnings land in the newsletter's
// error_message during a real ingest.
rule();
if (r.warnings.length) {
  console.log('*** PREPROCESSOR WARNINGS ***');
  r.warnings.forEach((w) => console.log('  ! ' + w));
} else {
  console.log('✓ no preprocessor warnings');
}

// Informational: every unrecognised ALL-CAPS line, section-like or not. Most
// are navigation. Skim it in case something reads like a species that the
// lookahead test missed.
const suspects = [...new Set(
  lines
    .map((l) => l.trim())
    .filter((l) =>
      l.length > 3 && l.length < 60 &&
      l === l.toUpperCase() && /[A-Z]{3}/.test(l) &&
      !bannerFor(l) && !/^(SUMMARY|ANNOUNCEMENTS)/i.test(l))
)];
if (suspects.length) {
  console.log('');
  console.log('unrecognised ALL-CAPS lines (informational — usually navigation):');
  suspects.slice(0, 25).forEach((s) => console.log('   ', JSON.stringify(s)));
}

// Per-chunk detail. A chunk with no headers, timestamps or separators is very
// unlikely to contain sightings — it still costs a full API call.
rule();
console.log('CHUNKS:');
let barrenCount = 0;
r.chunks.forEach((c, i) => {
  const cl = c.text.split('\n');
  const hdr = cl.filter((l) => parseHeaderLine(l)).length;
  const time = cl.filter((l) => /^\s*\d{1,2}:\d{2}\s*[-–]/.test(l)).length;
  const sep = cl.filter((l) => /^-(\s*·)?\s*$/.test(l.trim())).length;
  const barren = hdr === 0 && time === 0 && sep === 0;
  if (barren) barrenCount++;
  console.log(
    `  ${String(i + 1).padStart(2)}. ${c.speciesBanner.padEnd(31)} ` +
    `${String(c.text.length).padStart(6)} chars  hdr:${hdr} time:${time} sep:${sep}` +
    (c.carriedHeader ? '  [continuation]' : '') +
    (barren ? '   ⚠ no sighting markers — likely a wasted call' : '')
  );
});

rule();
const sent = r.chunks.reduce((n, c) => n + c.text.length, 0);
console.log('chars sent to API  ', sent, `(${Math.round((sent / raw.length) * 100)}% of file)`);
console.log('likely wasted calls', barrenCount);
rule('=');

// Exit non-zero for both hard failures and silent-corruption risks. A
// misfiled species section is arguably worse than an abort: the ingest
// "succeeds" and writes rows under the wrong species.
if (!r.newsletterDate || !r.chunks.length) {
  console.error('\nFAIL: ingest would abort — fix the above before running run-ingest.mjs');
  process.exit(1);
}
if (r.warnings.length) {
  console.error('\nFAIL: ingest would silently misfile sightings — resolve the warnings above');
  process.exit(1);
}
