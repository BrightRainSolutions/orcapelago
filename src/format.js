// Display formatting shared by the map and table views.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-08-03" → "Aug 3".
 *
 * Parsed by splitting the string rather than via `new Date(iso)`: that
 * constructor treats a bare date as UTC midnight, so `toLocaleDateString()`
 * renders it as the PREVIOUS day everywhere west of Greenwich — including the
 * Salish Sea. Sighting dates are calendar dates with no time zone; keep them
 * that way.
 */
export function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : iso;
}

/** "2026-06-04", "2026-08-03" → "Jun 4 – Aug 3" */
export function rangeText(from, to) {
  if (!from || !to) return '';
  return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
}
