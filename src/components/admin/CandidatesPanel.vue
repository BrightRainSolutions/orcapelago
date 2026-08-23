<template>
  <!--
    The stage-3 fallback log: every location string the AI had to guess at
    because it got past the gazetteer and past GNIS. Promoting one moves that
    knowledge up to stage 2, where it resolves free from then on.

    NOT gazetteer rows. Promote copies into `gazetteer` and marks this row
    'promoted'; the two tables stay separate, which is why they are now
    separate tabs.
  -->
  <section>
    <h2>Candidates ({{ candidates.length }})</h2>
    <p class="admin-hint">
      Locations the AI had to estimate, most-repeated first. Promoting adds a
      gazetteer entry and backfills every flagged sighting with that exact text.
      Check the coordinate first — the model's guesses vary a lot between
      near-identical wordings.
    </p>

    <table class="admin-table">
      <thead>
        <tr>
          <th>Seen</th><th>Raw text</th><th>Name</th>
          <th>Lat</th><th>Lng</th><th>Conf.</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in candidates" :key="c.id">
          <td>{{ c.hit_count }}×</td>
          <td class="raw">
            {{ c.location_raw }}
            <!-- The model's own reasoning: the single most useful thing when
                 deciding whether to trust a coordinate. Collapsed because the
                 row is tight. -->
            <details v-if="c.ai_reasoning" class="cand-why">
              <summary>why here?</summary>
              <p>{{ c.ai_reasoning }}</p>
            </details>
          </td>
          <td><input v-model="c.edit_name" /></td>
          <td><input v-model.number="c.edit_lat" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model.number="c.edit_lng" type="number" step="0.0001" class="coord" /></td>
          <td>{{ c.ai_confidence ?? '—' }}</td>
          <td class="row-actions">
            <router-link
              v-if="c.sample_sighting_id"
              class="cand-map"
              :to="{ path: '/admin', query: { tab: 'review', sighting: c.sample_sighting_id } }"
            >Map</router-link>
            <button @click="promote(c)" :disabled="!c.edit_name?.trim()">Promote</button>
            <button class="danger" @click="reject(c)">Reject</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!candidates.length">No pending candidates.</p>
    <p v-if="statusMsg" class="review-msg">{{ statusMsg }}</p>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../../api/client.js';

const candidates = ref([]);
const statusMsg = ref('');

async function load() {
  const c = await api('/geocode-candidates', { admin: true });
  candidates.value = c.candidates.map((x) => ({
    ...x,
    edit_name: x.suggested_name ?? '',
    edit_lat: x.lat,
    edit_lng: x.lng
  }));
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

onMounted(load);
</script>
