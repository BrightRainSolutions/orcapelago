// Sighting popup HTML (spec §8.1): species + pod/IDs, date/time, location
// name, direction/behaviors, reporter, one-line summary, geo_method badge.
import { SPECIES } from './species.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// MapLibre JSON-stringifies array properties on GeoJSON features.
function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v); } catch { return []; }
  }
  return v ? [v] : [];
}

export function popupHtml(p) {
  const sp = SPECIES[p.species] ?? SPECIES.other;
  const ids = arr(p.individual_ids);
  const behaviors = arr(p.behaviors);
  const who = [p.pod_or_group, ids.join(', ')].filter(Boolean).join(' — ');
  const when = [p.sighting_date, p.sighting_time?.slice(0, 5)].filter(Boolean).join(' · ');
  const doing = [p.direction, behaviors.join(', ')].filter(Boolean).join(' · ');

  return `
    <div class="sighting-popup">
      <div class="sp-species" style="color:${sp.color}">
        ${esc(sp.label)}${who ? ` <span class="sp-who">${esc(who)}</span>` : ''}
      </div>
      <div class="sp-when">${esc(when)}</div>
      <div class="sp-where">${esc(p.location_raw ?? '')}
        <span class="sp-badge sp-badge-${esc(p.geo_method ?? 'unresolved')}">${esc(p.geo_method ?? '')}</span>
      </div>
      ${doing ? `<div class="sp-doing">${esc(doing)}</div>` : ''}
      ${p.summary ? `<div class="sp-summary">${esc(p.summary)}</div>` : ''}
      ${p.reporter ? `<div class="sp-reporter">${esc(p.reporter)}</div>` : ''}
    </div>`;
}
