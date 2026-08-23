import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';

// Order matters: maplibre-gl.css must land BEFORE main.css so our overrides
// win on source order. Imported here rather than inside the map components,
// where Vite would bundle it after the entry CSS and the library would win
// every specificity tie — which previously forced selector gymnastics
// (:not(:empty), .maplibregl-compact) just to square off a few corners.
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/main.css';

createApp(App).use(router).mount('#app');
