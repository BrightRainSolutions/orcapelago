<template>
  <main class="map-view">
    <div ref="mapContainer" class="map-container"></div>
    <FilterPanel
      v-model:from="filters.from"
      v-model:to="filters.to"
      v-model:species="filters.species"
    />
    <div class="map-status">
      <span>{{ visibleCount }} sighting{{ visibleCount === 1 ? '' : 's' }}</span>
      <span v-if="dataSource === 'fake'" class="demo-badge">demo data</span>
    </div>
  </main>
</template>

<script setup>
// Map view (spec §8.1): full-bleed MapLibre map, sightings as a clustered
// GeoJSON source colored by species, popups, date/species filters.
import { onMounted, onUnmounted, reactive, ref, computed, watch } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildBasemapStyle, SALISH_SEA_CENTER, DEFAULT_ZOOM } from '../map/basemap.js';
import { SPECIES } from '../map/species.js';
import { popupHtml } from '../map/popup.js';
import { fetchSightings } from '../api/sightings.js';
import FilterPanel from '../components/FilterPanel.vue';

const mapContainer = ref(null);
const dataSource = ref('api');
const allFeatures = ref([]);
const filters = reactive({
  from: '',
  to: '',
  species: Object.keys(SPECIES)
});

let map;

const visibleFeatures = computed(() =>
  allFeatures.value.filter((f) => {
    const p = f.properties;
    if (filters.from && p.sighting_date < filters.from) return false;
    if (filters.to && p.sighting_date > filters.to) return false;
    return filters.species.includes(p.species);
  })
);
const visibleCount = computed(() => visibleFeatures.value.length);

const speciesColorExpr = [
  'match',
  ['get', 'species'],
  ...Object.entries(SPECIES).flatMap(([key, def]) => [key, def.color]),
  SPECIES.other.color
];

function addSightingLayers() {
  map.addSource('sightings', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 45
  });
  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'sightings',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#006D77',
      'circle-opacity': 0.85,
      'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff'
    }
  });
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'sightings',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12
    },
    paint: { 'text-color': '#ffffff' }
  });
  map.addLayer({
    id: 'sighting-points',
    type: 'circle',
    source: 'sightings',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': speciesColorExpr,
      'circle-radius': 7,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.on('click', 'clusters', async (e) => {
    const feature = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
    const zoom = await map.getSource('sightings').getClusterExpansionZoom(feature.properties.cluster_id);
    map.easeTo({ center: feature.geometry.coordinates, zoom });
  });
  map.on('click', 'sighting-points', (e) => {
    const feature = e.features[0];
    new maplibregl.Popup({ maxWidth: '320px' })
      .setLngLat(feature.geometry.coordinates)
      .setHTML(popupHtml(feature.properties))
      .addTo(map);
  });
  for (const layer of ['clusters', 'sighting-points']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }
}

function applyData() {
  map?.getSource('sightings')?.setData({
    type: 'FeatureCollection',
    features: visibleFeatures.value
  });
}

watch(visibleFeatures, applyData);

onMounted(async () => {
  const [style, result] = await Promise.all([buildBasemapStyle(), fetchSightings()]);

  dataSource.value = result.source;
  allFeatures.value = result.data.features;

  // Default date range: span of the loaded data (= most recent newsletter's
  // range once the API is live).
  const dates = allFeatures.value.map((f) => f.properties.sighting_date).sort();
  if (dates.length) {
    filters.from = dates[0];
    filters.to = dates[dates.length - 1];
  }

  map = new maplibregl.Map({
    container: mapContainer.value,
    style,
    center: SALISH_SEA_CENTER,
    zoom: DEFAULT_ZOOM
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.on('error', (e) => console.error('[orcapelago] map error:', e.error?.message ?? e.error));
  if (import.meta.env.DEV) window.__map = map;
  map.on('load', () => {
    addSightingLayers();
    applyData();
  });
});

onUnmounted(() => map?.remove());
</script>
