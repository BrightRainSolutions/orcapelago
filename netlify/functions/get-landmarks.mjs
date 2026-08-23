// GET /api/landmarks — public. Reference layer for the map's labels
// (architecture §12).
//
// Returns GeoJSON directly so MapLibre consumes it as a source with no
// client-side transform, and carries only the two properties the label layers
// read. The whole set is ~22 KB gzipped, so there is no bbox or zoom
// parameter: fetch once, let the layers do the filtering.
//
// feature_class 'Sea' is excluded. Those two rows are the Salish Sea and Puget
// Sound, which the basemap already labels through water_name_point_label —
// including them would double-label the two most prominent features on the map.
//
// Cached hard, unlike /api/gazetteer's 300s: an admin edits the gazetteer
// mid-session, but landmarks only change when a new GNIS file is imported.
import { getSql } from '../../lib/db.js';

const CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

export default async () => {
  try {
    const sql = getSql();
    const rows = await sql`
      select name, feature_class, lat, lng
      from landmarks
      where feature_class <> 'Sea'
      order by feature_class, name`;

    return Response.json(
      {
        type: 'FeatureCollection',
        features: rows.map((r) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
          properties: { name: r.name, feature_class: r.feature_class }
        }))
      },
      { headers: { 'Cache-Control': CACHE } }
    );
  } catch (err) {
    console.error('get-landmarks:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
