<template>
  <!--
    The wrapper carries the sizing class (.review-map stretches it in review,
    .gaz-placer gives it a fixed height); the canvas fills it absolutely so the
    toggle can sit on top without MapLibre owning the button.
  -->
  <div class="mini-map">
    <div ref="container" class="mini-map-canvas"></div>
    <button
      type="button"
      class="mini-map-aerial"
      :class="{ active: aerial }"
      :aria-pressed="aerial"
      @click="toggleAerial"
    >{{ aerial ? 'Map' : 'Aerial' }}</button>
  </div>
</template>

<script setup>
// Coordinate picker for the review queue (spec §8.4).
//
// Click anywhere to place, or drag the pin to nudge — dragging is the one that
// matters when a sighting sits fifty metres off a point and re-clicking would
// overshoot.
//
// Carries the landmark labels. Without them you are placing "1.5 miles north
// of Hidden Beach" on a blank sea; with them the named ground is right there.
// The bands are shifted down three zoom levels because this map opens at zoom
// 10, where the public map's thresholds would show only Bay and Channel and
// hide Beach — the class most often needed here.
import { onMounted, onUnmounted, ref, watch } from 'vue';
import maplibregl from 'maplibre-gl';
import { AERIAL_ATTRIBUTION, AERIAL_TILES, BASEMAP_STYLE_URL, SALISH_SEA_CENTER } from '../../map/basemap.js';
import { addLandmarkLayers } from '../../map/landmark-layers.js';
import { fetchLandmarks } from '../../api/landmarks.js';

const props = defineProps({
  lat: Number,
  lng: Number,
  /**
   * Identity of the thing being placed — the sighting id in review.
   *
   * Framing keys off THIS, not off the coordinates. Two consecutive rows can
   * share a location_raw and therefore an identical lat/lng, and a coordinate
   * watcher does not fire when nothing changed, so the map would sit still on
   * a row you just selected.
   */
  focusKey: { type: [String, Number], default: null }
});
const emit = defineEmits(['place']);

const container = ref(null);
const aerial = ref(false);
const AERIAL_LAYER = 'aerial-imagery';

/**
 * Zoom used when a new row is selected.
 *
 * 13 shows a few kilometres across: enough to see the pin, the shoreline it
 * should relate to, and the water it belongs in. The review queue's own band
 * of interest is 100 m to 5 km inland, so anything tighter hides the error you
 * are being asked to judge, and the map's opening zoom of 10 is too wide to
 * place anything precisely.
 */
const FOCUS_ZOOM = 13;
let map;
let marker;
let resizeObserver;

/**
 * True while a coordinate change originated HERE — a click or a pin drag.
 *
 * Without it, dropping the pin emits, the parent updates form.lat/lng, the
 * prop flows back, and the watcher below runs easeTo() on the point just
 * dropped. Removing this reintroduces the jump, which is how we know it is
 * load-bearing rather than cosmetic: the map camera moving as a direct result
 * of the user's own placement is part of the fault, not merely an annoyance
 * beside it.
 *
 * Watchers are post-flush, so the flag is set before emitting and cleared by
 * the watcher on its way through.
 */
let selfPlaced = false;

function place(lat, lng) {
  selfPlaced = true;
  emit('place', { lat, lng });
}

function toggleAerial() {
  aerial.value = !aerial.value;
  if (map?.getLayer(AERIAL_LAYER)) {
    map.setLayoutProperty(AERIAL_LAYER, 'visibility', aerial.value ? 'visible' : 'none');
  }
}

function setMarker(lat, lng) {
  if (!map) return;
  if (!marker) {
    // Accent blue: this is the one thing on the map you manipulate.
    marker = new maplibregl.Marker({ color: '#0044AA', draggable: true })
      .setLngLat([lng, lat])
      .addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      place(p.lat, p.lng);
    });
  } else {
    marker.setLngLat([lng, lat]);
  }
}

onMounted(async () => {
  const hasCoords = Number.isFinite(props.lat) && Number.isFinite(props.lng);
  map = new maplibregl.Map({
    container: container.value,
    style: BASEMAP_STYLE_URL,
    center: hasCoords ? [props.lng, props.lat] : SALISH_SEA_CENTER,
    zoom: hasCoords ? 10 : 6.5
  });
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  /**
   * Aerial imagery, added hidden and toggled on demand.
   *
   * Added BEFORE the landmark layers so those draw on top of it — the names
   * are what make a photograph navigable. It does cover the basemap's own
   * labels, which is the trade: imagery mode is for pinning the end of a dock,
   * not for reading place names.
   */
  map.once('load', () => {
    if (!map || map.getLayer(AERIAL_LAYER)) return;
    map.addSource(AERIAL_LAYER, {
      type: 'raster',
      tiles: [AERIAL_TILES],
      tileSize: 256,
      maxzoom: 19,
      attribution: AERIAL_ATTRIBUTION
    });
    map.addLayer({
      id: AERIAL_LAYER,
      type: 'raster',
      source: AERIAL_LAYER,
      // Honour a toggle pressed before the style finished loading, rather than
      // leaving the button saying "Map" over a map with no imagery on it.
      layout: { visibility: aerial.value ? 'visible' : 'none' }
    });
  });
  if (hasCoords) setMarker(props.lat, props.lng);
  map.on('click', (e) => {
    setMarker(e.lngLat.lat, e.lngLat.lng);
    place(e.lngLat.lat, e.lngLat.lng);
  });

  /**
   * Keep MapLibre's idea of the container in step with the real one.
   *
   * MapLibre caches the container's dimensions when the map is constructed and
   * projects every click through them. This map lives in a full-bleed flex
   * layout that settles AFTER mount, so a stale height skews every click by
   * (stale - real) / 2 pixels in a fixed direction. There was no resize
   * handling here at all.
   */
  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(container.value);
  map.once('load', () => map?.resize());

  // Labels are context; a failure here must not cost the picker.
  const landmarks = await fetchLandmarks();
  if (!map || !landmarks.features.length) return;
  const add = () => addLandmarkLayers(map, landmarks, { minzoomShift: -3 });
  if (map.isStyleLoaded()) add();
  else map.once('load', add);
});

let lastFocus = props.focusKey;

watch(
  () => [props.focusKey, props.lat, props.lng],
  ([key, lat, lng]) => {
    const changedRow = key !== lastFocus;
    lastFocus = key;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    // The user's own click or drag: the pin is already where they put it, and
    // moving the camera now is what produced the jump.
    if (selfPlaced) {
      selfPlaced = false;
      return;
    }
    setMarker(lat, lng);
    // A NEW row gets framed — fly there and zoom in, because you are about to
    // judge whether that pin is in the right water. A coordinate typed into the
    // Lat/Lng fields on the SAME row only re-centres: changing zoom under
    // someone who is fine-tuning a position is the same class of annoyance as
    // the placement jump above.
    //
    // max(current, FOCUS_ZOOM), not FOCUS_ZOOM: it guarantees a zoom-in from
    // the map's wide opening view, but never yanks back OUT of a tighter zoom
    // the reviewer chose. Working a queue, you settle on a scale — often much
    // tighter with imagery on — and each new row should keep it.
    if (changedRow) {
      map?.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), FOCUS_ZOOM) });
    } else {
      map?.easeTo({ center: [lng, lat] });
    }
  }
);

onUnmounted(() => {
  resizeObserver?.disconnect();
  map?.remove();
});
</script>
