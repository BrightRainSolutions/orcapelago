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

// Say which database this is about to write to, before anything expensive
// happens. The dev/prod switch is a hand-edit of DATABASE_URL in .env, so the
// only thing standing between a rehearsal and a real content publish is
// remembering which one is currently pasted in there. An ingest costs several
// dollars and several hundred rows; it should never be ambiguous where they
// are going.
if (!process.env.DATABASE_URL) {
  console.error('FAIL: DATABASE_URL missing from .env');
  process.exit(1);
}
console.log(`writing to: ${new URL(process.env.DATABASE_URL).host}`);

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
  // How many AI placements the water mask rejects — the number the geocoding
  // changes are meant to move. Free: the mask is already in the database.
  const [water] = await sql`
    with p as (
      select st_setsrid(st_makepoint(lng, lat), 4326)::geography g
      from sightings where newsletter_id = ${id} and geo_method = 'ai' and lat is not null
    )
    select count(*)::int as total,
           count(*) filter (where exists (
             select 1 from water_areas_sub w where st_covers(w.geom, p.g)))::int as wet
    from p`;
  if (water.total) {
    console.log(`in water: ${water.wet}/${water.total} AI placements (${(100 * water.wet / water.total).toFixed(1)}%)`);
  }
}
