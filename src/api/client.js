// Thin fetch wrapper for /api/*. Admin calls attach X-Admin-Token from
// localStorage — a convenience gate only; enforcement lives in the functions.

import { ref } from 'vue';

const TOKEN_KEY = 'orcapelago_admin_token';

/**
 * Whether an admin token is stored. Reactive so the nav can show the Admin
 * link only to people who have one, and drop it again on sign-out.
 *
 * Presence, not validity: a stale token still shows the link. That's fine —
 * the gate is convenience, and every admin function verifies server-side.
 */
export const hasAdminToken = ref(Boolean(localStorage.getItem(TOKEN_KEY)));

export function getAdminToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setAdminToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  hasAdminToken.value = Boolean(token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY);
  hasAdminToken.value = false;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (admin) headers['X-Admin-Token'] = getAdminToken();
  // no-store because every consumer of this wrapper is an admin panel that
  // re-reads immediately after writing. /api/sightings and /api/gazetteer both
  // send `public, max-age=300` for the public map's benefit, so without this a
  // review edit saves correctly and then the refreshed list shows the stale
  // pre-edit row for five minutes — indistinguishable from the save failing.
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `API ${method} ${path} failed: ${res.status}`);
  }
  return data;
}

/** True if the stored admin token is accepted by the backend. */
export async function validateAdminToken() {
  try {
    await api('/geocode-candidates', { admin: true });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false;
    throw err;
  }
}
