<template>
  <Teleport to="body">
    <div class="modal-backdrop" @mousedown.self="$emit('close')">
      <div
        ref="panel"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        tabindex="-1"
        @keydown.esc="$emit('close')"
        @keydown.tab="trapTab"
      >
        <button type="button" class="modal-close" aria-label="Close" @click="$emit('close')">×</button>
        <div class="modal-body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
// Overlay for the public views, so the map underneath is never unmounted.
// Closing is the only exit; the route drives whether this is mounted at all,
// which keeps URLs shareable and lets the browser Back button close it.
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps({ label: { type: String, default: 'Dialog' } });
defineEmits(['close']);

const panel = ref(null);
let previouslyFocused = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside the dialog: without this, focus walks onto the map behind. */
function trapTab(e) {
  const items = [...panel.value.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  previouslyFocused = document.activeElement;
  panel.value?.focus();
  // Stop the map scrolling behind the dialog on touch and trackpad.
  document.body.style.overflow = 'hidden';
});

onBeforeUnmount(() => {
  document.body.style.overflow = '';
  // Return focus where it came from, or a keyboard user lands back at the top
  // of the document every time they close something.
  previouslyFocused?.focus?.();
});
</script>
