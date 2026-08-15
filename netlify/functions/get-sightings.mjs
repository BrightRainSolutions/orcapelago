// GET /api/sightings — public, the hot path (spec §7).
// Query: from, to, species (csv), bbox (minLng,minLat,maxLng,maxLat),
// needs_review, limit, offset, format.
// Default: GeoJSON FeatureCollection for the map, excluding unresolved
// sightings; ?format=json returns plain rows (including unresolved).
import { getSql } from '../../lib/db.js';

const CACHE = 'public, max-age=300, stale-while-revalidate=600';

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const from = q.get('from') || null;
  const to = q.get('to') || null;
  const species = q.get('species')?.split(',').map((s) => s.trim()).filter(Boolean) || null;
  const needsReview = q.has('needs_review') ? q.get('needs_review') === 'true' : null;
  const bbox = q.get('bbox')?.split(',').map(Number) || null;
  const format = q.get('format') || 'geojson';
  const limit = Math.min(parseInt(q.get('limit') || '5000', 10) || 5000, 10000);
  const offset = parseInt(q.get('offset') || '0', 10) || 0;
  const includeUnresolved = format === 'json';

  if (bbox && (bbox.length !== 4 || bbox.some(Number.isNaN))) {
    return Response.json({ error: 'bbox must be minLng,minLat,maxLng,maxLat' }, { status: 400 });
  }

  try {
    const sql = getSql();
    const rows = await sql`
      select id, sighting_date::text, sighting_time::text, species, species_raw,
             pod_or_group, individual_ids, count, direction, behaviors,
             location_raw, gazetteer_id, lat, lng, geo_method, needs_review,
             summary, reporter, report_kind
      from sightings
      where (${from}::date is null or sighting_date >= ${from}::date)
        and (${to}::date is null or sighting_date <= ${to}::date)
        and (${species}::text[] is null or species = any(${species}::text[]))
        and (${needsReview}::boolean is null or needs_review = ${needsReview}::boolean)
        and (${bbox?.[0] ?? null}::float8 is null
             or (lng between ${bbox?.[0] ?? null}::float8 and ${bbox?.[2] ?? null}::float8
                 and lat between ${bbox?.[1] ?? null}::float8 and ${bbox?.[3] ?? null}::float8))
        and (${includeUnresolved} or geo_method <> 'unresolved')
      order by sighting_date desc, sighting_time desc nulls last
      limit ${limit} offset ${offset}`;

    if (format === 'json') {
      return Response.json({ sightings: rows }, { headers: { 'Cache-Control': CACHE } });
    }

    const features = rows
      .filter((r) => r.lat != null && r.lng != null)
      .map(({ lat, lng, ...props }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: props
      }));
    return Response.json(
      { type: 'FeatureCollection', features },
      { headers: { 'Cache-Control': CACHE } }
    );
  } catch (err) {
    console.error('get-sightings:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
