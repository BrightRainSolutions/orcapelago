<template>
  <!--
    Shell, not a page. Review needs a full-bleed map, so this is a flex column
    that fills the viewport; Gazetteer gets a boxed, scrolling wrapper inside
    it. Wrapping everything in .page would cap the map at a text column.

    Ingesting a newsletter is not here. It is a CLI job — `node
    scripts/run-ingest.mjs <file>` — because it costs several dollars, runs for
    twenty minutes, and needs the API key, which is deliberately absent from
    Netlify so a deployed button can never spend money. A tab that cannot work
    in production is worse than no tab.

    ?tab= and ?sighting= are how the map deep-links into the review editor for
    one specific row.
  -->
  <main class="admin admin-shell">
    <template v-if="!authed">
      <div class="admin-boxed">
        <h1>Admin</h1>
        <p>Enter the admin token. This gate is convenience only; the API enforces the token on every admin call.</p>
        <form class="admin-gate" @submit.prevent="login">
          <input v-model="tokenInput" type="password" placeholder="Admin token" autocomplete="off" />
          <button type="submit" :disabled="checking">{{ checking ? 'Checking…' : 'Enter' }}</button>
        </form>
        <p v-if="gateError" class="admin-error">{{ gateError }}</p>
        <p><router-link to="/">Back to map</router-link></p>
      </div>
    </template>

    <template v-else>
      <nav class="admin-tabs">
        <button :class="{ active: tab === 'review' }" @click="tab = 'review'">Review queue</button>
        <button :class="{ active: tab === 'gazetteer' }" @click="tab = 'gazetteer'">Gazetteer</button>
        <router-link to="/" class="admin-back">Back to map</router-link>
        <button class="admin-signout" @click="logout">Sign out</button>
      </nav>

      <ReviewQueue v-if="tab === 'review'" :open-sighting-id="route.query.sighting ?? null" />
      <div v-else class="admin-boxed"><GazetteerPanel /></div>
    </template>
  </main>
</template>

<script setup>
// Admin (spec §8.4): token-gated client-side; token in localStorage, sent as
// X-Admin-Token on admin calls. Real enforcement is in the functions.
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { getAdminToken, setAdminToken, clearAdminToken, validateAdminToken } from '../api/client.js';
import ReviewQueue from '../components/admin/ReviewQueue.vue';
import GazetteerPanel from '../components/admin/GazetteerPanel.vue';

// See lib/auth.js — temporary local bypass, removed before deploy.
const authed = ref(false);
const tokenInput = ref('');
const gateError = ref('');
const checking = ref(false);
const route = useRoute();
// Deep link from the map: /admin?tab=review&sighting=<id>
const tab = ref(route.query.tab ?? 'review');

async function login() {
  checking.value = true;
  gateError.value = '';
  setAdminToken(tokenInput.value.trim());
  try {
    authed.value = await validateAdminToken();
    if (!authed.value) gateError.value = 'Invalid token.';
  } catch (err) {
    gateError.value = `Could not reach the API: ${err.message}`;
  } finally {
    checking.value = false;
  }
}

function logout() {
  clearAdminToken();
  authed.value = false;
  tokenInput.value = '';
}

onMounted(async () => {
  if (getAdminToken()) {
    try {
      authed.value = await validateAdminToken();
    } catch { /* leave gate shown */ }
  }
});
</script>
