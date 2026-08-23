// Landmark reference data for the map's label layers (architecture §12).
//
// Deliberately NOT composed into basemap.js. That module depends only on
// external tile services and has no coupling to this app's API — which is what
// keeps the PMTiles escape hatch a change to one file. It also falls back to a
// plain style URL on any error, so a landmark fetch failing there would take
// the whole composed style, bathymetry included, down with it.
//
// Here, a failure costs labels and nothing else.

/**
 * @returns {Promise<object>} GeoJSON FeatureCollection; empty on failure.
 */
export async function fetchLandmarks() {
  try {
    const res = await fetch('/api/landmarks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.type !== 'FeatureCollection') throw new Error('unexpected payload');
    return data;
  } catch (err) {
    console.info('[orcapelago] /api/landmarks unavailable, map runs unlabelled:', err.message);
    return { type: 'FeatureCollection', features: [] };
  }
}
