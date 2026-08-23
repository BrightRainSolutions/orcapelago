<template>
  <main class="map-view">
    <div ref="mapContainer" class="map-container"></div>
    <FilterPanel
      v-model:from="filters.from"
      v-model:to="filters.to"
      v-model:species="filters.species"
      :heading="heading"
      :subheading="subheading"
      :full-range="rangeText(archive.from, archive.to)"
      :loading="loading"
      @reset="showAllDates"
    >
      <!--
        The table is the accessible route to this data: a canvas map exposes
        nothing to a screen reader. Reached from here rather than the top nav
        so it reads as an alternative view of the map, not a separate section.
      -->
      <template #footer>
        <router-link to="/sightings" class="fp-table-link">View as table</router-link>
      </template>
    </FilterPanel>
    <SightingPanel :sighting="selected" @close="selected = null" />
    <!-- Only appears when there is something to say — no idle counter. -->
    <div v-if="statusNote || dataSource === 'fake'" class="map-status">
      <span v-if="statusNote" class="map-status-note">{{ statusNote }}</span>
      <span v-if="dataSource === 'fake'" class="demo-badge">demo data</span>
    </div>
  </main>
</template>

<script setup>
// Map view (spec §8.1): full-bleed MapLibre map, sightings as a clustered
// GeoJSON source colored by species, popups, date/species filters.
import { onMounted, onUnmounted, reactive, ref, computed, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import maplibregl from 'maplibre-gl';
import { buildBasemapStyle, SALISH_SEA_CENTER, DEFAULT_ZOOM } from '../map/basemap.js';
import { SPECIES, ORCA_KEYS, CLUSTER_COLOR, speciesExpr } from '../map/species.js';
import { HYDROPHONES, hydrophoneElement } from '../map/hydrophones.js';
import { WEBCAMS, webcamElement } from '../map/webcams.js';
import { fetchLandmarks } from '../api/landmarks.js';
import { addLandmarkLayers } from '../map/landmark-layers.js';
import { fetchSightings } from '../api/sightings.js';
import { rangeText } from '../format.js';
import FilterPanel from '../components/FilterPanel.vue';
import SightingPanel from '../components/SightingPanel.vue';

const props = defineProps({
  // True while a full-page route (admin) covers the map. The map stays mounted
  // so returning is instant; it just needs a resize once it is visible again,
  // because MapLibre measures a display:none container as zero.
  hidden: { type: Boolean, default: false }
});

const route = useRoute();
const mapContainer = ref(null);
const dataSource = ref('api');
const allFeatures = ref([]);
const loading = ref(false);
const selected = ref(null);   // sighting shown in the detail panel
const archive = reactive({ from: '', to: '' });            // span of ALL sightings
const latest = reactive({ from: '', to: '', title: '' });  // newsletter loaded at launch
const filters = reactive({
  from: '',
  to: '',
  // Orcas only on load — the app is called Orcapelago. Everything else lives
  // behind the collapsed "Other Species" disclosure, unchecked.
  species: [...ORCA_KEYS]
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

/**
 * Scope labels. On launch the app loads one newsletter, so say which; once the
 * dates move off that window it is no longer "latest" and the heading drops
 * back to a plain range.
 */
const onLatest = computed(
  () => Boolean(latest.title) && filters.from === latest.from && filters.to === latest.to
);
const heading = computed(() => (onLatest.value ? 'Latest Sightings' : 'Sightings'));
// Nothing to add on the default view; the date range only earns space once the
// reader has moved off it.
const subheading = computed(() => (onLatest.value ? '' : rangeText(filters.from, filters.to)));

/** Shown when a filter hides everything — a bare "0" reads as a broken app. */
const statusNote = computed(() => {
  if (!allFeatures.value.length || visibleCount.value) return '';
  return archive.from ? `data covers ${rangeText(archive.from, archive.to)}` : '';
});

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/** Selection holds feature properties; the icon layer needs the geometry. */
const selectedFeature = computed(() =>
  selected.value
    ? allFeatures.value.find((f) => f.properties.id === selected.value.id) ?? null
    : null
);

watch(selectedFeature, (feature) => {
  map?.getSource('selected-sighting')?.setData(
    feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY_FC
  );
  // Hide the plain circle underneath so the orca replaces it rather than
  // sitting on top of it.
  if (map?.getLayer('sighting-points')) {
    map.setFilter('sighting-points', [
      'all',
      ['!', ['has', 'point_count']],
      ['!=', ['get', 'id'], feature?.properties.id ?? '']
    ]);
  }
});

function showAllDates() {
  filters.from = archive.from;
  filters.to = archive.to;
}

// Fill and ring both come from SPECIES, so a marker and its legend swatch
// can never disagree.
const fillExpr = speciesExpr('color', SPECIES.other.color);
const ringExpr = speciesExpr('ring', SPECIES.other.ring);

/**
 * The selected sighting, rendered as a spyhopping orca.
 *
 * The detail panel is fixed to a corner, so unlike the popup it replaced there
 * is nothing tying it to a spot on the water. This is that tie.
 *
 * Its own source, deliberately, rather than a filter on the sightings layer:
 * that source clusters, so a selected sighting inside a cluster would not
 * render at all. An unclustered source always shows it — which is exactly when
 * the marker is most useful.
 *
 * allow-overlap/ignore-placement because this one must never lose a collision
 * to a landmark label.
 */
async function addSelectedLayer() {
  try {
    const img = await map.loadImage('/orca-spy.png');
    if (!map.hasImage('orca-spy')) map.addImage('orca-spy', img.data);
  } catch (err) {
    console.warn('[orcapelago] orca-spy icon unavailable:', err.message);
    return;
  }
  map.addSource('selected-sighting', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'selected-sighting',
    type: 'symbol',
    source: 'selected-sighting',
    layout: {
      'icon-image': 'orca-spy',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.26, 13, 0.4],
      // 'center', not 'bottom': bottom puts the whole 100px image above the
      // coordinate, so the orca floated well north of the sighting it marks.
      'icon-anchor': 'center',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true
    }
  });
}

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
      'circle-color': CLUSTER_COLOR,
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
      'circle-color': fillExpr,
      'circle-radius': 6,
      // Hollow species (white fill) need a dark ring to be visible at all;
      // filled ones need a light one to separate from the bathymetry greys.
      'circle-stroke-width': 1.5,
      'circle-stroke-color': ringExpr
    }
  });

  map.on('click', 'clusters', async (e) => {
    const feature = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
    const zoom = await map.getSource('sightings').getClusterExpansionZoom(feature.properties.cluster_id);
    map.easeTo({ center: feature.geometry.coordinates, zoom });
  });
  map.on('click', 'sighting-points', (e) => {
    selected.value = e.features[0].properties;
  });
  // Clicking bare map dismisses the panel. Layer handlers run first, so this
  // has to re-query rather than clear unconditionally — otherwise selecting a
  // sighting and immediately deselecting it would be the same click.
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, {
      layers: ['sighting-points', 'clusters']
    });
    if (!hits.length) selected.value = null;
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

