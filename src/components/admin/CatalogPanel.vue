<template>
  <section>
    <h2>Pending candidates ({{ candidates.length }})</h2>
    <p class="admin-hint">
      AI-suggested locations from ingests, ordered by how often the raw text repeats.
      Promoting adds a gazetteer entry and backfills every flagged sighting with that exact text.
    </p>
    <table class="admin-table">
      <thead><tr><th>Seen</th><th>Raw text</th><th>Name</th><th>Lat</th><th>Lng</th><th>Conf.</th><th></th></tr></thead>
      <tbody>
        <tr v-for="c in candidates" :key="c.id">
          <td>{{ c.hit_count }}×</td>
          <td class="raw" :title="c.ai_reasoning ?? ''">{{ c.location_raw }}</td>
          <td><input v-model="c.edit_name" /></td>
          <td><input v-model.number="c.edit_lat" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model.number="c.edit_lng" type="number" step="0.0001" class="coord" /></td>
          <td>{{ c.ai_confidence ?? '—' }}</td>
          <td class="row-actions">
            <button @click="promote(c)" :disabled="!c.edit_name?.trim()">Promote</button>
            <button class="danger" @click="reject(c)">Reject</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!candidates.length">No pending candidates.</p>

    <h2>Gazetteer ({{ gazetteer.length }})</h2>
    <table class="admin-table">
      <thead><tr><th>Name</th><th>Aliases</th><th>Lat</th><th>Lng</th><th>Region</th><th>Source</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td><input v-model="draft.name" placeholder="New entry…" /></td>
          <td><input v-model="draft.aliases" placeholder="comma,separated" /></td>
          <td><input v-model.number="draft.lat" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model.number="draft.lng" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model="draft.region" /></td>
          <td>manual</td>
          <td class="row-actions"><button @click="create" :disabled="!draft.name.trim()">Add</button></td>
        </tr>
        <tr v-for="g in gazetteer" :key="g.id">
          <td><input v-model="g.name" /></td>
          <td><input :value="g.aliases.join(', ')" @input="g.aliases = splitCsv($event.target.value)" /></td>
          <td><input v-model.number="g.lat" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model.number="g.lng" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model="g.region" /></td>
          <td>{{ g.source }}</td>
          <td class="row-actions">
            <button @click="update(g)">Save</button>
            <button class="danger" @click="remove(g)">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="statusMsg" class="review-msg">{{ statusMsg }}</p>
  </section>
</template>

<script setup>
// Catalog editor (spec §8.4): gazetteer CRUD + candidate promotion queue.
import { onMounted, reactive, ref } from 'vue';
import { api } from '../../api/client.js';

const candidates = ref([]);
const gazetteer = ref([]);
const statusMsg = ref('');
const draft = reactive({ name: '', aliases: '', lat: null, lng: null, region: '' });

const splitCsv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

async function load() {
  const [c, g] = await Promise.all([
    api('/geocode-candidates', { admin: true }),
    api('/gazetteer')
  ]);
  candidates.value = c.candidates.map((x) => ({
    ...x,
    edit_name: x.suggested_name ?? '',
    edit_lat: x.lat,
    edit_lng: x.lng
  }));
  gazetteer.value = g.gazetteer;
}

async function promote(c) {
  try {
    const res = await api(`/geocode-candidates/${c.id}/promote`, {
      method: 'POST',
      admin: true,
      body: { name: c.edit_name.trim(), lat: c.edit_lat, lng: c.edit_lng }
    });
    statusMsg.value = `Promoted "${res.entry.name}" — backfilled ${res.backfilled} sighting(s).`;
    await load();
  } catch (err) {
    statusMsg.value = `Promote failed: ${err.message}`;
  }
}

async function reject(c) {
  await api(`/geocode-candidates/${c.id}/reject`, { method: 'POST', admin: true });
  await load();
}

async function create() {
  try {
    await api('/gazetteer', {
      method: 'POST',
      admin: true,
      body: {
        name: draft.name.trim(),
        aliases: splitCsv(draft.aliases),
        lat: draft.lat,
        lng: draft.lng,
        region: draft.region.trim() || null
      }
    });
    Object.assign(draft, { name: '', aliases: '', lat: null, lng: null, region: '' });
    statusMsg.value = 'Added.';
    await load();
  } catch (err) {
    statusMsg.value = `Add failed: ${err.message}`;
  }
}

async function update(g) {
  try {
    await api(`/gazetteer/${g.id}`, {
      method: 'PATCH',
      admin: true,
      body: { name: g.name, aliases: g.aliases, lat: g.lat, lng: g.lng, region: g.region }
    });
    statusMsg.value = `Saved "${g.name}".`;
  } catch (err) {
    statusMsg.value = `Save failed: ${err.message}`;
  }
}

async function remove(g) {
  if (!window.confirm(`Delete "${g.name}" from the catalog? Sightings keep their coordinates but lose the link.`)) return;
  await api(`/gazetteer/${g.id}`, { method: 'DELETE', admin: true });
  await load();
}

onMounted(load);
</script>
