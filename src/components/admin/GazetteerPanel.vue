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

    <!--
      Search exists to answer one question before you type a new entry: does
      this place already exist, possibly under a different name? So it matches
      ALIASES as well as names — the aliases are where reporter phrasings live,
      and "Off Harrington Lagoon in Coupeville" is findable by "harrington"
      only if they are searched.
    -->
    <div class="gaz-search">
      <input
        v-model="search"
        type="search"
        placeholder="Search names and aliases…"
        @keydown.esc="search = ''"
      />
      <span class="admin-hint">
        {{ search.trim() ? `${visible.length} of ${gazetteer.length}` : `${gazetteer.length} entries` }}
      </span>
      <button v-if="search.trim()" @click="search = ''">Clear</button>
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
            <!-- create() with parens: @click="create" would pass the MouseEvent as
                 confirmGnis, and a truthy event silently skips the GNIS check. -->
            <button @click="create()" :disabled="!draft.name.trim() || !placed(draft)">Add</button>
          </td>
        </tr>
        <tr v-for="g in visible" :key="g.id">
          <td>
            <input v-model="g.name" />
            <!-- Say WHY it matched when the hit was on an alias, so you do not
                 have to scan a textarea of reporter phrasings to find it. -->
            <p v-if="matchedAlias(g)" class="gaz-match">alias: {{ matchedAlias(g) }}</p>
          </td>
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
            <!--
              Bound to TEXT, not to the alias array.

              It used to bind `:value` to `aliases.join(NL)` and re-split on
              every keystroke. Pressing Enter produced "Alpha\n", splitLines
              dropped the empty trailing line, `:value` recomputed to "Alpha",
              and Vue wrote that back — erasing the newline as you typed it.
              A second alias was literally impossible to enter, and trailing
              spaces and duplicate lines vanished mid-word for the same reason.

              Editing state is text; stored state is an array; the conversion
              happens once, on Save.
            -->
            <textarea
              class="alias-box"
              :rows="Math.max(2, g.aliasText.split(NL).length)"
              v-model="g.aliasText"
            ></textarea>
          </td>
          <td><input v-model.number="g.lat" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model.number="g.lng" type="number" step="0.0001" class="coord" /></td>
          <td><input v-model="g.region" /></td>
          <td>{{ g.source }}</td>
          <!--
            Confirmation belongs ON the row.

            It used to be a single line under the table. With 38 rows, saving
            row 5 rendered "Saved" hundreds of pixels below the fold — the
            write succeeded and looked like nothing had happened.
          -->
          <td class="row-actions">
            <button :class="{ active: placing === g }" @click="placing = g">Place</button>
            <button
              :class="{ saved: rowState[g.id] === 'saved', failed: rowState[g.id] === 'failed' }"
              :disabled="rowState[g.id] === 'saving'"
              @click="update(g)"
            >{{ saveLabel(g) }}</button>
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
const search = ref('');

// Same normalisation the geocoder uses for lookups: case and whitespace only.
const norm = (x) => (x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const visible = computed(() => {
  const q = norm(search.value);
  if (!q) return gazetteer.value;
  return gazetteer.value.filter(
    (g) => norm(g.name).includes(q) || (g.aliases ?? []).some((a) => norm(a).includes(q))
  );
});

/** The alias that matched, when the name did not — shown under the name. */
function matchedAlias(g) {
  const q = norm(search.value);
  if (!q || norm(g.name).includes(q)) return null;
  return (g.aliases ?? []).find((a) => norm(a).includes(q)) ?? null;
}
const draft = reactive({ name: '', aliases: '', lat: null, lng: null, region: '' });

/**
 * The row currently bound to the map — the draft, or an existing entry.
 *
 * Identity comparison, not an id, so the unsaved draft (which has no id) can be
 * placed the same way an existing row is.
 */
/**
 * Per-row save feedback: id -> 'saving' | 'saved' | 'failed'.
 *
 * reactive(), not ref({}), so assigning and deleting a key by id updates the
 * button without rebuilding the object each time.
 */
const rowState = reactive({});
const saveLabel = (g) => ({ saving: 'Saving…', saved: 'Saved ✓', failed: 'Failed' })[rowState[g.id]] ?? 'Save';

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
  // Each row carries an editable text form of its aliases alongside the array.
  // See the textarea comment: the two must not be the same binding.
  gazetteer.value = (await api('/gazetteer')).gazetteer.map((g) => ({
    ...g,
    aliasText: (g.aliases ?? []).join(NL)
  }));
}

