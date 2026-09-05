// The ingest pipeline: newsletter text in, sightings rows out.
//
// preprocess → extract (per chunk) → dedupe → geocode chain → persist →
// newsletters.status = complete (+sighting_count) or failed (+error_message).
//
// This is a library, not an endpoint. It used to be
// `netlify/functions/ingest-newsletter-background.mjs`, a deployed HTTP
// function — and by the end that was fiction three times over: the admin UI
// that called it is gone, ANTHROPIC_API_KEY is deliberately absent from
// Netlify so a deployed invocation could never do the work, and the only real
// caller (scripts/run-ingest.mjs) was constructing a fake Request carrying the
// admin token in order to let the process authenticate to itself.
//
// So there is no auth check here. Authentication belongs at a boundary, and
// there is no longer a boundary: the only way to run an ingest is to be a
// person at a terminal who already has .env.
//
// A run costs several dollars and takes about twenty minutes. That is the real
// reason it is not a button.
import { preprocessNewsletter } from './preprocess.js';
import { extractSightings } from './extract.js';
import { geocodeSightings } from './geocode.js';

/**
 * Ingest one newsletter.
 *
 * The caller supplies the id (rather than receiving a generated one) because
 * the newsletters row is written BEFORE any slow work starts — a run that dies
 * mid-extraction still leaves a row saying so, instead of vanishing.
 *
 * On failure the newsletters row is marked 'failed' with the message, and the
 * error is then rethrown: a CLI should exit non-zero. The HTTP version used to
 * swallow it and return 202, which only made sense when nothing was waiting.
 *
 * @param {{id: string, text: string, title?: string}} input
 * @param {import('./db.js').Sql} sql
 * @param {object} anthropic  Anthropic SDK client
 * @param {(msg: string) => void} [sink]  where progress lines go
 * @returns {Promise<{sightings: number, warnings: string[], title: string|null}>}
 */
export async function ingestNewsletter({ id, text, title: givenTitle }, sql, anthropic, sink = console.log) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new TypeError('ingestNewsletter: id must be a uuid');
  }
  if (!text?.trim()) {
    throw new TypeError('ingestNewsletter: text is required');
  }

  await sql`
    insert into newsletters (id, title, raw_text, status)
    values (${id}, ${givenTitle ?? null}, ${text}, 'processing')`;

  // Phase logging. Extraction is long and was previously silent, so a stalled
  // chunk was indistinguishable from a slow one.
  const t0 = Date.now();
  const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  const log = (msg) => sink(`[ingest ${id} ${at()}] ${msg}`);

  try {
    const { title, newsletterDate, dateRange, chunks, warnings: preWarnings } =
      preprocessNewsletter(text);
    if (!chunks.length) throw new Error('Preprocessing found no species sections — is this a whale sighting report?');
    if (!newsletterDate) throw new Error('Could not find the newsletter publication date in the text');
    log(`preprocessed: ${chunks.length} chunks, newsletter date ${newsletterDate}`);
    for (const w of preWarnings) log(`WARNING: ${w}`);

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

    const { warnings: geoWarnings } = await geocodeSightings(sightings, sql, anthropic, log);
    log(`geocoding done${geoWarnings.length ? ` with ${geoWarnings.length} warning(s)` : ''}; inserting ${sightings.length} rows`);

    for (const s of sightings) {
      await sql`
        insert into sightings
          (newsletter_id, sighting_date, sighting_time, species, species_raw,
           pod_or_group, individual_ids, count, direction, behaviors,
           detection_methods, location_raw, gazetteer_id, landmark_id, lat, lng,
           geo_method, needs_review, summary, raw_excerpt, reporter, report_kind,
           ai_reasoning, ai_confidence)
        values
          (${id}, ${s.sighting_date}, ${s.sighting_time}, ${s.species}, ${s.species_raw},
           ${s.pod_or_group}, ${s.individual_ids}, ${s.count}, ${s.direction}, ${s.behaviors},
           ${s.detection_methods}, ${s.location_raw}, ${s.gazetteer_id}, ${s.landmark_id}, ${s.lat}, ${s.lng},
           ${s.geo_method}, ${s.needs_review}, ${s.summary}, ${s.raw_excerpt}, ${s.reporter}, ${s.report_kind},
           ${s.ai_reasoning ?? null}, ${s.ai_confidence ?? null})`;
    }

    const warnings = [...preWarnings, ...extractWarnings, ...geoWarnings];
    const finalTitle = givenTitle ?? (title ? `${title} WS Report` : null);
    await sql`
      update newsletters set
        status = 'complete',
        title = ${finalTitle},
        date_range = ${dateRange ? `[${dateRange.from},${dateRange.to}]` : null},
        sighting_count = ${sightings.length},
        error_message = ${warnings.length ? `Completed with warnings: ${warnings.join('; ')}`.slice(0, 2000) : null}
      where id = ${id}`;
    log(`complete: ${sightings.length} sightings${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
    return { sightings: sightings.length, warnings, title: finalTitle };
  } catch (err) {
    log(`FAILED: ${err.message ?? err}`);
    await sql`
      update newsletters set status = 'failed', error_message = ${String(err.message ?? err).slice(0, 2000)}
      where id = ${id}`;
    throw err;
  }
}
