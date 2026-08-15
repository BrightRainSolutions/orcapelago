// GET /api/newsletters — public (spec §7).
// Returns id, title, date range, status, sighting_count per newsletter.
import { getSql } from '../../lib/db.js';

export default async () => {
  try {
    const sql = getSql();
    // daterange upper bound is exclusive in canonical form; -1 day → inclusive.
    const rows = await sql`
      select id, title,
             lower(date_range)::text as date_from,
             (upper(date_range) - 1)::text as date_to,
             status, sighting_count, pasted_at
      from newsletters
      order by pasted_at desc`;
    return Response.json(
      { newsletters: rows },
      { headers: { 'Cache-Control': 'public, max-age=60' } }
    );
  } catch (err) {
    console.error('get-newsletters:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
