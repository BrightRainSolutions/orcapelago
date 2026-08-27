// /api/gazetteer — one method-aware function because Netlify redirects
// can't split methods across functions (spec §7):
//   GET    /api/gazetteer        public   full catalog
//   POST   /api/gazetteer        admin    create entry
//   PATCH  /api/gazetteer/:id    admin    edit entry
//   DELETE /api/gazetteer/:id    admin    remove entry (unlinks sightings)
import { getSql } from '../../lib/db.js';
import { isAdmin, unauthorized } from '../../lib/auth.js';

function pathId(url) {
  const segs = new URL(url).pathname.split('/').filter(Boolean);
  const i = segs.findIndex((s) => s === 'gazetteer');
  return i !== -1 && segs[i + 1] ? segs[i + 1] : null;
}

export default async (req) => {
  const sql = getSql();
  const id = pathId(req.url);

  try {
    if (req.method === 'GET') {
      const rows = await sql`
        select id, name, aliases, lat, lng, region, source, created_at
        from gazetteer order by name`;
      return Response.json({ gazetteer: rows }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }

    if (!isAdmin(req)) return unauthorized();
    const body = await req.json().catch(() => ({}));

    if (req.method === 'POST' && !id) {
      const { name, lat, lng, aliases = [], region = null, source = 'manual' } = body;
      if (!name?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return Response.json({ error: 'name, lat, lng required' }, { status: 400 });
      }
      // Upsert on the name, because saving the same place twice is the normal
      // shape of review work: you correct "North Beach, Whidbey side" today
      // and "off North Beach" next week, and both mean one place.
      //
      // A duplicate row would not just be clutter — two rows sharing a name
      // tie in the trigram stage, which requires a clear winner, so the string
      // falls through to the AI and the second save silently cancels the
      // first. Merging instead makes the second save STRENGTHEN the entry:
      // its wording joins the alias list.
      //
      // The existing coordinate is deliberately left alone. It was placed by a
      // person who had the map in front of them; a later save should not
      // quietly move a verified position. Move it on the Gazetteer tab, where
      // that is the visible intent.
      const merged = aliases.map((a) => String(a).trim()).filter(Boolean);
      const [row] = await sql`
        insert into gazetteer (name, aliases, lat, lng, region, source)
        values (${name.trim()}, ${merged}, ${lat}, ${lng}, ${region}, ${source})
        on conflict (lower(name)) do update
          set aliases = (
                select array_agg(distinct a)
                from unnest(gazetteer.aliases || excluded.aliases) a
                where a is not null and a <> ''
              ),
              region = coalesce(gazetteer.region, excluded.region)
        returning *, (xmax <> 0) as merged`;
      return Response.json({ entry: row, merged: row.merged === true }, { status: row.merged ? 200 : 201 });
    }

    if (req.method === 'PATCH' && id) {
      const [row] = await sql`select * from gazetteer where id = ${id}`;
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      const m = { ...row };
      for (const k of ['name', 'aliases', 'lat', 'lng', 'region']) {
        if (k in body) m[k] = body[k];
      }
      const [updated] = await sql`
        update gazetteer set name = ${m.name}, aliases = ${m.aliases},
          lat = ${m.lat}, lng = ${m.lng}, region = ${m.region}
        where id = ${id} returning *`;
      return Response.json({ entry: updated });
    }

    if (req.method === 'DELETE' && id) {
      await sql`update sightings set gazetteer_id = null where gazetteer_id = ${id}`;
      await sql`delete from gazetteer where id = ${id}`;
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err) {
    console.error('gazetteer:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
