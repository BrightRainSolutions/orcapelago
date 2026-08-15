// Thin fetch wrapper for /api/*. Admin calls attach X-Admin-Token from
// localStorage — a convenience gate only; enforcement lives in the functions.

const TOKEN_KEY = 'orcapelago_admin_token';

export function getAdminToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setAdminToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY);
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
  const res = await fetch(`/api${path}`, {
    method,
    headers,
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
