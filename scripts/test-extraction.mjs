// Dev harness for iterating on the extraction prompt (spec §9.5) without
// running a full ingest. Runs extraction on selected chunks of the fixture
// and prints the structured results. No database writes.
//   node scripts/test-extraction.mjs            smallest 2 chunks (cheap smoke test)
//   node scripts/test-extraction.mjs --all      every chunk (full extraction dry run)
//   node scripts/test-extraction.mjs --species minke,gray
//   node scripts/test-extraction.mjs --all --out results.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { preprocessNewsletter } from '../lib/preprocess.js';
import { extractSightings } from '../lib/extract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const fixture = readFileSync(
  join(root, 'docs', 'sample-newsletters', '2026-07-15-whale-sighting-report.txt'),
  'utf8'
);
const { newsletterDate, chunks } = preprocessNewsletter(fixture);

let selected;
const speciesArg = process.argv.indexOf('--species');
if (process.argv.includes('--all')) {
  selected = chunks;
} else if (speciesArg !== -1) {
  const wanted = new Set(process.argv[speciesArg + 1].split(','));
  selected = chunks.filter((c) => wanted.has(c.species));
} else {
  selected = [...chunks].sort((a, b) => a.text.length - b.text.length).slice(0, 2);
}

console.log(`newsletter date: ${newsletterDate}; ${chunks.length} chunks total, running ${selected.length}:`);
for (const c of selected) {
  console.log(`  - ${c.species} (${c.text.length} chars${c.carriedHeader ? `, continues "${c.carriedHeader}"` : ''})`);
}

const anthropic = new Anthropic();
const t0 = Date.now();
const { sightings, warnings } = await extractSightings(selected, anthropic, newsletterDate, {
  onProgress: (done, total, count) => console.log(`  chunk ${done}/${total} done, ${count} sightings so far`)
});
console.log(`\n${sightings.length} sightings in ${Math.round((Date.now() - t0) / 1000)}s`);
if (warnings.length) console.log('warnings:', warnings);
const outArg = process.argv.indexOf('--out');
if (outArg !== -1) {
  writeFileSync(process.argv[outArg + 1], JSON.stringify({ sightings, warnings }, null, 2));
  console.log(`written to ${process.argv[outArg + 1]}`);
} else {
  console.log(JSON.stringify(sightings, null, 2));
}
