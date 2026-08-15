import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/MapView.vue') },
    { path: '/sightings', component: () => import('./views/SightingsView.vue') },
    { path: '/about', component: () => import('./views/AboutView.vue') },
    { path: '/admin', component: () => import('./views/AdminView.vue') }
  ]
});
