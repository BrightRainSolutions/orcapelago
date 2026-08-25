// Admin auth: single shared secret in X-Admin-Token header (spec §2).
// The client-side localStorage gate is convenience only — this check is
// the actual enforcement.

/**
 * The only enforcement point for admin access.
 *
 * A VITE_OPEN_ADMIN bypass lived here during UI work and was removed before
 * deploying. If admin ever needs opening locally again, do it by setting
 * ADMIN_TOKEN and sending it — not by reintroducing a branch that returns
 * true, which is one stray environment variable away from an open API.
 *
 * @param {Request} req  @returns {boolean}
 */
export function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  return Boolean(token) && req.headers.get('x-admin-token') === token;
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
