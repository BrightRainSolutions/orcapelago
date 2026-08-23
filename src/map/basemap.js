// Basemap module (spec §3). ALL basemap concerns live here — the rest of
// the app never knows what's underneath.
//
//  1. OpenFreeMap positron as the base style (hosted, no key).
//  2. Seascape bathymetry composed in via @openwaters/seascape's
//     layer-composition API (sources()/layers(), NOT their full style),
//     inserted above the base water fill and below its labels (the first
//     symbol layer is a stable insertion point across flavours).
//  3. Attribution: Seascape's flows through its TileJSON; the base carries
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

// Basemap flavour. OpenFreeMap serves liberty | positron | bright | dark from
// the same glyph endpoint, so switching is genuinely one word — the font
// override below and the layer-insertion heuristic hold for all of them.
//
// positron: near-white land, pale labels, ~55 layers. Chosen over Liberty's
// ~111 so the sightings read as the content rather than competing with roads
// and landuse. (Spec §2 names Liberty; this is a deliberate deviation.)
export const BASEMAP_STYLE = 'positron';
export const BASEMAP_STYLE_URL = `https://tiles.openfreemap.org/styles/${BASEMAP_STYLE}`;
export const SEASCAPE_TILES_BASE = 'https://tiles.openwaters.io/seascape';

export const SALISH_SEA_CENTER = [-122.6, 48.2];
export const DEFAULT_ZOOM = 8;

/**
 * Build the composed MapLibre style: positron + Seascape bathymetry.
 * Falls back to the plain style if composition fails (e.g. seascape
 * tiles unreachable) — the map must never be blank because of bathymetry.
 * @returns {Promise<object|string>} style object, or style URL on fallback
 */
export async function buildBasemapStyle() {
  try {
    const res = await fetch(BASEMAP_STYLE_URL);
    if (!res.ok) throw new Error(`Basemap style fetch: HTTP ${res.status}`);
    const base = await res.json();

    // The glyph endpoint serves Noto, not seascape's default Open Sans.
    const flavor = { ...day, font: ['Noto Sans Regular'] };

    const allSources = seascapeSources({ tilesBase: SEASCAPE_TILES_BASE });
    // Vector layers only. Seascape also ships a raster DEM with two layers,
    // both tried and rejected on 2026-08-18:
    //
    //   depth-shading  a colour-relief ramp (#e9f7ff to #1f86cb by depth, plus
    //                  a translucent tan at elevation 0). It turned the sea
    //                  blue and the land beige, colliding with the palette —
    //                  the point of #0044AA is that it is the only colour here.
    //   hillshade      ships with visibility:"none". Switched on and retinted
    //                  neutral, it added almost nothing visible: the seafloor
    //                  in these waters is broad and smooth, so there is little
    //                  relief to catch light. It cost a second tile source and
    //                  noticeably slower loads for that.
    //
    // The source-* layers are provenance overlays, shading by which survey each
    // patch came from. Useful to a hydrographer, noise here.
    const bathyLayers = seascapeLayers(flavor).filter(
      (l) => l.source === 'seascape-vector' && !l.id.startsWith('source-')
    );

    const firstSymbol = base.layers.findIndex((l) => l.type === 'symbol');
    const insertAt = firstSymbol === -1 ? base.layers.length : firstSymbol;

    return {
      ...base,
      // Global-state defaults driving seascape's unit/safety expressions.
      state: { ...seascapeState, ...(base.state ?? {}) },
      // Vector tiles only; the raster DEM source is deliberately not included,
      // so MapLibre never requests those tiles.
      sources: { ...base.sources, 'seascape-vector': allSources['seascape-vector'] },
      layers: [
        ...base.layers.slice(0, insertAt),
        ...bathyLayers,
        ...base.layers.slice(insertAt)
      ]
    };
  } catch (err) {
    console.warn('[orcapelago] basemap composition failed, falling back to plain style:', err);
    return BASEMAP_STYLE_URL;
  }
}
