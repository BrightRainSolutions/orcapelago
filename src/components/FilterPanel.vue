<template>
  <div class="filter-panel">
    <div v-if="heading" class="fp-heading">
      <strong>{{ heading }}</strong>
      <span v-if="subheading" class="fp-sub">{{ subheading }}</span>
    </div>

    <div class="fp-dates">
      <label>From <input type="date" :value="from" @input="$emit('update:from', $event.target.value)" /></label>
      <label>To <input type="date" :value="to" @input="$emit('update:to', $event.target.value)" /></label>
      <div class="fp-dates-foot">
        <button v-if="fullRange" type="button" class="fp-reset" @click="$emit('reset')">
          All dates ({{ fullRange }})
        </button>
        <span v-if="loading" class="fp-loading">loading…</span>
      </div>
    </div>

    <div class="fp-group-label">Orca Sightings</div>
    <div class="fp-species">
      <label v-for="key in ORCA_KEYS" :key="key" class="fp-check">
        <input type="checkbox" :checked="species.includes(key)" @change="toggle(key)" />
        <span class="fp-dot" :style="swatch(key)"></span>
        {{ SPECIES[key].label }}
      </label>
    </div>

    <!--
      Non-orca species: collapsed and unchecked on load. <details> rather than a
      custom toggle so keyboard and screen-reader behaviour come for free; the
      default marker is replaced with a CSS triangle.
    -->
    <details class="fp-more">
      <summary>Other Species</summary>
      <div class="fp-species">
        <label v-for="key in OTHER_KEYS" :key="key" class="fp-check">
          <input type="checkbox" :checked="species.includes(key)" @change="toggle(key)" />
          <span class="fp-dot" :style="swatch(key)"></span>
          {{ SPECIES[key].label }}
        </label>
      </div>
    </details>

    <div v-if="$slots.footer" class="fp-footer"><slot name="footer" /></div>
  </div>
</template>

<script setup>
import { SPECIES, ORCA_KEYS, OTHER_KEYS } from '../map/species.js';

const props = defineProps({
  from: String,
  to: String,
  species: { type: Array, required: true },
  // Scope of what's loaded, e.g. "Latest Sightings".
  heading: { type: String, default: '' },
  subheading: { type: String, default: '' },
  // Human-readable span of the whole archive, e.g. "Jun 4 – Aug 3". Shown on
  // the reset button so the escape hatch names what it will widen to. The
  // client can't derive this from a newsletter-scoped payload — it comes from
  // the API's `range` member. Omit to hide the button.
  fullRange: { type: String, default: '' },
  // True while a date change is being re-fetched from the API.
  loading: { type: Boolean, default: false }
});
const emit = defineEmits(['update:from', 'update:to', 'update:species', 'reset']);

/** Swatch mirrors the map marker: species fill, species ring as the border. */
function swatch(key) {
  return { background: SPECIES[key].color, borderColor: SPECIES[key].ring };
}

function toggle(key) {
  const next = props.species.includes(key)
    ? props.species.filter((k) => k !== key)
    : [...props.species, key];
  emit('update:species', next);
}
</script>
