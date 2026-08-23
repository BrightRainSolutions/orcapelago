// Landmark label layers, shared by the public map and the admin review
// mini-map (architecture §12).
//
// Extracted from MapView so the review picker shows the same named ground the
// public map does. Placing "1.5 miles north of Hidden Beach" against a blank
// sea is guesswork; placing it against a labelled Hidden Beach is not.

// Banded by feature class so density scales with zoom rather than dumping
// 1,144 labels into the default viewport and letting MapLibre's collision
// detection thin them by draw order. Lower symbol-sort-key wins a collision,
// so the bands double as a priority ranking.
export const LANDMARK_BANDS = [
  { id: 'landmarks-major', minzoom: 9, sort: 1, classes: ['Bay', 'Channel'] },
  { id: 'landmarks-mid', minzoom: 11, sort: 2, classes: ['Island', 'Cape'] },
  { id: 'landmarks-minor', minzoom: 13, sort: 3, classes: ['Beach', 'Bar', 'Cliff', 'Pillar', 'Gut'] }
];

/**
 * Add the label layers to a map. Base data: non-interactive, always on.
 *
 * @param {maplibregl.Map} map
 * @param {object} data GeoJSON FeatureCollection from fetchLandmarks()
 * @param {{ minzoomShift?: number }} [opts]
 *   minzoomShift lowers every band's threshold. The review mini-map opens at
 *   zoom 10, where the default bands would show only Bay and Channel — and
 *   Beach, the class you most need when placing a shoreline sighting, would be
 *   invisible. A shift of -3 brings all three bands into view there. The small
 *   viewport keeps the count manageable at those zooms.
 */
export function addLandmarkLayers(map, data, { minzoomShift = 0 } = {}) {
  map.addSource('landmarks', { type: 'geojson', data });

  for (const band of LANDMARK_BANDS) {
    const minzoom = Math.max(0, band.minzoom + minzoomShift);
    map.addLayer({
      id: band.id,
      type: 'symbol',
      source: 'landmarks',
      minzoom,
      filter: ['in', ['get', 'feature_class'], ['literal', band.classes]],
      layout: {
        'text-field': ['get', 'name'],
        // MUST be Noto: the glyph endpoint serves it and nothing else, and a
        // wrong font name renders no text at all, silently. Same trap the
        // Seascape composition hits.
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], minzoom, 10, minzoom + 5, 12.5],
        'text-padding': 4,
        'symbol-sort-key': band.sort
      },
      paint: {
        'text-color': '#5A6165',
        // Essential: these sit over bathymetry contours and soundings.
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.3
      }
    });
  }
}
