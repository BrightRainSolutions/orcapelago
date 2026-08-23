<template>
  <!--
    Sightings table (spec §8.2, public).

    This exists primarily as the accessible route to the data. The map is a
    canvas element: to a screen reader it is one opaque node containing
    nothing, and clicking a cluster needs a pointer on a specific pixel.
    Without this view the dataset is unreachable for anyone not using a mouse
    and their eyes. It is also the only place the reporters' own summaries are
    readable without hunting for the right dot.

    Rows expand in place rather than jumping to the map: this opens as a modal
    over the map, so a jump would close what you are reading and lose your
    position. "Show on map" stays available per row as a deliberate choice.
  -->
  <main class="page sightings">
    <h1>Sightings</h1>

    <div class="sightings-layout">
      <aside class="sightings-filters">
        <FilterPanel
          v-model:from="filters.from"
          v-model:to="filters.to"
          v-model:species="filters.species"
          :heading="heading"
          :subheading="subheading"
          :full-range="rangeText(archive.from, archive.to)"
          :loading="loading"
          @reset="showAllDates"
        />
        <p v-if="dataSource === 'fake'" class="sightings-count">
          <span class="demo-badge">demo data</span>
        </p>
        <p v-if="statusNote" class="sightings-note">{{ statusNote }}</p>
      </aside>

      <div class="sightings-table-wrap">
        <p v-if="loading">Loading…</p>
        <p v-else-if="!rows.length">No sightings yet.</p>
        <p v-else-if="!visible.length">No sightings match these filters.</p>
        <table v-else class="sightings-table">
          <caption class="sr-only">Whale sightings. Activate a row to read the full report.</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Species</th>
              <th scope="col">Pod / group</th>
              <th scope="col">Location</th>
              <th scope="col">Notes</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="s in visible" :key="s.id">
              <tr class="sighting-row" :class="{ open: open === s.id }" @click="toggle(s.id)">
                <td class="st-when">
                  <button
                    type="button"
                    class="st-toggle"
                    :aria-expanded="open === s.id"
                    :aria-controls="'detail-' + s.id"
                    @click.stop="toggle(s.id)"
                  >
                    <span class="sr-only">Show details for the sighting on </span>
                    {{ s.sighting_date }}<span v-if="s.sighting_time"> · {{ s.sighting_time.slice(0, 5) }}</span>
                  </button>
                </td>
                <td>
                  <span class="fp-dot" :style="swatch(s.species)"></span>
                  {{ speciesLabel(s.species) }}
                </td>
                <td>{{ s.pod_or_group ?? '—' }}</td>
                <td class="st-where">{{ s.location_raw }}</td>
                <td class="st-notes">{{ notes(s) || '—' }}</td>
                <td><span :class="['sp-badge', 'sp-badge-' + s.geo_method]">{{ s.geo_method }}</span></td>
              </tr>
              <tr v-if="open === s.id" :id="'detail-' + s.id" class="sighting-detail">
                <td colspan="6">
                  <p v-if="s.summary" class="sd-summary">{{ s.summary }}</p>
                  <dl class="sd-facts">
                    <template v-if="idList(s)">
                      <dt>Individuals</dt><dd>{{ idList(s) }}</dd>
                    </template>
                    <template v-if="s.count">
                      <dt>Count</dt><dd>{{ s.count }}</dd>
                    </template>
                    <dt>Reported by</dt><dd>{{ s.reporter || 'Not recorded' }}</dd>
                    <dt>Position</dt>
                    <dd>{{ s.lat.toFixed(4) }}, {{ s.lng.toFixed(4) }} ({{ s.geo_method }})</dd>
                  </dl>
                  <button type="button" class="sd-map" @click.stop="showOnMap(s)">Show on map</button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { SPECIES, ORCA_KEYS } from '../map/species.js';
import { fetchSightings } from '../api/sightings.js';
import { rangeText } from '../format.js';
import FilterPanel from '../components/FilterPanel.vue';

const router = useRouter();
const loading = ref(true);
const dataSource = ref('api');
const features = ref([]);
const open = ref(null);                                    // expanded row id
const archive = reactive({ from: '', to: '' });            // span of ALL sightings
const latest = reactive({ from: '', to: '', title: '' });  // newsletter loaded at launch
const filters = reactive({
  from: '',
  to: '',
  species: [...ORCA_KEYS]   // see MapView: orcas only on load
});

const rows = computed(() =>
  features.value.map((f) => ({
    ...f.properties,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1]
  }))
);

// Same predicate as MapView so both views filter identically.
const visible = computed(() =>
  rows.value.filter((s) => {
    if (filters.from && s.sighting_date < filters.from) return false;
    if (filters.to && s.sighting_date > filters.to) return false;
    return filters.species.includes(s.species);
  })
);

// Mirrors MapView so both views describe their scope identically.
const onLatest = computed(
  () => Boolean(latest.title) && filters.from === latest.from && filters.to === latest.to
);
const heading = computed(() => (onLatest.value ? 'Latest Sightings' : 'Sightings'));
const subheading = computed(() => (onLatest.value ? '' : rangeText(filters.from, filters.to)));

const statusNote = computed(() => {
  if (!rows.value.length || visible.value.length) return '';
  return archive.from ? `data covers ${rangeText(archive.from, archive.to)}` : '';
});

function showAllDates() {
  filters.from = archive.from;
  filters.to = archive.to;
}

async function load(params) {
  loading.value = true;
  try {
    const result = await fetchSightings(params);
    dataSource.value = result.source;
    features.value = result.data.features;
    if (result.data.range?.from) Object.assign(archive, result.data.range);
    return result;
  } finally {
    loading.value = false;
  }
}

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
onUnmounted(() => clearTimeout(dateTimer));

const speciesLabel = (key) => SPECIES[key]?.label ?? key;
const swatch = (key) => {
  const def = SPECIES[key] ?? SPECIES.other;
  return { background: def.color, borderColor: def.ring };
};

// MapLibre JSON-stringifies array properties on rendered features.
function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v); } catch { return []; }
  }
  return v ? [v] : [];
}
const idList = (s) => arr(s.individual_ids).join(', ');
const notes = (s) => [s.direction, ...arr(s.behaviors)].filter(Boolean).join(', ');

/** One row open at a time; clicking the open row closes it. */
function toggle(id) {
  open.value = open.value === id ? null : id;
}

/** Deliberate, per-row action. Closes this modal and selects on the map. */
function showOnMap(s) {
  router.push({ path: '/', query: { sighting: s.id } });
}

onMounted(async () => {
  const result = await load({ newsletter: 'latest' });
  const nl = result.data.newsletter;
  if (nl?.date_from) {
    Object.assign(latest, { from: nl.date_from, to: nl.date_to, title: nl.title ?? '' });
    filters.from = nl.date_from;
    filters.to = nl.date_to;
  } else {
    const dates = rows.value.map((s) => s.sighting_date).sort();
    filters.from = dates[0] ?? '';
    filters.to = dates[dates.length - 1] ?? '';
    if (!archive.from) Object.assign(archive, { from: filters.from, to: filters.to });
  }
  await nextTick();   // see MapView: watchers are post-flush, so arming this
  ready = true;       // synchronously would trigger a spurious date re-query
});
</script>
