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
      -- ALLOW-LIST, mirroring LANDMARK_BANDS in src/map/landmark-layers.js.
      -- Was a deny-list on 'Sea', which worked only because every other class
      -- in the table happened to be labellable. Populated places are imported
      -- now for AI anchoring, and the map must never show them: the basemap
      -- already labels towns, and these would double every one of them.
      -- The band filter would drop them client-side anyway; this stops them
      -- being shipped at all.
      -- 'Buoy' is drawn, not labelled into a band, so it has no entry in
      -- LANDMARK_BANDS and has to be allowed explicitly. Leaving it out is
      -- silent: the layer filters a source that never contained it.
      where feature_class in ('Bay', 'Channel', 'Island', 'Cape', 'Beach', 'Bar', 'Cliff', 'Pillar', 'Gut', 'Buoy')
        -- Gazetteer wins, same rule composeAnchors() applies to the anchor
        -- pool: a verified entry exists to say which coordinate a name means,
        -- so shipping the federal feature it overrides would label the same
        -- place twice. 25 names collide today, most 200-600m apart, which is
        -- close enough that both labels would fight for the same pixels.
        and lower(name) not in (select lower(name) from gazetteer)
      order by feature_class, name`;

    // Verified places, drawn alongside the federal ones.
    //
    // These were withheld from the map on 2026-08-18, when the gazetteer was
    // 11 hand-seeded rows and the measurement behind the decision was taken
    // over the CANDIDATES table — 79% of which were positional descriptions
    // rather than names. That table is gone (migration 007) and the gazetteer
    // has since become curated: of 90 entries, all but a handful are real
    // places, and many are places GNIS does not carry at all. Stamm Overlook
    // Park, Appletree Cove, Active Pass and Norwegian Point Park were added
    // precisely because the federal data lacks them, so hiding them meant the
    // public map withheld the very names the review work established.
    //
    // The exclusions below are the handful that are not places: a webcam, and
    // positional descriptions kept because geocoding resolves real reports
    // through them.
    const verified = await sql`
      select name, lat, lng
      from gazetteer
      where name not in ('Lime Kiln webcam', 'north side of Jones Island', 'Ruston shore')
      order by name`;

    return Response.json(
      {
        type: 'FeatureCollection',
        features: [
          ...rows.map((r) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
            properties: { name: r.name, feature_class: r.feature_class }
          })),
          ...verified.map((r) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
            properties: { name: r.name, feature_class: 'Verified' }
          }))
        ]
      },
      { headers: { 'Cache-Control': CACHE } }
    );
  } catch (err) {
    console.error('get-landmarks:', err);
    return Response.json({ error: 'Query failed' }, { status: 500 });
  }
};
