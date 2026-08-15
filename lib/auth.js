// Admin auth: single shared secret in X-Admin-Token header (spec §2).
// The client-side localStorage gate is convenience only — this check is
// the actual enforcement.

/** @param {Request} req  @returns {boolean} */
export function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  return Boolean(token) && req.headers.get('x-admin-token') === token;
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
