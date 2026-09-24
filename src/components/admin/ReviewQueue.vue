<template>
  <!--
    Full-bleed picker. The map is the surface and the panels float over it, the
    same arrangement as the public map. The previous 704px pane meant panning
    the map to reach a pin that was already on screen.

    MiniMap sits outside the v-if so it mounts once and survives every
    selection — re-centering is a watch on lat/lng, not a remount.
  -->
  <section class="review">
    <MiniMap class="review-map" :lat="form.lat" :lng="form.lng" :focus-key="selected?.id ?? null" @place="onPlace" />

    <aside class="review-queue">
      <div class="rq-head">
        <strong>Needs review</strong>
        <!-- Flagged rows only. A sighting opened by id may already be
             reviewed, so counting it here would misstate the backlog. -->
        <span class="rq-count">{{ flaggedCount }}</span>
      </div>
      <!--
        Two orderings, because they catch different mistakes. Distance is the
        mask's opinion and is blind to a pin sitting comfortably in the WRONG
        water; confidence is the model's own, and on the Sept 22 issue it ran
        65% in water for 'low' against 92% for 'high'. Distance stays the
        tiebreaker either way.
      -->
      <div class="rq-sort">
        <span>Sort</span>
        <button :class="{ active: sort === 'distance' }" @click="setSort('distance')">furthest inland</button>
        <button :class="{ active: sort === 'confidence' }" @click="setSort('confidence')">least confident</button>
      </div>
      <p v-if="sort === 'distance' && outOfWater" class="admin-hint">
        Furthest-inland first — {{ outOfWater }} of these sit 100&nbsp;m to
        5&nbsp;km from marine water. Freshwater and anything beyond the
        Washington coverage area are excluded, so this is an ordering, not a
        verdict.
      </p>
      <p v-if="sort === 'confidence'" class="admin-hint">
        Least-confident first, by the model's own rating, then furthest inland
        within each band. Catches pins that are in water but the wrong water.
      </p>
      <p v-if="truncated" class="admin-hint">
        Showing the first {{ rows.length }}; more remain.
      </p>
      <div class="review-list">
        <button
          v-for="s in rows"
          :key="s.id"
          :class="['review-item', { active: selected?.id === s.id }]"
          :aria-current="selected?.id === s.id ? 'true' : undefined"
          @click="select(s)"
        >
          <span class="ri-loc">
            {{ s.location_raw }}
            <!-- Opened by id from the map or Candidates; it may already be
                 reviewed, so say so rather than let it pass as a queue item. -->
            <em v-if="s.opened_by_id" class="ri-tag">opened</em>
          </span>
          <span class="ri-meta">
            {{ s.sighting_date }} · {{ s.species }} · {{ s.geo_method }}
            <!-- Distance inland, when the position is outside marine water.
                 Not a verdict — Canadian water and the Ballard ship canal are
                 outside the mask and perfectly correct. -->
            <em v-if="inland(s)" class="ri-inland">{{ inland(s) }} inland</em>
          </span>
        </button>
        <p v-if="!rows.length" class="admin-hint">Queue is clear.</p>
      </div>
    </aside>

    <aside v-if="selected" class="review-editor">
      <button type="button" class="sp-close" aria-label="Close" @click="selected = null">×</button>
      <div class="rq-head"><strong>Edit sighting</strong></div>

      <!-- The reporter's own words for the place. Read-only: it is the key the
           gazetteer is matched on, so editing it here would silently detach
           the row from it. -->
      <p class="review-raw">{{ selected.location_raw }}</p>

      <!--
        The excerpt, not the summary.

        `summary` is the model's one-sentence paraphrase of `raw_excerpt`, so
        rendering both put the same sentence on screen twice — three times
        counting the location heading above — and pushed the reasoning and the
        buttons below the fold. In review the reporter's own words are the
        thing being judged; a paraphrase of them is noise. The summary is still
        stored and still shown on the public map.
      -->
      <blockquote v-if="selected.raw_excerpt" class="review-excerpt">{{ selected.raw_excerpt }}</blockquote>

      <!-- Why the model put the pin here. This is the fastest way to tell a
           misread of the text ("thought Langley was on the mainland") from a
           bad offset ("knew the vantage point, went the wrong way"), which is
           the difference between fixing the prompt and fixing the pin.
           Open by default: it is the first thing worth reading on a flagged
           row, and on a low-confidence one it usually says outright what is
           wrong ("No anchor provided"). -->
      <details v-if="selected.ai_reasoning" class="review-why" open>
        <summary>
          Why here?
          <span v-if="selected.ai_confidence" class="review-conf">{{ selected.ai_confidence }} confidence</span>
        </summary>
        <p>{{ selected.ai_reasoning }}</p>
      </details>

      <div class="review-fields">
        <label>Species
          <select v-model="form.species">
            <option v-for="(def, key) in SPECIES" :key="key" :value="key">{{ def.label }}</option>
          </select>
        </label>
        <label>Pod/group <input v-model="form.pod_or_group" /></label>
        <label>Date <input v-model="form.sighting_date" type="date" /></label>
        <label>Time <input v-model="form.sighting_time" type="time" /></label>
        <label>Lat <input v-model.number="form.lat" type="number" step="0.0001" /></label>
        <label>Lng <input v-model.number="form.lng" type="number" step="0.0001" /></label>
      </div>

      <p class="review-hint">Click the map or drag the pin to place it. Either sets geo method to manual.</p>

      <!--
        Reviewing places the ANIMAL. Naming a PLACE is a different job and it
        moved to the Gazetteer tab.
        
        The two were one action here, and it produced wrong data: reviewing
        "300 yards out from Vashon Ferry Dock" meant typing the name down to
        "Vashon Ferry Dock" while the pin stayed 300 yards offshore, so the
        entry recorded the dock as being out in the water. 6 of 38 entries were
        built that way. Because entries are also ANCHORS, each one then taught
        the model a wrong origin for every future phrase naming that place.
      -->
      <div class="review-actions">
        <!--
          Some reports cannot be placed by anyone: timestamped updates in a
          running encounter — "Post meal breach", "same general area as
          previous report" — where the location lives in the PREVIOUS report.

          Clears the coordinates as well as the flag. That is the point: an
          unplaceable string the model guessed at anyway leaves a fictional pin
          on the public map, and dropping the row from the queue without
          dropping the pin would hide it rather than fix it.

          Not a delete. The sighting is real — species, time, pod, reporter,
          excerpt — and stays in the record.
        -->
        <button class="review-unplaceable" :disabled="saving" @click="markUnplaceable()">
          Cannot be placed
        </button>
        <button class="review-save" :disabled="saving" @click="save()">
          {{ saveLabel }}
        </button>
        <span v-if="message" class="review-msg">{{ message }}</span>
      </div>
    </aside>
  </section>