/**
 * Deep link from the sightings table (/?sighting=<id>).
 *
 * Split deliberately: selecting the sighting only needs the data, so it runs
 * as soon as features load. Only the camera move needs the map, so that waits
 * for 'load'. Previously both sat inside the load handler, which meant a slow
 * or failed basemap silently produced a blank page for a shared link.
 */
function querySighting() {
  const id = route.query.sighting;
  return id ? allFeatures.value.find((f) => f.properties.id === id) : undefined;
}

/** Centre on the deep-linked sighting. Zooms past clusterMaxZoom (13) so the
 *  point renders on its own rather than hidden inside a cluster. */
function focusQuerySighting() {
  const feature = querySighting();
  if (feature) map.easeTo({ center: feature.geometry.coordinates, zoom: 14 });
}

/**
 * Fetch and swap the working set. Date changes re-query the API rather than
 * filtering an archive the client no longer holds — the launch payload is one
 * newsletter, not everything.
 */
async function load(params) {
  loading.value = true;
  try {
    const result = await fetchSightings(params);
    dataSource.value = result.source;
    allFeatures.value = result.data.features;
    if (result.data.range?.from) Object.assign(archive, result.data.range);
    return result;
  } finally {
    loading.value = false;
  }
}

// Debounced because <input type="date"> fires on every spinner click and
// keystroke — undebounced this would issue a query per digit typed. Species
// deliberately stays client-side: instant on a few hundred rows, and a round
// trip per checkbox would feel worse than it does now.
let ready = false;
let dateTimer;
watch(
  () => [filters.from, filters.to],
  () => {
    if (!ready) return;
    clearTimeout(dateTimer);
    dateTimer = setTimeout(() => load({ from: filters.from, to: filters.to }), 350);
  }
);

