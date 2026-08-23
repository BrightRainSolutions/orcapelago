// GET /api/sightings — public, the hot path (spec §7).
// Query: newsletter (uuid | 'latest'), from, to, species (csv),
// bbox (minLng,minLat,maxLng,maxLat), needs_review, limit, offset, format.
// Default: GeoJSON FeatureCollection for the map, excluding unresolved
// sightings; ?format=json returns plain rows (including unresolved).
//
// `newsletter=latest` is what the app loads on launch. It resolves the most
// recent issue inside this query rather than making the client fetch the
// newsletter list first, and keeps the payload proportional to one newsletter
// instead of the whole archive. Responses to a newsletter-scoped request carry
// two extra top-level members — `newsletter` (the resolved issue) and `range`
// (min/max sighting date across ALL sightings, which the client can no longer
// derive from a partial payload). Foreign members are legal in GeoJSON and
// MapLibre ignores them.
import { getSql } from '../../lib/db.js';

const CACHE = 'public, max-age=300, stale-while-revalidate=600';
// A needs_review query is the admin review queue, which must reflect writes
// immediately. Caching it publicly would serve a stale backlog.
const NO_CACHE = 'no-store';

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const newsletterParam = q.get('newsletter') || null;
  const wantLatest = newsletterParam === 'latest';
  const newsletterId = wantLatest ? null : newsletterParam;
  const from = q.get('from') || null;
  const to = q.get('to') || null;
  const species = q.get('species')?.split(',').map((s) => s.trim()).filter(Boolean) || null;
  const needsReview = q.has('needs_review') ? q.get('needs_review') === 'true' : null;
  const bbox = q.get('bbox')?.split(',').map(Number) || null;
  const format = q.get('format') || 'geojson';
  const limit = Math.min(parseInt(q.get('limit') || '5000', 10) || 5000, 10000);
  const offset = parseInt(q.get('offset') || '0', 10) || 0;
  const includeUnresolved = format === 'json';
  const cacheHeader = needsReview === null ? CACHE : NO_CACHE;

  if (bbox && (bbox.length !== 4 || bbox.some(Number.isNaN))) {
    return Response.json({ error: 'bbox must be minLng,minLat,maxLng,maxLat' }, { status: 400 });
  }
  if (newsletterId && !/^[0-9a-f-]{36}$/i.test(newsletterId)) {
    return Response.json({ error: "newsletter must be a uuid or 'latest'" }, { status: 400 });
  }

  try {
    const sql = getSql();
    const rows = await sql`
      select id, newsletter_id, sighting_date::text, sighting_time::text, species, species_raw,
             pod_or_group, individual_ids, count, direction, behaviors,
             detection_methods, location_raw, gazetteer_id, landmark_id, lat, lng,
             geo_method, needs_review, summary, raw_excerpt, reporter, report_kind
      from sightings
      where (${newsletterId}::uuid is null or newsletter_id = ${newsletterId}::uuid)
        and (${!wantLatest} or newsletter_id = (
              select id from newsletters
              where status = 'complete' and date_range is not null
              order by upper(date_range) desc limit 1))
        and (${from}::date is null or sighting_date >= ${from}::date)
        and (${to}::date is null or sighting_date <= ${to}::date)
        and (${species}::text[] is null or species = any(${species}::text[]))
        and (${needsReview}::boolean is null or needs_review = ${needsReview}::boolean)
        and (${bbox?.[0] ?? null}::float8 is null
             or (lng between ${bbox?.[0] ?? null}::float8 and ${bbox?.[2] ?? null}::float8
                 and lat between ${bbox?.[1] ?? null}::float8 and ${bbox?.[3] ?? null}::float8))
        and (${includeUnresolved} or geo_method <> 'unresolved')
      order by sighting_date desc, sighting_time desc nulls last
      limit ${limit} offset ${offset}`;

    // Context for a newsletter-scoped request: which issue this is, and the
    // span of the whole archive — the client can't infer the latter from a
    // partial payload, but needs it to say "data covers …" and to offer a
    // widen-the-range escape hatch.
    let meta = {};
    if (newsletterParam) {
      const [nl] = wantLatest
        ? await sql`
            select id, title,
                   lower(date_range)::text as date_from,
                   (upper(date_range) - 1)::text as date_to
            from newsletters
            where status = 'complete' and date_range is not null
            order by upper(date_range) desc limit 1`
        : await sql`
            select id, title,
                   lower(date_range)::text as date_from,
                   (upper(date_range) - 1)::text as date_to
            from newsletters where id = ${newsletterId}::uuid`;
      const [span] = await sql`
        select min(sighting_date)::text as from, max(sighting_date)::text as to
        from sightings`;
      meta = { newsletter: nl ?? null, range: span };
    }

    if (format === 'json') {
      return Response.json({ sightings: rows, ...meta }, { headers: { 'Cache-Control': cacheHeader } });
    }

    const features = rows
      .filter((r) => r.lat != null && r.lng != null)
      // raw_excerpt is for the review editor only — up to 600 chars per row
      // would bloat the map payload for something the map never shows.
      .map(({ lat, lng, raw_excerpt, ...props }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: props
      }));
    return Response.json(
      { type: 'FeatureCollection', features, ...meta },
      { headers: { 'Cache-Control': cacheHeader } }
    );
  } catch (err) {
    console.error('get-sightings:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
