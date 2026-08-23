// Admin auth: single shared secret in X-Admin-Token header (spec §2).
// The client-side localStorage gate is convenience only — this check is
// the actual enforcement.

/**
 * TEMPORARY LOCAL BYPASS — remove before deploying.
 *
 * Set VITE_OPEN_ADMIN=1 in .env to open the admin API without a token, so the
 * admin UI can be worked on directly. One flag covers both sides: `netlify dev`
 * injects .env into the functions, and Vite exposes VITE_-prefixed vars to the
 * client, which skips its own gate on the same value.
 *
 * Deliberately NOT keyed on NODE_ENV: an absent or unexpected NODE_ENV must
 * never silently open the admin API. This requires someone to have written the
 * flag into an environment on purpose.
 *
 * @param {Request} req  @returns {boolean}
 */
export function isAdmin(req) {
  if (process.env.VITE_OPEN_ADMIN === '1') {
    console.warn('[orcapelago] ADMIN AUTH BYPASSED — VITE_OPEN_ADMIN=1');
    return true;
  }
  const token = process.env.ADMIN_TOKEN;
  return Boolean(token) && req.headers.get('x-admin-token') === token;
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
