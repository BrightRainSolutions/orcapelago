<template>
  <!--
    Sightings table view (spec §8.2, public): filterable table over the same
    /api/sightings data the map uses; each row links to its map location.
  -->
  <main class="page sightings">
    <h1>Sightings</h1>

    <div class="sightings-layout">
      <aside class="sightings-filters">
        <FilterPanel
          v-model:from="filters.from"
          v-model:to="filters.to"
          v-model:species="filters.species"
        />
        <p class="sightings-count">
          {{ visible.length }} of {{ rows.length }} sighting{{ rows.length === 1 ? '' : 's' }}
          <span v-if="dataSource === 'fake'" class="demo-badge">demo data</span>
        </p>
      </aside>

      <div class="sightings-table-wrap">
        <p v-if="loading">Loading…</p>
        <p v-else-if="!rows.length">No sightings yet.</p>
        <p v-else-if="!visible.length">No sightings match these filters.</p>
        <table v-else class="sightings-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Species</th>
              <th>Pod / group</th>
              <th>Location</th>
              <th>Notes</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in visible"
              :key="s.id"
              class="sighting-row"
              tabindex="0"
              :title="s.summary ?? 'Show on map'"
              @click="showOnMap(s)"
              @keyup.enter="showOnMap(s)"
            >
              <td class="st-when">
                {{ s.sighting_date }}<span v-if="s.sighting_time"> · {{ s.sighting_time.slice(0, 5) }}</span>
              </td>
              <td>
                <span class="fp-dot" :style="{ background: speciesColor(s.species) }"></span>
                {{ speciesLabel(s.species) }}
              </td>
              <td>{{ s.pod_or_group ?? '—' }}</td>
              <td class="st-where">{{ s.location_raw }}</td>
              <td class="st-notes">{{ notes(s) || '—' }}</td>
              <td><span :class="['sp-badge', `sp-badge-${s.geo_method}`]">{{ s.geo_method }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>
</template>

<script setup>
// Reads the same GeoJSON the map does (fetchSightings), so the table and map
// can never disagree. Unresolved sightings have no coordinates and are absent
// from that payload by design — every row here is therefore mappable, which is
// what makes the row → map jump always work.
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { SPECIES } from '../map/species.js';
import { fetchSightings } from '../api/sightings.js';
import FilterPanel from '../components/FilterPanel.vue';

const router = useRouter();
const loading = ref(true);
const dataSource = ref('api');
const features = ref([]);
const filters = reactive({
  from: '',
  to: '',
  species: Object.keys(SPECIES)
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

const speciesLabel = (key) => SPECIES[key]?.label ?? key;
const speciesColor = (key) => SPECIES[key]?.color ?? SPECIES.other.color;

function notes(s) {
  return [s.direction, ...(s.behaviors ?? [])].filter(Boolean).join(', ');
}

function showOnMap(s) {
  router.push({ path: '/', query: { sighting: s.id } });
}

onMounted(async () => {
  const result = await fetchSightings();
  dataSource.value = result.source;
  features.value = result.data.features;

  const dates = rows.value.map((s) => s.sighting_date).sort();
  if (dates.length) {
    filters.from = dates[0];
    filters.to = dates[dates.length - 1];
  }
  loading.value = false;
});
</script>
