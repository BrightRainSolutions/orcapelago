// What will this ingest cost? Run it before spending.
//
// Uses the token-counting endpoint, which is free and does no generation, so
// this script costs nothing to run. Input tokens are therefore exact: it
// builds the real system and user prompts for every chunk the preprocessor
// produces and counts them.
//
// Output tokens cannot be known in advance, so they are projected from the
// number of report SEPARATORS the preprocessor finds — the `-` / `- ·` lines
// that divide one report from the next. One separator is roughly one sighting,
// which is the thing extraction actually emits.
//
// This replaced a calibration that re-serialised an already-stored issue's rows
// and divided by its chunk count. That was wrong twice over: JSON.stringify of
// the stored columns is denser than the JSON the model streams, and scaling by
// chunk count assumes every issue has the same reports-per-chunk density. It
// underquoted the Sept 30 issue by 47% ($1.82 projected, $2.60 spent).
//
//   node scripts/estimate-cost.mjs docs/sightings-newsletters/<file>.txt
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const { preprocessNewsletter } = await import('../lib/preprocess.js');
const { MODEL, extractionSystemPrompt, extractionUserPrompt } = await import('../lib/prompts.js');
const { getSql } = await import('../lib/db.js');
const { default: Anthropic } = await import('@anthropic-ai/sdk');

// claude-sonnet-4-6 list price, $ per million tokens.
const IN_PER_TOKEN = 3 / 1e6;
const OUT_PER_TOKEN = 15 / 1e6;

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/estimate-cost.mjs <newsletter.txt>');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sql = getSql();
const money = (n) => '$' + n.toFixed(2);

const countTokens = async (text) =>
  (await client.messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: text }] }))
    .input_tokens;

const systemTokens = await countTokens(extractionSystemPrompt());

/** Report separators: the `-` or `- ·` lines the newsletter puts between reports. */
const countSeparators = (chunks) =>
  chunks.reduce(
    (n, c) => n + c.text.split(/\r?\n/).filter((l) => /^-(\s*·)?\s*$/.test(l.trim())).length,
    0
  );

async function inputTokensFor(path) {
  const r = preprocessNewsletter(readFileSync(resolve(root, path), 'utf8'));
  let user = 0;
  for (const c of r.chunks) user += await countTokens(extractionUserPrompt(c, r.newsletterDate));
  // The system prompt is identical on every call and resent every time.
  return {
    chunks: r.chunks.length,
    separators: countSeparators(r.chunks),
    user,
    total: user + systemTokens * r.chunks.length
  };
}

// Extraction output per report separator, measured from the logged call
// bodies of two full production runs (db/ingest-runs):
//
//   Sept 22  434 separators  149,202 output tokens   344/sep
//   Sept 30  478 separators  163,535 output tokens   342/sep
//
// Those predict each other within 0.5%, where the old chunk-based calibration
// was 47% low. Re-measure if the extraction prompt or schema changes.
const EXTRACT_OUT_PER_SEPARATOR = 343;

const target = await inputTokensFor(file);
const projectedOut = Math.round(target.separators * EXTRACT_OUT_PER_SEPARATOR);
const extractIn = target.total * IN_PER_TOKEN;
const extractOut = projectedOut * OUT_PER_TOKEN;

// Stage 3 geocoding, priced PER STRING from measured runs rather than from
// assumptions about the prompt.
//
// The previous constants (2,500 input tokens per call, 80 output tokens per
// string) predated every change to the geocoder and understated it by more
// than 3x: per-string anchors add ~200 input tokens to every location, the
// domain document turned `reasoning` into a full sentence, and the water-check
// retry re-sends roughly 40% of strings, so a batch of 60 costs ~1.5 calls.
//
// Calibrated 2026-09-16 against four production re-geocodes (Jul 15, Jul 29,
// Aug 7, Aug 31): 1,639 strings, $6.895, 245 input and 231 output tokens per
// string — within 3% of each other across all four runs. Re-measure if the
// prompt, the anchor format or the retry policy changes.
const GEO_IN_PER_STRING = 245;
const GEO_OUT_PER_STRING = 231;
// First pass plus the retry pass. Was 1.54; the two runs with logged call
// bodies both came in lower (Sept 30: 12 calls over 9 batches = 1.33), which
// is why geocoding was over-quoted while extraction was under-quoted.
const GEO_CALLS_PER_BATCH = 1.33;

// Strings reaching the AI stage, per separator. Not every report yields a
// distinct location, and GPS, gazetteer and landmark hits resolve before the
// model is called: Sept 30 sent 498 strings for 478 separators.
const AI_STRINGS_PER_SEPARATOR = 1.04;

const [{ n: distinctSoFar }] = await sql`select count(distinct location_raw)::int n from sightings`;
const est = {
  locations: Math.round(target.separators * AI_STRINGS_PER_SEPARATOR),
};
est.calls = Math.ceil((est.locations / 60) * GEO_CALLS_PER_BATCH);
const geoIn = est.locations * GEO_IN_PER_STRING * IN_PER_TOKEN;
const geoOut = est.locations * GEO_OUT_PER_STRING * OUT_PER_TOKEN;

console.log(`MODEL ${MODEL} — $3/M input, $15/M output`);
console.log(`system prompt ${systemTokens} tokens, resent on each of ${target.chunks} chunks`);
console.log(`${target.separators} report separators found — output projected at ${EXTRACT_OUT_PER_SEPARATOR} tok each
`);
console.log(`EXTRACTION  ${target.chunks} calls   in ${target.total} tok   out ~${projectedOut} tok`);
console.log(`            ${money(extractIn)} + ${money(extractOut)} = ${money(extractIn + extractOut)}`);
console.log(`GEOCODING   ~${est.calls} calls incl. retries  (~${est.locations} locations)`);
console.log(`            ${money(geoIn)} + ${money(geoOut)} = ${money(geoIn + geoOut)}`);
const total = extractIn + extractOut + geoIn + geoOut;
console.log(`\nTOTAL       ~${money(total)}   (${distinctSoFar} distinct locations already stored)`);

const sysCost = systemTokens * target.chunks * IN_PER_TOKEN;
console.log('\nLEVERS');
console.log(`  prompt caching on the system prompt   saves ~${money(sysCost * 0.9)}  (it is ${money(sysCost)} of the bill)`);
console.log(`  Batch API, 50% off, async             saves ~${money(total * 0.5)}`);
console.log(`  output is ${((extractOut / total) * 100).toFixed(0)}% of the total — that is where the money goes`);
