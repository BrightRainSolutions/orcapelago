// What will this ingest cost? Run it before spending.
//
// Uses the token-counting endpoint, which is free and does no generation, so
// this script costs nothing to run. Input tokens are therefore exact: it
// builds the real system and user prompts for every chunk the preprocessor
// produces and counts them.
//
// Output tokens cannot be known in advance, so they are calibrated against a
// newsletter already in the database: the stored rows are re-serialised to
// approximate what extraction actually emitted, counted, and divided by that
// issue's chunk count. Chunks are sized by the same preprocessor, so
// tokens-per-chunk transfers between issues better than tokens-per-character.
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
// The issue used to calibrate output size. Any complete newsletter works.
const CALIBRATION_TITLE = 'August 7, 2026 WS Report';

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

async function inputTokensFor(path) {
  const r = preprocessNewsletter(readFileSync(resolve(root, path), 'utf8'));
  let user = 0;
  for (const c of r.chunks) user += await countTokens(extractionUserPrompt(c, r.newsletterDate));
  // The system prompt is identical on every call and resent every time.
  return { chunks: r.chunks.length, user, total: user + systemTokens * r.chunks.length };
}

const calRows = await sql`
  select sighting_date::text, sighting_time::text, species, species_raw, pod_or_group,
         individual_ids, count, direction, behaviors, detection_methods, location_raw,
         summary, raw_excerpt, reporter, report_kind
  from sightings s join newsletters n on n.id = s.newsletter_id
  where n.title = ${CALIBRATION_TITLE}`;
if (!calRows.length) {
  console.error(`FAIL: no rows for calibration issue "${CALIBRATION_TITLE}".`);
  process.exit(1);
}
const calOut = await countTokens(JSON.stringify(calRows));
const calIn = await inputTokensFor('docs/sightings-newsletters/2026-08-07-whale-sighting-report.txt');
const outPerChunk = calOut / calIn.chunks;

const target = await inputTokensFor(file);
const projectedOut = Math.round(outPerChunk * target.chunks);
const extractIn = target.total * IN_PER_TOKEN;
const extractOut = projectedOut * OUT_PER_TOKEN;

// Stage 3 geocoding: distinct unresolved strings, 60 per call, ~80 output
// tokens each. Small next to extraction, which is the point worth seeing.
const [{ n: distinctSoFar }] = await sql`select count(distinct location_raw)::int n from sightings`;
const est = {
  locations: Math.round(calRows.length * (target.chunks / calIn.chunks)),
};
est.calls = Math.ceil(est.locations / 60);
const geoIn = est.calls * 2500 * IN_PER_TOKEN;
const geoOut = est.locations * 80 * OUT_PER_TOKEN;

console.log(`MODEL ${MODEL} — $3/M input, $15/M output`);
console.log(`system prompt ${systemTokens} tokens, resent on each of ${target.chunks} chunks`);
console.log(`calibration: ${CALIBRATION_TITLE} emitted ${calOut} output tokens over ${calIn.chunks} chunks (${Math.round(outPerChunk)}/chunk)\n`);
console.log(`EXTRACTION  ${target.chunks} calls   in ${target.total} tok   out ~${projectedOut} tok`);
console.log(`            ${money(extractIn)} + ${money(extractOut)} = ${money(extractIn + extractOut)}`);
console.log(`GEOCODING   ~${est.calls} calls  (~${est.locations} locations)`);
console.log(`            ${money(geoIn)} + ${money(geoOut)} = ${money(geoIn + geoOut)}`);
const total = extractIn + extractOut + geoIn + geoOut;
console.log(`\nTOTAL       ~${money(total)}   (${distinctSoFar} distinct locations already stored)`);

const sysCost = systemTokens * target.chunks * IN_PER_TOKEN;
console.log('\nLEVERS');
console.log(`  prompt caching on the system prompt   saves ~${money(sysCost * 0.9)}  (it is ${money(sysCost)} of the bill)`);
console.log(`  Batch API, 50% off, async             saves ~${money(total * 0.5)}`);
console.log(`  output is ${((extractOut / total) * 100).toFixed(0)}% of the total — that is where the money goes`);
