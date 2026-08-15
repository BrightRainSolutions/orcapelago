// Deterministic fake sightings for frontend development before the API/DB
// exists (spec §9.3: "fake data first"). Shaped exactly like the GeoJSON
// that /api/sightings returns.

const SPOTS = [
  ['Haro Strait off Lime Kiln', 48.515, -123.16],
  ['Admiralty Inlet off Bush Point', 48.03, -122.62],
  ['Saratoga Passage off Langley', 48.05, -122.4],
  ['Possession Sound', 47.93, -122.35],
  ['Elliott Bay', 47.6, -122.38],
  ['Colvos Passage off Olalla', 47.43, -122.55],
  ['Rosario Strait', 48.55, -122.75],
  ['President Channel', 48.65, -123.05],
  ['Active Pass', 48.87, -123.3],
  ['Port Townsend Bay', 48.09, -122.78],
  ['Point No Point', 47.91, -122.52],
  ['Penn Cove', 48.22, -122.7]
];

const SPECIES_POOL = [
  'biggs', 'biggs', 'biggs', 'humpback', 'humpback',
  'gray', 'minke', 'southern_resident', 'unidentified_orca'
];

const PODS = { biggs: ['T99s', 'T46Bs', 'T34s & T37s', 'T77C & T77E', 'T65As'],
               southern_resident: ['J Pod', 'L Pod'] };

const BEHAVIORS = [['traveling'], ['foraging'], ['breaching', 'traveling'], ['milling'], []];
const DIRECTIONS = ['northbound', 'southbound', 'W', 'SE', null];

// Small seeded LCG so the dataset is stable across reloads.
function lcg(seed) {
  let s = seed;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

export function fakeSightingsGeojson() {
  const rand = lcg(20260715);
  const features = [];
  let n = 0;
  for (let day = 1; day <= 10; day++) {
    const reports = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < reports; i++) {
      const [name, lat, lng] = SPOTS[Math.floor(rand() * SPOTS.length)];
      const species = SPECIES_POOL[Math.floor(rand() * SPECIES_POOL.length)];
      const pods = PODS[species];
      const hour = 6 + Math.floor(rand() * 14);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lng + (rand() - 0.5) * 0.06, lat + (rand() - 0.5) * 0.04]
        },
        properties: {
          id: `fake-${n++}`,
          species,
          pod_or_group: pods ? pods[Math.floor(rand() * pods.length)] : null,
          individual_ids: [],
          sighting_date: `2026-07-${String(day).padStart(2, '0')}`,
          sighting_time: `${String(hour).padStart(2, '0')}:${rand() > 0.5 ? '30' : '00'}`,
          count: 1 + Math.floor(rand() * 6),
          direction: DIRECTIONS[Math.floor(rand() * DIRECTIONS.length)],
          behaviors: BEHAVIORS[Math.floor(rand() * BEHAVIORS.length)],
          location_raw: name,
          geo_method: rand() > 0.3 ? 'catalog' : 'ai',
          reporter: 'Demo Data',
          summary: `Demo sighting near ${name}.`
        }
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
