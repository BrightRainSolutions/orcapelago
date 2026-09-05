// PATCH /api/sightings/:id — admin (spec §7).
// Review edits: whitelisted fields only. Setting coordinates by hand comes
// with geo_method='manual' from the client; clearing needs_review is the
// usual outcome of a review.
import { getSql } from '../../lib/db.js';
import { isAdmin, unauthorized } from '../../lib/auth.js';

const EDITABLE = [
  'sighting_date', 'sighting_time', 'species', 'species_raw', 'pod_or_group',
  'count', 'direction', 'location_raw', 'lat', 'lng', 'geo_method',
  'needs_review', 'gazetteer_id'
];

export default async (req) => {
  if (!isAdmin(req)) return unauthorized();
  // GET added so the map's Edit link can open ANY sighting in review, not
  // just the ones still carrying needs_review. Seeing a wrong dot and having
  // to hunt for it in a 1,000-row queue was the friction this removes.
  if (req.method !== 'PATCH' && req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const id = segs[segs.length - 1];

  try {
    const sql = getSql();
    if (req.method === 'GET') {
      const [found] = await sql`
        select id, newsletter_id, sighting_date::text, sighting_time::text, species,
               species_raw, pod_or_group, individual_ids, count, direction, behaviors,
               detection_methods, location_raw, gazetteer_id, landmark_id, lat, lng,
               geo_method, needs_review, summary, raw_excerpt, reporter, report_kind,
               ai_reasoning, ai_confidence
        from sightings where id = ${id}`;
      return found
        ? Response.json({ sighting: found }, { headers: { 'Cache-Control': 'no-store' } })
        : Response.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await req.json();
    const [row] = await sql`select * from sightings where id = ${id}`;
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });

    const m = { ...row };
    for (const k of EDITABLE) {
      if (k in body) m[k] = body[k];
    }
    const [updated] = await sql`
      update sightings set
        sighting_date = ${m.sighting_date}, sighting_time = ${m.sighting_time},
        species = ${m.species}, species_raw = ${m.species_raw},
        pod_or_group = ${m.pod_or_group}, count = ${m.count},
        direction = ${m.direction}, location_raw = ${m.location_raw},
        lat = ${m.lat}, lng = ${m.lng}, geo_method = ${m.geo_method},
        needs_review = ${m.needs_review}, gazetteer_id = ${m.gazetteer_id}
      where id = ${id} returning *`;
    return Response.json({ sighting: updated });
  } catch (err) {
    console.error('sightings-admin:', err);
    return Response.json({ error: 'Update failed' }, { status: 500 });
  }
};
