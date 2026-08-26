<template>
  <aside v-if="sighting" class="sighting-panel">
    <button type="button" class="sp-close" aria-label="Close" @click="$emit('close')">×</button>

    <div class="sp-species">
      <span class="fp-dot" :style="{ background: species.color, borderColor: species.ring }"></span>{{ species.label }}
    </div>
    <div v-if="who" class="sp-who">{{ who }}</div>

    <div class="sp-when">{{ when }}</div>
    <div class="sp-where">
      {{ sighting.location_raw }}
      <span
        v-for="m in sensorMethods"
        :key="m"
        class="sp-detection"
        :title="m === 'hydrophone' ? 'Acoustic detection — this position is the hydrophone, not the whales' : 'Seen on a remote camera feed'"
      >{{ m }}</span>
    </div>
    <div v-if="doing" class="sp-doing">{{ doing }}</div>

    <p v-if="sighting.summary" class="sp-summary">{{ sighting.summary }}</p>

    <div class="sp-foot">
      <!-- The source, not the person. Reporter names are withheld from the
           public API (see get-sightings.mjs) — volunteers agreed to a
           newsletter credit, not to a mapped, timestamped public record. -->
      <span class="sp-reporter">Orca Network</span>
      <span class="sp-badge">{{ sighting.geo_method }}</span>
    </div>

    <!-- Admin only. Opens this exact sighting in the review map instead of
         making you find it in a thousand-row queue. -->
    <router-link
      v-if="hasAdminToken"
      class="sp-edit"
      :to="{ path: '/admin', query: { tab: 'review', sighting: sighting.id } }"
    >Edit this sighting</router-link>
  </aside>
</template>

<script setup>
// Sighting detail (spec §8.1). Rendered in our own panel rather than a
// MapLibre popup: it can't be clipped at the map edge, doesn't reposition on
// zoom, and needs none of the library's popup CSS. Vue escapes interpolated
// text, so the hand-rolled esc() this replaced is gone too.
import { computed } from 'vue';
import { SPECIES } from '../map/species.js';
import { hasAdminToken } from '../api/client.js';

const props = defineProps({
  // Raw GeoJSON feature properties from the map click, or null when nothing
  // is selected.
  sighting: { type: Object, default: null }
});
defineEmits(['close']);

// MapLibre JSON-stringifies array properties on features read back from a
// rendered layer, so individual_ids/behaviors arrive as strings.
function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v); } catch { return []; }
  }
  return v ? [v] : [];
}

const species = computed(() => SPECIES[props.sighting?.species] ?? SPECIES.other);
const who = computed(() => {
  const s = props.sighting;
  if (!s) return '';
  return [s.pod_or_group, arr(s.individual_ids).join(', ')].filter(Boolean).join(' · ');
});
const when = computed(() => {
  const s = props.sighting;
  if (!s) return '';
  return [s.sighting_date, s.sighting_time?.slice(0, 5)].filter(Boolean).join(' · ');
});
const doing = computed(() => {
  const s = props.sighting;
  if (!s) return '';
  return [s.direction, arr(s.behaviors).join(', ')].filter(Boolean).join(' · ');
});

// Badge only the sensor-based methods: an acoustic/webcam fix locates the
// sensor, not the animal (architecture §12). "visual" is the norm — no badge.
const sensorMethods = computed(() =>
  arr(props.sighting?.detection_methods).filter((m) => m === 'hydrophone' || m === 'webcam')
);
</script>
