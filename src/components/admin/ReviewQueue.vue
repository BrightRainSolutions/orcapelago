<template>
  <section class="review">
    <div class="review-list">
      <h2>Needs review ({{ rows.length }})</h2>
      <button
        v-for="s in rows"
        :key="s.id"
        :class="['review-item', { active: selected?.id === s.id }]"
        @click="select(s)"
      >
        <span class="ri-loc">{{ s.location_raw }}</span>
        <span class="ri-meta">{{ s.sighting_date }} · {{ s.species }} · {{ s.geo_method }}</span>
      </button>
      <p v-if="!rows.length">Queue is clear. 🎉</p>
    </div>

    <div v-if="selected" class="review-editor">
      <h2>Edit sighting</h2>
      <blockquote class="review-excerpt">{{ selected.raw_excerpt ?? '(no excerpt)' }}</blockquote>
      <div class="review-fields">
        <label>Species
          <select v-model="form.species">
            <option v-for="(def, key) in SPECIES" :key="key" :value="key">{{ def.label }}</option>
          </select>
        </label>
        <label>Date <input v-model="form.sighting_date" type="date" /></label>
        <label>Time <input v-model="form.sighting_time" type="time" /></label>
        <label>Pod/group <input v-model="form.pod_or_group" /></label>
        <label>Lat <input v-model.number="form.lat" type="number" step="0.0001" /></label>
        <label>Lng <input v-model.number="form.lng" type="number" step="0.0001" /></label>
      </div>
      <p class="review-hint">Click the map to place the sighting (sets geo method to manual).</p>
      <MiniMap :lat="form.lat" :lng="form.lng" @place="onPlace" />
      <div class="review-actions">
        <button :disabled="saving" @click="save(false)">Save & clear flag</button>
        <span class="review-catalog">
          <input v-model="catalogName" placeholder="Catalog name (e.g. Browns Point)" />
          <button :disabled="saving || !catalogName.trim() || !Number.isFinite(form.lat)" @click="save(true)">
            Save + add to catalog
          </button>
        </span>
        <span v-if="message" class="review-msg">{{ message }}</span>
      </div>
    </div>
  </section>
</template>

<script setup>
// Review queue (spec §8.4): flagged sightings with raw_excerpt beside
// editable fields; mini-map click-placement; optional promote-to-catalog.
import { onMounted, reactive, ref } from 'vue';
import { api } from '../../api/client.js';
import { SPECIES } from '../../map/species.js';
import MiniMap from './MiniMap.vue';

const rows = ref([]);
const selected = ref(null);
const form = reactive({});
const catalogName = ref('');
const message = ref('');
const saving = ref(false);
let coordsDirty = false;

async function load() {
  const data = await api('/sightings?needs_review=true&format=json&limit=500');
  rows.value = data.sightings;
}

function select(s) {
  selected.value = s;
  coordsDirty = false;
  message.value = '';
  catalogName.value = '';
  Object.assign(form, {
    species: s.species,
    sighting_date: s.sighting_date,
    sighting_time: s.sighting_time?.slice(0, 5) ?? '',
    pod_or_group: s.pod_or_group ?? '',
    lat: s.lat,
    lng: s.lng
  });
}

function onPlace({ lat, lng }) {
  form.lat = +lat.toFixed(6);
  form.lng = +lng.toFixed(6);
  coordsDirty = true;
}

async function save(addToCatalog) {
  saving.value = true;
  message.value = '';
  try {
    const patch = {
      species: form.species,
      sighting_date: form.sighting_date,
      sighting_time: form.sighting_time || null,
      pod_or_group: form.pod_or_group || null,
      lat: Number.isFinite(form.lat) ? form.lat : null,
      lng: Number.isFinite(form.lng) ? form.lng : null,
      needs_review: false
    };
    if (coordsDirty) patch.geo_method = 'manual';
    if (addToCatalog) {
      const { entry } = await api('/gazetteer', {
        method: 'POST',
        admin: true,
        body: { name: catalogName.value.trim(), lat: form.lat, lng: form.lng }
      });
      patch.gazetteer_id = entry.id;
      patch.geo_method = 'catalog';
    }
    await api(`/sightings/${selected.value.id}`, { method: 'PATCH', admin: true, body: patch });
    message.value = 'Saved.';
    selected.value = null;
    await load();
  } catch (err) {
    message.value = `Save failed: ${err.message}`;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
