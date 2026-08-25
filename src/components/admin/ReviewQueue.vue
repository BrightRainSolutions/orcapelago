<template>
  <!--
    Full-bleed picker. The map is the surface and the panels float over it, the
    same arrangement as the public map. The previous 704px pane meant panning
    the map to reach a pin that was already on screen.

    MiniMap sits outside the v-if so it mounts once and survives every
    selection — re-centering is a watch on lat/lng, not a remount.
  -->
  <section class="review">
    <MiniMap class="review-map" :lat="form.lat" :lng="form.lng" @place="onPlace" />

    <aside class="review-queue">
      <div class="rq-head">
        <strong>Needs review</strong>
        <!-- Flagged rows only. A sighting opened by id may already be
             reviewed, so counting it here would misstate the backlog. -->
        <span class="rq-count">{{ flaggedCount }}</span>
      </div>
      <p v-if="outOfWater" class="admin-hint">
        Sorted furthest-inland first — {{ outOfWater }} of these sit 100&nbsp;m
        to 5&nbsp;km from marine water. Freshwater and anything beyond the
        Washington coverage area are excluded, so this is an ordering, not a
        verdict.
      </p>
      <p v-if="truncated" class="admin-hint">
        Showing the first {{ rows.length }}; more remain. Work the Candidates
        tab first — each promote backfills every sighting sharing that location.
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
           gazetteer and the candidate queue are both keyed on, so editing it
           here would silently detach the row from both. -->
      <p class="review-raw">{{ selected.location_raw }}</p>

      <p v-if="selected.summary" class="review-summary">{{ selected.summary }}</p>
      <blockquote v-if="selected.raw_excerpt" class="review-excerpt">{{ selected.raw_excerpt }}</blockquote>

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
        One action, not two. The old pair read as alternatives when the second
        was really the first plus one extra step; saving a place is additive,
        so it is an optional field on the same Save.
      -->
      <div class="review-actions">
        <label class="review-place">
          Also save this as a gazetteer place named
          <input v-model="placeName" placeholder="e.g. Browns Point" />
        </label>
        <p class="review-hint">
          Optional. Gazetteer places resolve instantly on future ingests, with
          no AI guess and no trip through this queue. The raw text above is
          kept as an alias, so this exact wording matches next time.
        </p>
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
// editable fields; mini-map click-placement; optional promote-to-catalog.
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
const placeName = ref('');

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
  const gaz = placeName.value.trim() ? ' & add to gazetteer' : '';
  if (!selected.value?.needs_review) return `Save changes${gaz}`;
  return placeName.value.trim() ? 'Save & add to gazetteer' : 'Save & clear flag';
});
const message = ref('');
const saving = ref(false);

// Was 500 while the backlog was ~1,100, so a third of the flagged sightings
// were invisible and the queue looked finished when it wasn't. 5000 matches the
// API's own default cap; beyond that this needs pagination rather than a bigger
// number, so say so instead of truncating silently.
const REVIEW_LIMIT = 5000;

async function load() {
  const data = await api(`/sightings?needs_review=true&format=json&limit=${REVIEW_LIMIT}`);
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
  placeName.value = '';
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

async function save() {
  // Cataloguing is opt-in by typing a name; it never replaces the save.
  const addToGazetteer = Boolean(placeName.value.trim()) && Number.isFinite(form.lat);
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
    if (addToGazetteer) {
      const { entry } = await api('/gazetteer', {
        method: 'POST',
        admin: true,
        body: { name: placeName.value.trim(), lat: form.lat, lng: form.lng }
      });
      patch.gazetteer_id = entry.id;
      // NOT geo_method='catalog'. If the pin was moved, that coordinate came
      // from a person — the catalogue entry was created FROM it, not the other
      // way round, so claiming a catalogue lookup misreports provenance. The
      // coordsMoved() above already marks it manual; gazetteer_id records
      // which entry it seeded. Future sightings matching that name get
      // 'catalog' honestly, at ingest.
    }
    await api(`/sightings/${selected.value.id}`, { method: 'PATCH', admin: true, body: patch });
    message.value = addToGazetteer ? 'Saved, and added to the gazetteer.' : 'Saved.';

    // Keep the session moving: the saved row leaves the queue, so the same
    // index is now the next one down. Losing your place after every save is
    // what makes a 1,000-row backlog feel endless.
    const idx = rows.value.findIndex((r) => r.id === selected.value.id);
    await load();
    const next = rows.value[Math.min(Math.max(idx, 0), rows.value.length - 1)];
    if (next) { select(next); await nextTick(); scrollActiveIntoView(); }
    else selected.value = null;
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
