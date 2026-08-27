<template>
  <!--
    Your own verified places, checked at ingest stage 2 before
    GNIS landmarks and before the AI. Small on purpose.

    `aliases` is the mechanism that copes with messy reporting: promoting a
    candidate whose raw text differs from the name you type stores that raw
    text here, so the same ugly wording matches exactly next time.
  -->
  <section>
    <h2>Gazetteer ({{ gazetteer.length }})</h2>
    <p class="admin-hint">
      Checked before the GNIS landmarks and before any AI call. Also the place
      to settle a name GNIS holds more than once — Andrews Bay exists in two
      counties, so a gazetteer entry is how you say which one you mean.
    </p>

    <table class="admin-table">
      <thead>
        <tr><th>Name</th><th>Aliases</th><th>Lat</th><th>Lng</th><th>Region</th><th>Source</th><th></th></tr>
      </thead>
      <tbody>
        <tr>
          <td><input v-model="draft.name" placeholder="New entry…" /></td>
          <td><textarea v-model="draft.aliases" class="alias-box" rows="2" placeholder="one per line"></textarea></td>
          <td><input v-model.number="draft.lat" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model.number="draft.lng" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model="draft.region" /></td>
          <td>manual</td>
          <td class="row-actions"><button @click="create" :disabled="!draft.name.trim()">Add</button></td>
        </tr>
        <tr v-for="g in gazetteer" :key="g.id">
          <td><input v-model="g.name" /></td>
          <!--
            One alias per LINE, not comma-separated.

            Aliases are raw reporter phrasings and they frequently contain
            commas — "Alderbrook, Mid channel", "View from Fort Ebey, heading
            to WB [westbound]". Splitting on commas turned one alias into two
            the moment anyone edited the field, and "Mid channel" as an alias
            would then resolve every mid-channel report to Alderbrook with
            needs_review = false. Newlines effectively never appear in the
            source text, and the display now shows honestly how many aliases
            a row has.
          -->
          <td>
            <textarea
              class="alias-box"
              :rows="Math.max(2, g.aliases.length)"
              :value="g.aliases.join(NL)"
              @input="g.aliases = splitLines($event.target.value)"
            ></textarea>
          </td>
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
import { onMounted, reactive, ref } from 'vue';
import { api } from '../../api/client.js';

const gazetteer = ref([]);
const statusMsg = ref('');
const draft = reactive({ name: '', aliases: '', lat: null, lng: null, region: '' });

// Newline-delimited, and deduped: the same phrasing twice is never meaningful.
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
// Split on line breaks without writing an escape sequence anywhere:
// strip carriage returns, then split on the line feed. Backslash handling
// in tooling has silently mangled four patches to this project.
const splitLines = (s) =>
  [...new Set(s.split(CR).join('').split(NL).map((x) => x.trim()).filter(Boolean))];

async function load() {
  gazetteer.value = (await api('/gazetteer')).gazetteer;
}

async function create() {
  try {
    await api('/gazetteer', {
      method: 'POST',
      admin: true,
      body: {
        name: draft.name.trim(),
        aliases: splitLines(draft.aliases),
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
  if (!window.confirm(`Delete "${g.name}" from the gazetteer? Sightings keep their coordinates but lose the link.`)) return;
  await api(`/gazetteer/${g.id}`, { method: 'DELETE', admin: true });
  await load();
}

onMounted(load);
</script>
