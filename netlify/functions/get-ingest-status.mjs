// GET /api/ingest-status?id= — admin (spec §6).
// Polled by the admin UI after paste ("Thar she blows..." while processing).
// 404 before the background function has inserted the row → the client
// treats that as "starting".
import { getSql } from '../../lib/db.js';
import { isAdmin, unauthorized } from '../../lib/auth.js';

export default async (req) => {
  if (!isAdmin(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  try {
    const rows = await getSql()`
      select status, sighting_count, error_message, title
      from newsletters where id = ${id}`;
    if (!rows.length) return Response.json({ status: 'starting' }, { status: 404 });
    return Response.json(rows[0]);
  } catch (err) {
    console.error('get-ingest-status:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
