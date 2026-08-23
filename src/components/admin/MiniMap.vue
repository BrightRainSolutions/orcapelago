<template>
  <div ref="container" class="mini-map"></div>
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
import { BASEMAP_STYLE_URL, SALISH_SEA_CENTER } from '../../map/basemap.js';
import { addLandmarkLayers } from '../../map/landmark-layers.js';
import { fetchLandmarks } from '../../api/landmarks.js';

const props = defineProps({
  lat: Number,
  lng: Number
});
const emit = defineEmits(['place']);

const container = ref(null);
let map;
let marker;

function setMarker(lat, lng) {
  if (!map) return;
  if (!marker) {
    // Accent blue: this is the one thing on the map you manipulate.
    marker = new maplibregl.Marker({ color: '#0044AA', draggable: true })
      .setLngLat([lng, lat])
      .addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      emit('place', { lat: p.lat, lng: p.lng });
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
  if (hasCoords) setMarker(props.lat, props.lng);
  map.on('click', (e) => {
    setMarker(e.lngLat.lat, e.lngLat.lng);
    emit('place', { lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  // Labels are context; a failure here must not cost the picker.
  const landmarks = await fetchLandmarks();
  if (!map || !landmarks.features.length) return;
  const add = () => addLandmarkLayers(map, landmarks, { minzoomShift: -3 });
  if (map.isStyleLoaded()) add();
  else map.once('load', add);
});

watch(
  () => [props.lat, props.lng],
  ([lat, lng]) => {
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setMarker(lat, lng);
      map?.easeTo({ center: [lng, lat] });
    }
  }
);

onUnmounted(() => map?.remove());
</script>
