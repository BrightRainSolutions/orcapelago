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

  /**
   * Verified places from the gazetteer, drawn in gold.
   *
   * Styled apart from the federal names on purpose: these are the places a
   * person worked out and checked, and several — Stamm Overlook Park,
   * Appletree Cove, Active Pass — do not exist in GNIS at all. Telling them
   * apart at a glance is the point, on the public map as much as the picker.
   *
   * The server drops any federal feature sharing a name with one of these, so
   * nothing is labelled twice. From zoom 10: they are specific places, not
   * basin-scale features, and at wider zooms their names crowd out the straits
   * and bays that orient you.
   */
  map.addLayer({
    id: 'landmarks-verified',
    type: 'symbol',
    source: 'landmarks',
    minzoom: Math.max(0, 10 + minzoomShift),
    filter: ['==', ['get', 'feature_class'], 'Verified'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-padding': 3,
      'symbol-sort-key': 2.5
    },
    paint: {
      'text-color': '#8B6508',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.4
    }
  });

  addBuoyIcon(map);

  /**
   * Buoys, drawn as buoys.
   *
   * These are the only landmarks that are objects floating in the water rather
   * than named stretches of coast, and reporters cite them as things they can
   * SEE: "by the yellow research buoy just offshore", "midchannel south of
   * yellow buoy". A label alone does not help you judge that, and nor does a
   * dot — the shape is what tells you at a glance that this is a mark in the
   * water and not another place name.
   *
   * Drawn from zoom 9, the same band as Bay and Channel: a buoy is something
   * you navigate by at the scale where you are placing a sighting, not a
   * detail that only matters close in. The label joins it two zooms later, so
   * the mark appears before its name crowds the view.
   *
   * icon-anchor 'bottom' puts the buoy's waterline on the coordinate rather
   * than centring the sprite over it.
   */
  // No minzoom: buoys draw at every zoom, including the opening view.
  //
  // They were banded at 9 to match Bay and Channel, which made them invisible
  // on load — DEFAULT_ZOOM is 8, one level below. There are only seventeen of
  // them and they are spread across the whole basin, so showing them always
  // costs nothing in clutter and is what makes them useful: you can see where
  // the marks are before deciding where to zoom.
  //
  // The size ramp is anchored to ABSOLUTE zooms rather than to the threshold,
  // so it stays sane no matter what minzoomShift the mini-map passes in.
  map.addLayer({
    id: 'landmarks-buoy',
    type: 'symbol',
    source: 'landmarks',
    filter: ['==', ['get', 'feature_class'], 'Buoy'],
    layout: {
      'icon-image': BUOY_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 0.95],
      'icon-anchor': 'bottom',
      // The mark is the point of the layer: never drop it for a label.
      'icon-allow-overlap': true,
      // The name only once there is room for it; the icon carries the position.
      'text-field': ['step', ['zoom'], '', 10, ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10.5,
      'text-offset': [0, 0.5],
      'text-anchor': 'top',
      'text-padding': 3,
      // Below the named-coast bands: the icon already carries the position, so
      // on a collision the shoreline name is the more useful label to keep.
      'symbol-sort-key': 4
    },
    paint: {
      'text-color': '#5A6165',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.3
    }
  });
}

const BUOY_ICON = 'buoy-special';

/**
 * Register the buoy sprite.
 *
 * Drawn here rather than taken from the basemap sprite because OpenFreeMap's
 * sprite is a road-map sprite and carries no sea marks; a missing icon-image
 * renders nothing at all, silently, exactly like a wrong font name.
 *
 * Styled to match the hydrophone and webcam markers: black line art over a
 * wide white halo, drawn in two passes — halo first, icon over it — on the
 * same 24x24 grid. One icon language across the map, and the halo is the
 * functional half of it: it keeps the mark readable on pale land and on dark
 * bathymetry alike, which a coloured outline does not.
 *
 * The shape is an IALA special mark — hull, mast, X topmark. The X is what
 * makes it read as a mark in the water rather than a generic pin, and it is
 * carrying the meaning that the colour used to: these buoys are yellow in
 * life, and reporters say so ("the yellow research buoy"), but the icon is
 * monochrome because consistency across the map matters more than echoing
 * one attribute. Navigation buoys, if ever added, are a different class and
 * their colour must come off the Light List, not from here.
 *
 * Rasterised at 2x so it stays crisp on retina, registered with the same
 * pixelRatio so MapLibre scales it back down.
 */
function addBuoyIcon(map) {
  if (map.hasImage?.(BUOY_ICON)) return;
  const ratio = 2;
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.scale(ratio, ratio);

  const path = () => {
    g.beginPath();
    // Hull: squat, wider at the waterline.
    g.moveTo(7.5, 20.5);
    g.lineTo(9.3, 13);
    g.lineTo(14.7, 13);
    g.lineTo(16.5, 20.5);
    g.closePath();
    // Mast.
    g.moveTo(12, 13);
    g.lineTo(12, 8.2);
    // X topmark.
    g.moveTo(9.2, 3);
    g.lineTo(14.8, 8);
    g.moveTo(14.8, 3);
    g.lineTo(9.2, 8);
  };

  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.fillStyle = 'none';

  // Pass 1: the halo.
  g.strokeStyle = '#ffffff';
  g.lineWidth = 4.5;
  path();
  g.stroke();

  // Pass 2: the icon.
  g.strokeStyle = '#111111';
  g.lineWidth = 1.9;
  path();
  g.stroke();

  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  map.addImage(BUOY_ICON, { width: img.width, height: img.height, data: img.data }, { pixelRatio: ratio });
}
