// Basemap module (spec §3). ALL basemap concerns live here — the rest of
// the app never knows what's underneath.
//
//  1. OpenFreeMap Liberty as the base style (hosted, no key).
//  2. Seascape bathymetry composed in via @openwaters/seascape's
//     layer-composition API (sources()/layers(), NOT their full style),
//     vector contour layers only — inserted above Liberty's water fill,
//     below its labels (first symbol layer = stable insertion point).
//  3. Attribution: Seascape's flows through its TileJSON; Liberty carries
//     OpenFreeMap/OSM attribution in its own sources.
//
// ESCAPE HATCH: both basemap and bathymetry can later be swapped to
// self-hosted PMTiles served as Netlify static assets via the `pmtiles`
// protocol adapter. The module boundary makes that a change to this file
// only. See spec companion note (custom bathymetry build).
import {
  day,
  sources as seascapeSources,
  layers as seascapeLayers,
  state as seascapeState
} from '@openwaters/seascape';

export const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const SEASCAPE_TILES_BASE = 'https://tiles.openwaters.io/seascape';

export const SALISH_SEA_CENTER = [-122.6, 48.2];
export const DEFAULT_ZOOM = 8;

/**
 * Build the composed MapLibre style: Liberty + Seascape vector bathymetry.
 * Falls back to plain Liberty if composition fails (e.g. seascape tiles
 * unreachable) — the map must never be blank because of bathymetry.
 * @returns {Promise<object|string>} style object, or style URL on fallback
 */
export async function buildBasemapStyle() {
  try {
    const res = await fetch(LIBERTY_STYLE_URL);
    if (!res.ok) throw new Error(`Liberty style fetch: HTTP ${res.status}`);
    const liberty = await res.json();

    // Liberty's glyph endpoint serves Noto, not seascape's default Open Sans.
    const flavor = { ...day, font: ['Noto Sans Regular'] };

    const allSources = seascapeSources({ tilesBase: SEASCAPE_TILES_BASE });
    // Vector contours only (spec §3): skip the DEM depth-shading/hillshade
    // rasters and the source-provenance overlay layers.
    const bathyLayers = seascapeLayers(flavor).filter(
      (l) => l.source === 'seascape-vector' && !l.id.startsWith('source-')
    );

    const firstSymbol = liberty.layers.findIndex((l) => l.type === 'symbol');
    const insertAt = firstSymbol === -1 ? liberty.layers.length : firstSymbol;

    return {
      ...liberty,
      // Global-state defaults driving seascape's unit/safety expressions.
      state: { ...seascapeState, ...(liberty.state ?? {}) },
      sources: { ...liberty.sources, 'seascape-vector': allSources['seascape-vector'] },
      layers: [
        ...liberty.layers.slice(0, insertAt),
        ...bathyLayers,
        ...liberty.layers.slice(insertAt)
      ]
    };
  } catch (err) {
    console.warn('[orcapelago] basemap composition failed, falling back to Liberty:', err);
    return LIBERTY_STYLE_URL;
  }
}
