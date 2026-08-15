// Admin (spec §7):
//   GET  /api/geocode-candidates              pending, ordered by hit_count desc
//   POST /api/geocode-candidates/:id/promote  → gazetteer entry (ai_promoted),
//        backfill matching sightings (geo_method='catalog', needs_review=false)
//   POST /api/geocode-candidates/:id/reject
import { getSql } from '../../lib/db.js';
import { isAdmin, unauthorized } from '../../lib/auth.js';

export default async (req) => {
  if (!isAdmin(req)) return unauthorized();
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = segs.findIndex((s) => s === 'geocode-candidates');
  const id = segs[i + 1] ?? null;
  const action = segs[i + 2] ?? null;
  const sql = getSql();

  try {
    if (req.method === 'GET' && !id) {
      const rows = await sql`
        select id, location_raw, suggested_name, lat, lng, ai_confidence,
               ai_reasoning, hit_count
        from geocode_candidates where status = 'pending'
        order by hit_count desc, location_raw`;
      return Response.json({ candidates: rows });
    }

    if (req.method === 'POST' && id && action === 'promote') {
      const body = await req.json().catch(() => ({}));
      const [cand] = await sql`select * from geocode_candidates where id = ${id}`;
      if (!cand) return Response.json({ error: 'Not found' }, { status: 404 });
      const name = (body.name ?? cand.suggested_name)?.trim();
      const lat = Number.isFinite(body.lat) ? body.lat : cand.lat;
      const lng = Number.isFinite(body.lng) ? body.lng : cand.lng;
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return Response.json({ error: 'promote needs name, lat, lng' }, { status: 400 });
      }
      const aliases = body.aliases ?? (cand.location_raw !== name ? [cand.location_raw] : []);
      const [entry] = await sql`
        insert into gazetteer (name, aliases, lat, lng, region, source)
        values (${name}, ${aliases}, ${lat}, ${lng}, ${body.region ?? null}, 'ai_promoted')
        returning *`;
      const backfilled = await sql`
        update sightings set lat = ${lat}, lng = ${lng}, gazetteer_id = ${entry.id},
          geo_method = 'catalog', needs_review = false
        where location_raw = ${cand.location_raw} and needs_review = true
        returning id`;
      await sql`update geocode_candidates set status = 'promoted' where id = ${id}`;
      return Response.json({ entry, backfilled: backfilled.length });
    }

    if (req.method === 'POST' && id && action === 'reject') {
      await sql`update geocode_candidates set status = 'rejected' where id = ${id}`;
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err) {
    console.error('geocode-candidates:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
