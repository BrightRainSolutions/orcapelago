// Orcasound hydrophone nodes, shown as context on the map.
//
// Static rather than a table: these are fixed infrastructure, not data. Eight
// points that change maybe once a year don't justify a migration, an endpoint,
// or a row in the gazetteer.
//
// Coordinates are Orcasound's own, from https://live.orcasound.net/api/json/feeds
// (fetched 2026-08-18). Two feeds from that list are deliberately absent:
//   • "DAS - Haro Strait" — labelled Haro Strait but located at 47.88, -122.47,
//     which is central Puget Sound off Kingston, ~80km away. Mislabelled or an
//     internal node; excluded until confirmed.
//   • Lime Kiln — not an Orcasound feed at all (separate operator), despite
//     appearing in Orca Network reports alongside these. Needs its own source.
export const HYDROPHONES = [
  { name: 'Orcasound Lab',            lat: 48.5583362,        lng: -123.1735774 },
  { name: 'North San Juan Channel',   lat: 48.591294,         lng: -123.058779 },
  { name: 'Andrews Bay',              lat: 48.546653,         lng: -123.166408 },
  { name: 'Port Townsend',            lat: 48.135743,         lng: -122.760614 },
  { name: 'Bush Point',               lat: 48.0336664,        lng: -122.6040035 },
  { name: 'Beach Camp at Sunset Bay', lat: 47.86497296593844, lng: -122.33393605795372 },
  { name: 'Point Robinson',           lat: 47.388383,         lng: -122.37267 },
  { name: 'MaST Center Aquarium',     lat: 47.34922,          lng: -122.32512 }
];

// Black mic with a white halo so one icon reads on pale land and on dark
// bathymetry alike. Drawn in two passes — a wide white stroke underneath, the
// black icon over it — rather than relying on paint-order, which behaves
// inconsistently when fill and stroke colours differ per shape.
const MIC_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <g fill="none" stroke="#ffffff" stroke-width="4.5"
     stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2.5" width="6" height="10" rx="3"/>
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0"/>
    <path d="M12 17.5v3.5"/>
    <path d="M8.75 21h6.5"/>
  </g>
  <g fill="none" stroke="#111111" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2.5" width="6" height="10" rx="3" fill="#111111"/>
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0"/>
    <path d="M12 17.5v3.5"/>
    <path d="M8.75 21h6.5"/>
  </g>
</svg>`;

/** Build the DOM element for one hydrophone marker. */
export function hydrophoneElement(name) {
  const el = document.createElement('div');
  el.className = 'map-marker hydrophone-marker';
  el.title = `${name} hydrophone — Orcasound`;
  el.innerHTML = MIC_SVG;
  return el;
}