</template>

<script setup>
// Review queue (spec §8.4): flagged sightings with raw_excerpt beside
// editable fields; mini-map click-placement. Placing the pin is the whole job.
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { api } from '../../api/client.js';
import { SPECIES } from '../../map/species.js';
import MiniMap from './MiniMap.vue';

/**
 * Optional sighting to open on arrival — the map's Edit link and the
 * Candidates "Map" link both deep-link here. It may not be in the queue at
 * all (already reviewed), so fall back to fetching it directly.
 */
const props = defineProps({
  openSightingId: { type: String, default: null }
});

const rows = ref([]);
const truncated = ref(false);
const selected = ref(null);
const form = reactive({});

/** Review ordering; the server sorts, so changing it refetches. */
const sort = ref('distance');
async function setSort(next) {
  if (sort.value === next) return;
  sort.value = next;
  selected.value = null;
  await load();
}

const flaggedCount = computed(() => rows.value.filter((r) => r.needs_review).length);

// Same band the API sorts on. Below 100m is shoreline noise; above 5km the
// distance is measuring the mask's coverage rather than a mistake — northern
// Vancouver Island sightings are 300km outside it and entirely correct.
const INLAND_MIN = 100;
const INLAND_MAX = 5000;

const outOfWater = computed(() => rows.value.filter((r) => inland(r)).length);