onMounted(async () => {
  const [style, result, landmarks] = await Promise.all([
    buildBasemapStyle(),
    load({ newsletter: 'latest' }),
    fetchLandmarks()
  ]);

  // Launch scope is the newsletter itself (spec §8.1). Demo mode has no
  // newsletter, so fall back to the span of whatever loaded.
  const nl = result.data.newsletter;
  if (nl?.date_from) {
    Object.assign(latest, { from: nl.date_from, to: nl.date_to, title: nl.title ?? '' });
    filters.from = nl.date_from;
    filters.to = nl.date_to;
  } else {
    const dates = allFeatures.value.map((f) => f.properties.sighting_date).sort();
    filters.from = dates[0] ?? '';
    filters.to = dates[dates.length - 1] ?? '';
    if (!archive.from) Object.assign(archive, { from: filters.from, to: filters.to });
  }
  // Arm the watcher only after the pending flush. Watchers are post-flush, so
  // setting this synchronously would NOT stop the mount-time assignments above
  // from triggering a date re-query — which silently widens the view from this
  // newsletter's 362 sightings to every sighting in its date window.
  await nextTick();
  ready = true;

  // Panel first — it needs only the data, not the basemap.
  selected.value = querySighting()?.properties ?? null;

  map = new maplibregl.Map({
    container: mapContainer.value,
    style,
    center: SALISH_SEA_CENTER,
    zoom: DEFAULT_ZOOM,
    // The basemap, tiles and bathymetry attribute themselves through their
    // TileJSON. The two sources that are actually ours to credit do not:
    // every sighting on this map is Orca Network's reporting, and the
    // hydrophone positions are Orcasound's. Spec §1 treats crediting the
    // source as non-negotiable — this is the map's share of that; the fuller
    // credit and donate link belong on the About page.
    attributionControl: {
      customAttribution: [
        'Sightings © <a href="https://www.orcanetwork.org/" target="_blank" rel="noopener">Orca Network</a>',
        'Hydrophones © <a href="https://www.orcasound.net/" target="_blank" rel="noopener">Orcasound</a>',
        'Webcam © <a href="https://whalemuseum.org/" target="_blank" rel="noopener">The Whale Museum</a> & SMRU Consulting'
      ]
    }
  });
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  // Hydrophones are fixed context, not data: eight HTML markers rather than a
  // layer, so they need no sprite and no clustering, and take ordinary CSS.
  for (const h of HYDROPHONES) {
    new maplibregl.Marker({ element: hydrophoneElement(h.name) })
      .setLngLat([h.lng, h.lat])
      .addTo(map);
  }
  // Cameras, same treatment. The marker is the camera; a sighting seen on one
  // is placed offshore in its view, not here (see webcams.js).
  for (const w of WEBCAMS) {
    new maplibregl.Marker({ element: webcamElement(w) })
      .setLngLat([w.lng, w.lat])
      .addTo(map);
  }
  map.on('error', (e) => console.error('[orcapelago] map error:', e.error?.message ?? e.error));
  if (import.meta.env.DEV) window.__map = map;
  map.on('load', () => {
    // Order is z-order: landmarks first so sighting markers always sit above.
    addLandmarkLayers(map, landmarks);
    addSightingLayers();
    addSelectedLayer();   // after, so the orca draws above the circles
    applyData();
    focusQuerySighting();
  });
});

watch(
  () => props.hidden,
  async (isHidden) => {
    if (isHidden) return;
    await nextTick();
    map?.resize();
  }
);

// The sightings table links back here with ?sighting=<id>. Watched rather than
// read once on mount, because with the map persistent that navigation no
// longer remounts this component. Absence is ignored on purpose: closing a
// modal drops the query, and that should not clear the open panel.
watch(
  () => route.query.sighting,
  (id) => {
    if (!id) return;
    const feature = querySighting();
    if (!feature) return;
    selected.value = feature.properties;
    map?.easeTo({ center: feature.geometry.coordinates, zoom: 14 });
  }
);

onUnmounted(() => {
  clearTimeout(dateTimer);
  map?.remove();
});
</script>
