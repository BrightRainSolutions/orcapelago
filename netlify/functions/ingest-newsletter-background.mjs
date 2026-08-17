// POST /api/ingest — admin, Netlify Background Function (spec §6).
// The "-background" suffix makes Netlify return 202 immediately and let the
// function run up to 15 min. NOTE: background functions discard the response
// body, so the caller cannot receive a generated id — the client SUPPLIES the
// newsletter id (crypto.randomUUID()) in the POST body and polls
// /api/ingest-status?id=<that id>.
//
// Body: { id: uuid, text: string, title?: string }
//
// Flow: insert newsletters row (status=processing) → preprocess → extract
// (per chunk) → dedupe → geocode chain → persist sightings →
// status=complete (+sighting_count) or failed (+error_message).
import Anthropic from '@anthropic-ai/sdk';
import { getSql } from '../../lib/db.js';
import { isAdmin, unauthorized } from '../../lib/auth.js';
import { preprocessNewsletter } from '../../lib/preprocess.js';
import { extractSightings } from '../../lib/extract.js';
import { geocodeSightings } from '../../lib/geocode.js';

export default async (req) => {
  if (!isAdmin(req)) return unauthorized();

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { id, text, title: givenTitle } = body ?? {};
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !text?.trim()) {
    return Response.json({ error: 'Body must be { id: uuid, text: string }' }, { status: 400 });
  }

  const sql = getSql();
  await sql`
    insert into newsletters (id, title, raw_text, status)
    values (${id}, ${givenTitle ?? null}, ${text}, 'processing')`;

  // Phase logging. Extraction is long and was previously silent, so a stalled
  // chunk was indistinguishable from a slow one. These go to the terminal under
  // scripts/run-ingest.mjs and to the function log under netlify dev/deploy.
  const t0 = Date.now();
  const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  const log = (msg) => console.log(`[ingest ${id} ${at()}] ${msg}`);

  try {
    const { title, newsletterDate, dateRange, chunks } = preprocessNewsletter(text);
    if (!chunks.length) throw new Error('Preprocessing found no species sections — is this a whale sighting report?');
    if (!newsletterDate) throw new Error('Could not find the newsletter publication date in the text');
    log(`preprocessed: ${chunks.length} chunks, newsletter date ${newsletterDate}`);

    const anthropic = new Anthropic();
    const { sightings, warnings: extractWarnings } = await extractSightings(
      chunks,
      anthropic,
      newsletterDate,
      {
        onProgress: (done, total, found) =>
          log(`extract ${done}/${total} chunks — ${found} sightings so far`)
      }
    );
    if (!sightings.length) {
      throw new Error(`Extraction produced no sightings. ${extractWarnings.join('; ')}`.trim());
    }
    log(`extraction done: ${sightings.length} sightings after dedupe${extractWarnings.length ? `, ${extractWarnings.length} warning(s)` : ''}`);

    const { warnings: geoWarnings } = await geocodeSightings(sightings, sql, anthropic);
    log(`geocoding done${geoWarnings.length ? ` with ${geoWarnings.length} warning(s)` : ''}; inserting ${sightings.length} rows`);

    for (const s of sightings) {
      await sql`
        insert into sightings
          (newsletter_id, sighting_date, sighting_time, species, species_raw,
           pod_or_group, individual_ids, count, direction, behaviors,
           location_raw, gazetteer_id, lat, lng, geo_method, needs_review,
           summary, raw_excerpt, reporter, report_kind)
        values
          (${id}, ${s.sighting_date}, ${s.sighting_time}, ${s.species}, ${s.species_raw},
           ${s.pod_or_group}, ${s.individual_ids}, ${s.count}, ${s.direction}, ${s.behaviors},
           ${s.location_raw}, ${s.gazetteer_id}, ${s.lat}, ${s.lng}, ${s.geo_method}, ${s.needs_review},
           ${s.summary}, ${s.raw_excerpt}, ${s.reporter}, ${s.report_kind})`;
    }

    const warnings = [...extractWarnings, ...geoWarnings];
    await sql`
      update newsletters set
        status = 'complete',
        title = coalesce(${givenTitle ?? null}, ${title ? `${title} WS Report` : null}),
        date_range = ${dateRange ? `[${dateRange.from},${dateRange.to}]` : null},
        sighting_count = ${sightings.length},
        error_message = ${warnings.length ? `Completed with warnings: ${warnings.join('; ')}`.slice(0, 2000) : null}
      where id = ${id}`;
    log(`complete: ${sightings.length} sightings${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  } catch (err) {
    console.error(`[ingest ${id} ${at()}] failed:`, err);
    await sql`
      update newsletters set status = 'failed', error_message = ${String(err.message ?? err).slice(0, 2000)}
      where id = ${id}`;
  }
  return new Response(null, { status: 202 });
};
