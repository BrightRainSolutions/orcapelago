<template>
  <nav class="topnav">
    <router-link to="/" class="brand">Orcapelago</router-link>
    <router-link to="/about">About</router-link>
    <!-- Only shown to people holding an admin token; the API enforces the rest. -->
    <router-link v-if="hasAdminToken" to="/admin" class="topnav-admin">Admin</router-link>
  </nav>

  <!--
    Persistent map. v-show rather than v-if: on a full-page route it is hidden,
    not destroyed, so returning to it costs nothing.
  -->
  <MapView v-show="!route.meta.fullPage" :hidden="Boolean(route.meta.fullPage)" />

  <router-view v-slot="{ Component, route: r }">
    <Modal v-if="r.meta.modal && Component" :label="r.meta.label" @close="close">
      <component :is="Component" />
    </Modal>
    <component v-else-if="Component" :is="Component" />
  </router-view>
</template>

<script setup>
import { useRoute, useRouter } from 'vue-router';
import MapView from './views/MapView.vue';
import Modal from './components/Modal.vue';
import { hasAdminToken } from './api/client.js';

const route = useRoute();
const router = useRouter();

/** Close returns to the map. Browser Back does the same thing for free. */
function close() {
  router.push('/');
}
</script>
