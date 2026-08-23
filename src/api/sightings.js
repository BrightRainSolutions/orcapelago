// Sightings data access for the map/table views. Tries the real API first;
// falls back to deterministic fake data so the frontend is workable before
// the DB/functions exist (spec §9.3). The map shows a "demo data" badge
// when the fallback is active.
import { fakeSightingsGeojson } from '../dev/fake-sightings.js';

/**
 * @param {{ newsletter?: string, from?: string, to?: string, species?: string[] }} params
 *   newsletter: a uuid, or 'latest' for the most recent issue. Passing it
 *   scopes the payload to one newsletter and makes the response carry
 *   `newsletter` and `range` (the archive's full date span).
 * @returns {Promise<{ data: object, source: 'api' | 'fake' }>}
 */
export async function fetchSightings(params = {}) {
  const qs = new URLSearchParams();
  if (params.newsletter) qs.set('newsletter', params.newsletter);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.species?.length) qs.set('species', params.species.join(','));
  try {
    const res = await fetch(`/api/sightings?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.type !== 'FeatureCollection') throw new Error('unexpected payload');
    return { data, source: 'api' };
  } catch (err) {
    console.info('[orcapelago] /api/sightings unavailable, using demo data:', err.message);
    return { data: fakeSightingsGeojson(), source: 'fake' };
  }
}
