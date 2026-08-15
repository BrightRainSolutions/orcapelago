import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Orcapelago',
        short_name: 'Orcapelago',
        description: 'Whale sightings in the Salish Sea, mapped from Orca Network newsletters',
        theme_color: '#006D77',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        // App shell: cache-first (precache handles the build assets).
        // API sightings: network-first so fresh data wins when online.
        runtimeCaching: [
          {
            urlPattern: /\/api\/sightings/,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-sightings' }
          }
        ]
        // Vector tiles are left to default HTTP caching (spec §8).
      }
    })
  ]
});
