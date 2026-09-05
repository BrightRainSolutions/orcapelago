// One-off: teach the gazetteer how to place a webcam sighting.
//
// Two changes, and the second only exists because of the first.
//
// 1. A new entry, "Lime Kiln webcam", ~400 m offshore of the lighthouse.
//    Reports that say only "on the Lime Kiln webcam" describe whales in the
//    camera's view, not a whale sitting on the point, so they should not land
//    on the shore feature.
//
// 2. Extra aliases on the existing "Lime Kiln Point". Stage 2 resolves exact
//    name, then exact alias, then trigram similarity ≥0.4 with a ≥0.1 margin
//    over the runner-up. Two entries that both start "Lime Kiln" put the
//    fuzzy stage into a tie: measured before running this, "off lime kiln"
//    fell from a clean 0.500 match to a 0.024 margin (ambiguous → falls
//    through to AI), and "lime kiln stream" from 0.435 to a 0.043 margin.
//    Exact aliases run BEFORE the fuzzy stage, so spelling each phrasing out
//    keeps them resolving free.
//
// Phrasings are taken from the three ingested newsletters, not invented.
//
//   node scripts/add-webcam-gazetteer.mjs [--undo]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[0].trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const { getSql } = await import('../../lib/db.js');
const sql = getSql();
const undo = process.argv.includes('--undo');

// 400 m at bearing 280° from GNIS "Lime Kiln Point" (48.5158709,
// -123.1524506) — just off the point, into Haro Strait, on the bearing the
// existing Lime Kiln sightings already cluster along (274°–290°).
const WEBCAM = {
  name: 'Lime Kiln webcam',
  lat: 48.5165,
  lng: -123.1578,
  region: 'Haro Strait',
  aliases: [
    'Lime Kiln stream',
    'Lime Kiln cam',
    'Lime Kiln web cam',
    'the Lime Kiln webcam',
    'on the Lime Kiln webcam',
    'Lime Kiln hydrophone and webcam',
    // Phrasings the Aug 21 issue introduced — it calls the same camera a
    // livestream as often as a webcam.
    'Lime Kiln livestream',
    'the Lime Kiln livestream',
    'Lime Kiln live stream',
    'Lime Kiln camera',
    'Lime Kiln cam view'
  ]
};

// Phrasings that must keep pointing at the shore feature, spelled out so the
// new entry above cannot steal them in the fuzzy stage.
const POINT_ALIASES = ['Lime Kiln Lighthouse', 'off Lime Kiln', 'Lime Kiln Point, San Juan Island'];

const [point] = await sql`select * from gazetteer where name = 'Lime Kiln Point'`;
if (!point) {
  console.error('FAIL: no "Lime Kiln Point" gazetteer entry to anchor against.');
  process.exit(1);
}

if (undo) {
  await sql`delete from gazetteer where name = ${WEBCAM.name}`;
  const kept = point.aliases.filter((a) => !POINT_ALIASES.includes(a));
  await sql`update gazetteer set aliases = ${kept} where id = ${point.id}`;
  console.log('reverted.');
} else {
  const merged = [...new Set([...point.aliases, ...POINT_ALIASES])];
  await sql`update gazetteer set aliases = ${merged} where id = ${point.id}`;

  const [existing] = await sql`select id from gazetteer where name = ${WEBCAM.name}`;
  if (existing) {
    await sql`
      update gazetteer
      set aliases = ${WEBCAM.aliases}, lat = ${WEBCAM.lat}, lng = ${WEBCAM.lng}, region = ${WEBCAM.region}
      where id = ${existing.id}`;
    console.log('updated existing webcam entry');
  } else {
    await sql`
      insert into gazetteer (name, aliases, lat, lng, region, source)
      values (${WEBCAM.name}, ${WEBCAM.aliases}, ${WEBCAM.lat}, ${WEBCAM.lng}, ${WEBCAM.region}, 'manual')`;
    console.log('inserted webcam entry');
  }
}

console.table(
  await sql`select name, aliases, lat, lng from gazetteer where name like 'Lime Kiln%' order by name`
);
