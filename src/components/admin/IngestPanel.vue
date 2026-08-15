<template>
  <section>
    <h2>Paste a newsletter</h2>
    <input v-model="title" class="ingest-title" placeholder="Title (optional — derived from the text if blank)" />
    <textarea
      v-model="text"
      class="ingest-text"
      placeholder="Paste the full Orca Network whale sighting report here…"
      rows="12"
    ></textarea>
    <div class="ingest-actions">
      <button :disabled="!text.trim() || polling" @click="submit">Ingest</button>
      <span v-if="polling" class="ingest-status">🐋 Thar she blows… ({{ elapsed }}s)</span>
      <span v-else-if="lastResult" :class="['ingest-status', lastResult.ok ? 'ok' : 'err']">{{ lastResult.msg }}</span>
    </div>

    <h2>Newsletters</h2>
    <table class="admin-table">
      <thead><tr><th>Title</th><th>Range</th><th>Status</th><th>Sightings</th><th>Notes</th></tr></thead>
      <tbody>
        <tr v-for="n in newsletters" :key="n.id">
          <td>{{ n.title ?? '(untitled)' }}</td>
          <td>{{ n.date_from }} → {{ n.date_to }}</td>
          <td><span :class="`status-${n.status}`">{{ n.status }}</span></td>
          <td>{{ n.sighting_count ?? '—' }}</td>
          <td class="notes">{{ n.error_message ?? '' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup>
// Paste → POST /api/ingest (client-generated UUID, since background functions
// discard response bodies) → poll /api/ingest-status until complete/failed.
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../../api/client.js';

const title = ref('');
const text = ref('');
const polling = ref(false);
const elapsed = ref(0);
const lastResult = ref(null);
const newsletters = ref([]);
let timer = null;

async function loadNewsletters() {
  try {
    newsletters.value = (await api('/newsletters')).newsletters;
  } catch { /* table stays as-is */ }
}

async function submit() {
  const id = crypto.randomUUID();
  lastResult.value = null;
  polling.value = true;
  elapsed.value = 0;
  try {
    await api('/ingest', {
      method: 'POST',
      admin: true,
      body: { id, text: text.value, title: title.value.trim() || undefined }
    });
  } catch (err) {
    // Production returns a bodyless 202 before work starts; only a non-2xx
    // before the background hand-off is a real submit failure.
    if (err.status && err.status !== 202) {
      polling.value = false;
      lastResult.value = { ok: false, msg: `Submit failed: ${err.message}` };
      return;
    }
  }
  timer = setInterval(async () => {
    elapsed.value += 5;
    try {
      const s = await api(`/ingest-status?id=${id}`, { admin: true });
      if (s.status === 'complete') {
        finish({ ok: true, msg: `Complete: ${s.sighting_count} sightings.${s.error_message ? ` ${s.error_message}` : ''}` });
      } else if (s.status === 'failed') {
        finish({ ok: false, msg: `Failed: ${s.error_message}` });
      }
    } catch { /* 404 = still starting; keep polling */ }
  }, 5000);
}

function finish(result) {
  clearInterval(timer);
  timer = null;
  polling.value = false;
  lastResult.value = result;
  if (result.ok) text.value = '';
  loadNewsletters();
}

onMounted(loadNewsletters);
onUnmounted(() => timer && clearInterval(timer));
</script>
