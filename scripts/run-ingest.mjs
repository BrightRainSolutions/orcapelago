// Run a real ingest locally by invoking the background function handler
// directly — same code path as production (auth check, preprocess, extract,
// geocode, persist), useful for backfilling newsletters without the UI.
//   node scripts/run-ingest.mjs docs/sightings-newsletters/2026-07-15-whale-sighting-report.txt
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/run-ingest.mjs <newsletter.txt> [--force]');
  process.exit(1);
}
const text = readFileSync(resolve(root, file), 'utf8');

// Duplicate guard. Every invocation mints a fresh UUID, so nothing downstream
// notices that this newsletter is already in the database — a stray re-run, or
// a second launch while the first is still going, silently creates another
// newsletter row and several hundred duplicate sightings (and burns another
// ~200K output tokens). That happened on 2026-08-17: three concurrent ingests
// of the July 29 issue.
//
// Gate on the publication date, which is the newsletter's identity. Blocking
// on 'processing' as well as 'complete' is what catches the concurrent case.
// Preprocessing is pure and instant, so this costs nothing before committing
// to ~20 minutes of API calls.
const { preprocessNewsletter } = await import('../lib/preprocess.js');
const { title: parsedTitle, newsletterDate } = preprocessNewsletter(text);
if (!newsletterDate) {
  console.error('FAIL: no publication date in the first 10 lines.');
  console.error('Run `node scripts/dry-run.mjs <file>` for details.');
  process.exit(1);
}
const derivedTitle = `${parsedTitle} WS Report`;

const { getSql } = await import('../lib/db.js');
const sql = getSql();
const existing = await sql`
  select left(id::text, 8) as id, status, sighting_count, pasted_at
  from newsletters
  where title = ${derivedTitle} and status in ('complete', 'processing')
  order by pasted_at`;

if (existing.length && !force) {
  console.error(`\nFAIL: "${derivedTitle}" is already in the database:`);
  console.table(existing);
  console.error('Ingesting again would duplicate the newsletter and all its sightings.');
  console.error('Delete the existing row first, or pass --force if you mean it.\n');
  process.exit(1);
}
if (existing.length) {
  console.warn(`WARNING: --force given — duplicating "${derivedTitle}" (${existing.length} existing row(s))`);
}

const id = randomUUID();
console.log(`ingesting ${file} (${derivedTitle}) as newsletter ${id}...`);

const { default: ingest } = await import('../netlify/functions/ingest-newsletter-background.mjs');
const t0 = Date.now();
const res = await ingest(
  new Request('http://local/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': process.env.ADMIN_TOKEN
    },
    body: JSON.stringify({ id, text })
  })
);
console.log(`handler returned ${res.status} in ${Math.round((Date.now() - t0) / 1000)}s`);

const [nl] = await sql`
  select status, title, sighting_count, error_message,
         lower(date_range)::text as date_from, (upper(date_range) - 1)::text as date_to
  from newsletters where id = ${id}`;
console.log('newsletter:', nl);
if (nl.status === 'complete') {
  const byMethod = await sql`
    select geo_method, count(*)::int as n, sum(case when needs_review then 1 else 0 end)::int as review
    from sightings where newsletter_id = ${id}
    group by geo_method order by n desc`;
  console.log('geo methods:', byMethod);
  const [cand] = await sql`select count(*)::int as n from geocode_candidates where status = 'pending'`;
  console.log('pending geocode candidates:', cand.n);
}
