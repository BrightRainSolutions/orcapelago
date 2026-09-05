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
    <p class="admin-hint">
      <strong>An entry records where the PLACE is, not where an animal was.</strong>
      Put the pin on the dock itself, not offshore of it — these coordinates are
      handed to the model as authoritative anchors, so a pin 300 yards out
      teaches it a wrong origin for every future report naming that place.
    </p>

    <!--
      Placement is by map, never by typing. The lat/lng inputs remain, because
      reading back an exact coordinate is useful and pasting a known one is
      occasionally the fastest route, but the map is the tool: "Place" binds a
      row to it, clicking or dragging sets that row's coordinates, and nothing
      is written until Save.
    -->
    <div v-if="placing" class="gaz-placer">
      <div class="gaz-placer-head">
        <strong>Placing: {{ placingLabel }}</strong>
        <span class="admin-hint">Click the map or drag the pin. Save the row to keep it.</span>
        <button class="sp-close" aria-label="Close" @click="placing = null">×</button>
      </div>
      <MiniMap :lat="placing.lat ?? undefined" :lng="placing.lng ?? undefined" @place="onPlace" />
    </div>

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
          <td class="row-actions">
            <button :class="{ active: placing === draft }" @click="placing = draft">Place</button>
            <button @click="create" :disabled="!draft.name.trim() || !placed(draft)">Add</button>
          </td>
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
            <button :class="{ active: placing === g }" @click="placing = g">Place</button>
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
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../../api/client.js';
import MiniMap from './MiniMap.vue';

const gazetteer = ref([]);
const statusMsg = ref('');
const draft = reactive({ name: '', aliases: '', lat: null, lng: null, region: '' });

/**
 * The row currently bound to the map — the draft, or an existing entry.
 *
 * Identity comparison, not an id, so the unsaved draft (which has no id) can be
 * placed the same way an existing row is.
 */
const placing = ref(null);
const placingLabel = computed(() =>
  placing.value === draft ? (draft.name.trim() || 'new entry') : (placing.value?.name ?? ''));
const placed = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lng);

/** Map click or pin drag writes straight onto the row being placed. */
function onPlace({ lat, lng }) {
  if (!placing.value) return;
  placing.value.lat = Number(lat.toFixed(5));
  placing.value.lng = Number(lng.toFixed(5));
}

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
    placing.value = null;
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
  if (placing.value === g) placing.value = null;
  await load();
}

onMounted(load);
</script>
