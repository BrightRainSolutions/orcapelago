// Public webcams that Orca Network reports cite, shown as context on the map.
//
// Same rationale as hydrophones.js: fixed infrastructure, not data, so a
// static list beats a table, an endpoint and a migration.
//
// A camera differs from a hydrophone in what its coordinate MEANS. An
// acoustic detection is located at the sensor; a camera detection is located
// somewhere in the water the camera is pointed at. The marker here is the
// camera. Where a report gives no location beyond "on the webcam", the
// sighting is placed offshore in the camera's view via a gazetteer entry
// ("Lime Kiln webcam"), not on the camera itself — see architecture §5 and
// the "Whale or whale-seer?" note.
//
// Lime Kiln coordinate is GNIS "Lime Kiln Point" (Cape, San Juan County) from
// our own landmarks import: 48.5158709, -123.1524506. The lighthouse sits on
// the point.
//
// DELIBERATELY ABSENT — both appear in newsletters but neither has a
// confirmed camera position yet:
//   • Skunkbay Weather webcam (north Kitsap). GNIS has "Skunk Bay" at
//     47.9273114, -122.5835011, but that is the bay, not the camera.
//   • Pebble Beach Cam (Camano Island). Not in GNIS at all.
//
// Operator is credited on the stream itself — "brought to you by The Whale
// Museum and SMRU Consulting" (frame captured 2026-08-22) — so it carries a
// map attribution line the way the Orcasound hydrophones do.
//
// `facing` is which way the lens points, and exists only so the icon does.
// A camera glyph aimed inland reads as pointing away from the water it
// watches; Lime Kiln looks west across Haro Strait.
export const WEBCAMS = [
  { name: 'Lime Kiln Lighthouse', lat: 48.5158709, lng: -123.1524506, facing: 'west' }
];

// Two-pass draw for the same reason as the mic: a wide white stroke beneath
// the black icon so one glyph reads on pale land and dark bathymetry alike.
const CAM_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <g fill="none" stroke="#ffffff" stroke-width="4.5"
     stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="7" width="13" height="10" rx="2"/>
    <path d="M15.5 11.2 21 8.2v7.6l-5.5-3z"/>
  </g>
  <g fill="none" stroke="#111111" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="7" width="13" height="10" rx="2" fill="#111111"/>
    <path d="M15.5 11.2 21 8.2v7.6l-5.5-3z" fill="#111111"/>
  </g>
</svg>`;

/**
 * Build the DOM element for one webcam marker. Mirrored for west-facing
 * cameras so the lens points at the water rather than inland.
 */
export function webcamElement(cam) {
  const el = document.createElement('div');
  el.className = 'map-marker webcam-marker';
  if (cam.facing === 'west') el.classList.add('faces-west');
  el.title = `${cam.name} webcam`;
  el.innerHTML = CAM_SVG;
  return el;
}
