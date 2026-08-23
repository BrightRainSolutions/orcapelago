import { createRouter, createWebHistory } from 'vue-router';

// The map is NOT a route. It is rendered permanently by App.vue so that
// navigating never tears down the MapLibre instance — previously a trip to
// /sightings destroyed the map and coming back refetched the style, recomposed
// the bathymetry layers and reset the viewport.
//
// meta.modal    → rendered in an overlay above the persistent map
// meta.fullPage → replaces the map view entirely (map stays mounted, hidden)
const Empty = { render: () => null };

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Empty },
    {
      path: '/sightings',
      component: () => import('./views/SightingsView.vue'),
      meta: { modal: true, label: 'Sightings' }
    },
    {
      path: '/about',
      component: () => import('./views/AboutView.vue'),
      meta: { modal: true, label: 'About Orcapelago' }
    },
    {
      path: '/admin',
      component: () => import('./views/AdminView.vue'),
      meta: { fullPage: true }
    }
  ]
});
