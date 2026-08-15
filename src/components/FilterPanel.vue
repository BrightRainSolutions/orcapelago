<template>
  <div class="filter-panel">
    <div class="fp-dates">
      <label>From <input type="date" :value="from" @input="$emit('update:from', $event.target.value)" /></label>
      <label>To <input type="date" :value="to" @input="$emit('update:to', $event.target.value)" /></label>
    </div>
    <div class="fp-species">
      <label v-for="(def, key) in SPECIES" :key="key" class="fp-check">
        <input
          type="checkbox"
          :checked="species.includes(key)"
          @change="toggle(key)"
        />
        <span class="fp-dot" :style="{ background: def.color }"></span>
        {{ def.label }}
      </label>
    </div>
  </div>
</template>

<script setup>
import { SPECIES } from '../map/species.js';

const props = defineProps({
  from: String,
  to: String,
  species: { type: Array, required: true }
});
const emit = defineEmits(['update:from', 'update:to', 'update:species']);

function toggle(key) {
  const next = props.species.includes(key)
    ? props.species.filter((k) => k !== key)
    : [...props.species, key];
  emit('update:species', next);
}
</script>