async function create(confirmGnis = false) {
  const name = draft.name.trim();
  try {
    const { merged } = await api('/gazetteer', {
      method: 'POST',
      admin: true,
      body: {
        name,
        aliases: splitLines(draft.aliases),
        lat: draft.lat,
        lng: draft.lng,
        region: draft.region.trim() || null,
        confirm_gnis: confirmGnis
      }
    });
    Object.assign(draft, { name: '', aliases: '', lat: null, lng: null, region: '' });
    placing.value = null;
    // The POST upserts on lower(name), so typing an existing name FOLDS into
    // that entry rather than creating a second one. Saying "Added." either way
    // hid a merge behind the word for its opposite.
    statusMsg.value = merged
      ? `"${name}" already existed — your aliases were added to it.`
      : `Added "${name}".`;
    await load();
  } catch (err) {
    // 409: the name is already in GNIS. Informational, not fatal — the
    // geocoder already resolves it, but an entry is still how you settle an
    // ambiguous name or override a coordinate. Ask, then send it again.
    if (err.status === 409 && err.data?.gnis?.length && !confirmGnis) {
      const list = err.data.gnis
        .map((g) => `  ${g.name} (${g.feature_class}${g.county ? ', ' + g.county + ' Co' : ''}) ` +
                    `${Number(g.lat).toFixed(4)}, ${Number(g.lng).toFixed(4)}`)
        .join(NL);
      const ok = window.confirm(
        `"${name}" is already in GNIS:` + NL + NL + list + NL + NL +
        'The geocoder already resolves that name, so an entry is usually not needed. ' +
        'Add one anyway? (Worth it to settle a duplicate name, or to override that coordinate.)'
      );
      if (ok) return create(true);
      statusMsg.value = `Not added — "${name}" is already covered by GNIS.`;
      return;
    }
    statusMsg.value = `Add failed: ${err.message}`;
  }
}

async function update(g) {
  // Text -> array happens HERE and nowhere else: trim, drop blanks, dedupe.
  const aliases = splitLines(g.aliasText);
  rowState[g.id] = 'saving';
  try {
    const { entry } = await api(`/gazetteer/${g.id}`, {
      method: 'PATCH',
      admin: true,
      body: { name: g.name, aliases, lat: g.lat, lng: g.lng, region: g.region }
    });
    // Re-sync from what was actually stored, so the box shows the cleaned form
    // once the round trip is over rather than whatever was mid-edit. This is
    // the second half of the confirmation: you watch your three typed lines
    // become the three stored aliases.
    g.aliases = entry?.aliases ?? aliases;
    g.aliasText = g.aliases.join(NL);
    const n = g.aliases.length;
    rowState[g.id] = 'saved';
    statusMsg.value = `Saved "${g.name}" (${n} alias${n === 1 ? '' : 'es'}).`;
    setTimeout(() => { if (rowState[g.id] === 'saved') delete rowState[g.id]; }, 2500);
  } catch (err) {
    // Failures persist on the row until the next attempt — no timeout. A
    // disappearing error is worse than no error.
    rowState[g.id] = 'failed';
    statusMsg.value = `Save failed: ${err.message}`;
  }
}

async function remove(g) {
  // Say what it costs. "Sightings keep their coordinates but lose the link" is
  // true and useless without a number — some entries place ninety-odd rows.
  const n = g.sighting_count ?? 0;
  const cost = n
    ? `${n} sighting${n === 1 ? '' : 's'} currently link to it. They keep their coordinates but lose the link, and nothing will re-resolve that name.`
    : 'No sightings link to it.';
  if (!window.confirm(`Delete "${g.name}" from the gazetteer?

${cost}`)) return;
  try {
    await api(`/gazetteer/${g.id}`, { method: 'DELETE', admin: true });
    if (placing.value === g) placing.value = null;
    statusMsg.value = `Deleted "${g.name}".`;
    await load();
  } catch (err) {
    // This used to throw into nothing: a failed delete looked like a no-op.
    statusMsg.value = `Delete failed: ${err.message}`;
  }
}

onMounted(load);
</script>
