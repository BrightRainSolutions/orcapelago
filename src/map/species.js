// Species constants shared by map styling, filters, popups, and the admin
// review queue (spec §8).
//
// `orca: true` drives the default view: the app is called Orcapelago, so the
// four orca ecotypes are checked on load and everything else sits behind a
// collapsed "Other Species" disclosure. Order here is the order they render in
// the filter panel — orcas first.
//
// PALETTE — near-monochrome with a single accent, matching the black-and-white
// chrome. Differentiation is by fill weight rather than hue, the way a chart
// does it:
//   biggs              black — 95% of sightings, so it IS the baseline
//   southern_resident  Bright Rain blue — the one accent, spent on the
//                      endangered population this project exists for
//   northern_resident  mid grey — present but rare in these waters
//   unidentified_orca  hollow — "we don't know" reads as unfilled, not as a
//                      bright colour competing with everything else
// Non-orca species take warmer, lighter tones so the two groups separate at a
// glance even when "Other Species" is switched on.
//
// `icon` is the image the selected-sighting marker draws — see whale-icons.js
// for why there are four of them and not nine. It lives here, beside the
// colour, for the same reason the colour does: the marker and the legend are
// two views of one row, and a species added to this table without an icon would
// otherwise render as an empty patch of water.
//
// `color` is the fill, `ring` the outline — used for both the map marker's
// stroke and the legend swatch's border, so the two cannot drift apart.
//
// NOTE: ReviewQueue's species <select> iterates the whole object on purpose.
// An admin must be able to reclassify a sighting to ANY species, orca or not,
// so never filter this map down to the orca subset for that control.
import { ORCA_ICON, HUMPBACK_ICON, GRAY_ICON, OTHER_ICON } from './whale-icons.js';

export const SPECIES = {
  southern_resident:   { label: 'Southern Resident',   color: '#0044AA', ring: '#FFFFFF', icon: ORCA_ICON,     orca: true },
  northern_resident:   { label: 'Northern Resident',   color: '#5A6165', ring: '#FFFFFF', icon: ORCA_ICON,     orca: true },
  biggs:               { label: "Bigg's",              color: '#111111', ring: '#FFFFFF', icon: ORCA_ICON,     orca: true },
  unidentified_orca:   { label: 'Unidentified Orca',   color: '#FFFFFF', ring: '#111111', icon: ORCA_ICON,     orca: true },
  gray:                { label: 'Gray Whale',          color: '#9B7653', ring: '#FFFFFF', icon: GRAY_ICON },
  humpback:            { label: 'Humpback',            color: '#7A8B99', ring: '#FFFFFF', icon: HUMPBACK_ICON },
  minke:               { label: 'Minke',               color: '#B0B7BB', ring: '#FFFFFF', icon: OTHER_ICON },
  unidentified_baleen: { label: 'Unidentified Baleen', color: '#FFFFFF', ring: '#9AA5AB', icon: OTHER_ICON },
  other:               { label: 'Other',               color: '#D8DEE1', ring: '#FFFFFF', icon: OTHER_ICON }
};

/** Clusters hold mixed species, so they can't honestly carry any one species
 *  colour — they were hardcoded to Southern Resident's teal, which meant a
 *  cluster of Bigg's rendered in the legend colour for Southern Residents. */
export const CLUSTER_COLOR = '#111111';

/** The four orca ecotypes — checked on load. */
export const ORCA_KEYS = Object.keys(SPECIES).filter((k) => SPECIES[k].orca);

/** Everything else — collapsed and unchecked on load. */
export const OTHER_KEYS = Object.keys(SPECIES).filter((k) => !SPECIES[k].orca);

/** Build a MapLibre `match` expression over a SPECIES property. */
export function speciesExpr(prop, fallback) {
  return [
    'match',
    ['get', 'species'],
    ...Object.entries(SPECIES).flatMap(([key, def]) => [key, def[prop]]),
    fallback
  ];
}
