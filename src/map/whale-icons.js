// Map icons for the selected sighting (spec §8).
//
// One image for every species was a lie the map told: click a Humpback and a
// spyhopping orca appeared on the water. The selected marker is the only place
// the app draws an animal rather than a dot, so it is the one place the species
// has to be right.
//
// Four icons, not nine. The orca ecotypes share the spyhop because ecotype is a
// population, not a body — nobody identifies a Bigg's by its silhouette. The
// two species with a gesture a sighting report actually describes get that
// gesture: the humpback its rolling hump, the gray its raised flukes. Everything
// else gets a featureless back, which is the honest picture of "a whale, and we
// did not get a better look".
//
// GEOMETRY — all four share a 100x100 box with the waterline at y=64, measured
// off orca-spy.png (its waterline is rows 63-64, art from y=29 to y=70). That
// is what keeps the swap from jumping: `icon-anchor: center` puts (50,50) on the
// sighting coordinate, so if the icons disagreed about where the water is, the
// whale would hop up or down as the selection moved between species.
//
// The waterline is stroked first and the body filled over it, both in #111111 —
// no gap to keep in sync with the silhouette, unlike the buoy mark where the
// halo demands two passes.

/** Drawn at 2x and registered at that pixelRatio, so MapLibre scales it back
 *  down to the same 100x100 logical size as the PNG and `icon-size` applies
 *  unchanged. */
const RATIO = 2;
const BOX = 100;
const WATER_Y = 64;

export const ORCA_ICON = 'orca-spy';
export const HUMPBACK_ICON = 'whale-humpback';
export const GRAY_ICON = 'whale-gray';
export const OTHER_ICON = 'whale-other';

function waterline(g) {
  g.strokeStyle = '#111111';
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(4, WATER_Y);
  g.lineTo(96, WATER_Y);
  g.stroke();
}

/** Rolling back with the hump two thirds aft and the stubby dorsal on its
 *  crest — a humpback at the surface, head to the left. The fin is deliberately
 *  small: scaled up it reads as an orca, which is the confusion this whole
 *  module exists to end. */
function drawHumpback(g) {
  waterline(g);
  g.fillStyle = '#111111';
  g.beginPath();
  g.moveTo(6, 66);
  g.bezierCurveTo(16, 55, 30, 48, 46, 47);
  g.bezierCurveTo(54, 46, 58, 40, 62, 36);
  g.bezierCurveTo(66, 33, 70, 34, 73, 40);
  g.bezierCurveTo(80, 50, 88, 59, 94, 66);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(61, 37);
  g.bezierCurveTo(63, 31, 67, 28, 70, 28);
  g.bezierCurveTo(70, 32, 72, 36, 73, 40);
  g.closePath();
  g.fill();
}

/** Flukes up, the gray whale's diving gesture. Broad lobes with a median notch
 *  — thin swept tips read as a bird, so the lobes carry the weight and the
 *  tips only taper. The stock is drawn first and tapers into the water; its top
 *  overlaps the notch so no pinhole opens where the two paths meet. */
function drawGray(g) {
  waterline(g);
  g.fillStyle = '#111111';
  g.beginPath();
  g.moveTo(46, 49);
  g.lineTo(54, 49);
  g.lineTo(52, 70);
  g.lineTo(48, 70);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(6, 36);
  g.bezierCurveTo(14, 50, 30, 60, 46, 64);
  g.lineTo(50, 50);
  g.lineTo(54, 64);
  g.bezierCurveTo(70, 60, 86, 50, 94, 36);
  g.bezierCurveTo(82, 41, 64, 45, 50, 46);
  g.bezierCurveTo(36, 45, 18, 41, 6, 36);
  g.closePath();
  g.fill();
}

/** A back breaking the surface and nothing else — no fin, no flukes, no blow.
 *  The absence is the point: every feature it does not have is a feature the
 *  report did not give us. */
function drawOther(g) {
  waterline(g);
  g.fillStyle = '#111111';
  g.beginPath();
  g.moveTo(8, 68);
  g.bezierCurveTo(20, 52, 38, 42, 56, 42);
  g.bezierCurveTo(72, 42, 84, 54, 92, 68);
  g.closePath();
  g.fill();
}

function register(map, name, draw) {
  if (map.hasImage?.(name)) return true;
  const canvas = document.createElement('canvas');
  canvas.width = BOX * RATIO;
  canvas.height = BOX * RATIO;
  const g = canvas.getContext('2d');
  if (!g) return false;
  g.scale(RATIO, RATIO);
  g.lineJoin = 'round';
  draw(g);
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  map.addImage(name, { width: img.width, height: img.height, data: img.data }, { pixelRatio: RATIO });
  return true;
}

/**
 * Register every selected-sighting icon. The three canvas marks are drawn
 * locally and cannot fail over the network; the orca spyhop is a PNG asset and
 * can. If it does, orcas fall back to the featureless back rather than to no
 * marker at all — a plain whale on the water is a worse picture than the
 * spyhop, but an empty spot on the water looks like a broken app.
 */
export async function addWhaleIcons(map) {
  register(map, HUMPBACK_ICON, drawHumpback);
  register(map, GRAY_ICON, drawGray);
  register(map, OTHER_ICON, drawOther);
  if (map.hasImage?.(ORCA_ICON)) return;
  try {
    const img = await map.loadImage('/orca-spy.png');
    if (!map.hasImage(ORCA_ICON)) map.addImage(ORCA_ICON, img.data);
  } catch (err) {
    console.warn('[orcapelago] orca-spy icon unavailable:', err.message);
    register(map, ORCA_ICON, drawOther);
  }
}
