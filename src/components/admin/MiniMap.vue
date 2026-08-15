<template>
  <div ref="container" class="mini-map"></div>
</template>

<script setup>
// Click-to-place coordinate picker for the review queue (spec §8.4).
// Plain Liberty style — no bathymetry needed at this size.
import { onMounted, onUnmounted, ref, watch } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LIBERTY_STYLE_URL, SALISH_SEA_CENTER } from '../../map/basemap.js';

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
    marker = new maplibregl.Marker({ color: '#006D77' }).setLngLat([lng, lat]).addTo(map);
  } else {
    marker.setLngLat([lng, lat]);
  }
}

onMounted(() => {
  const hasCoords = Number.isFinite(props.lat) && Number.isFinite(props.lng);
  map = new maplibregl.Map({
    container: container.value,
    style: LIBERTY_STYLE_URL,
    center: hasCoords ? [props.lng, props.lat] : SALISH_SEA_CENTER,
    zoom: hasCoords ? 10 : 6.5
  });
  if (hasCoords) setMarker(props.lat, props.lng);
  map.on('click', (e) => {
    setMarker(e.lngLat.lat, e.lngLat.lng);
    emit('place', { lat: e.lngLat.lat, lng: e.lngLat.lng });
  });
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