/** Human distance inland, or null when the pin is fine or out of scope. */
function inland(s) {
  const m = Number(s.water_dist_m);
  if (!Number.isFinite(m) || m < INLAND_MIN || m > INLAND_MAX) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// "Clear flag" is only true when there is a flag; a sighting opened from the
// map may have been reviewed months ago.
const saveLabel = computed(() => {
  if (saving.value) return 'Saving…';
  return selected.value?.needs_review ? 'Save & clear flag' : 'Save changes';
});
const message = ref('');
const saving = ref(false);

// Was 500 while the backlog was ~1,100, so a third of the flagged sightings
// were invisible and the queue looked finished when it wasn't. 5000 matches the
// API's own default cap; beyond that this needs pagination rather than a bigger
// number, so say so instead of truncating silently.
const REVIEW_LIMIT = 5000;

async function load() {
  // admin: true — needs_review is no longer a public query, and reporter and
  // raw_excerpt only come back for an authenticated caller.
  const data = await api(`/sightings?needs_review=true&format=json&sort=${sort.value}&limit=${REVIEW_LIMIT}`, { admin: true });
  rows.value = data.sightings;
  truncated.value = data.sightings.length >= REVIEW_LIMIT;
}

/** Keep the highlighted row visible when selection moves on its own. */
function scrollActiveIntoView() {
  document.querySelector('.review-item.active')?.scrollIntoView({ block: 'nearest' });
}

function select(s) {
  selected.value = s;
  message.value = '';
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
}

/**
 * Did a person move this coordinate? Compared against the loaded row rather
 * than tracked with a flag, because a flag only catches the map click and
 * drag — typing into the Lat/Lng fields is just as manual and was slipping
 * through as whatever geo_method the AI had assigned.
 */
function coordsMoved() {
  const s = selected.value;
  if (!s) return false;
  return form.lat !== s.lat || form.lng !== s.lng;
}

/**
 * Move to the next row after acting on one. The row just handled leaves the
 * queue, so the same index is now the next one down — losing your place after
 * every save is what makes a long backlog feel endless.
 */
async function advance() {
  const idx = rows.value.findIndex((r) => r.id === selected.value?.id);
  await load();
  const next = rows.value[Math.min(Math.max(idx, 0), rows.value.length - 1)];
  if (next) { select(next); await nextTick(); scrollActiveIntoView(); }
  else selected.value = null;
}

/** "This text does not locate anything." Clears the guess and the flag. */
async function markUnplaceable() {
  const s = selected.value;
  if (!s) return;
  if (!window.confirm(
    `Mark as unplaceable?\n\n${s.location_raw}\n\n` +
    'The sighting stays in the record, but its coordinates are cleared and it ' +
    'leaves the map and this queue.'
  )) return;
  saving.value = true;
  message.value = '';
  try {
    await api(`/sightings/${s.id}`, {
      method: 'PATCH',
      admin: true,
      body: { lat: null, lng: null, geo_method: 'unresolved', needs_review: false }
    });
    message.value = 'Marked unplaceable.';
    await advance();
  } catch (err) {
    message.value = `Failed: ${err.message}`;
  } finally {
    saving.value = false;
  }
}

async function save() {
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
    if (coordsMoved()) patch.geo_method = 'manual';
    await api(`/sightings/${selected.value.id}`, { method: 'PATCH', admin: true, body: patch });
    message.value = 'Saved.';

    await advance();
  } catch (err) {
    message.value = `Save failed: ${err.message}`;
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await load();
  if (!props.openSightingId) return;
  const inQueue = rows.value.find((r) => r.id === props.openSightingId);
  if (inQueue) { select(inQueue); await nextTick(); scrollActiveIntoView(); return; }
  try {
    const { sighting } = await api(`/sightings/${props.openSightingId}`, { admin: true });
    // Top of the list so it is findable, tagged so it is not mistaken for
    // a flagged row — it may well have been reviewed already.
    rows.value = [{ ...sighting, opened_by_id: true }, ...rows.value];
    select(rows.value[0]);
    await nextTick();
    scrollActiveIntoView();
  } catch (err) {
    message.value = `Could not open that sighting: ${err.message}`;
  }
});
</script>
