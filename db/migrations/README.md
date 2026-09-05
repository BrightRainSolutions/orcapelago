# Migrations

Schema changes and the one-time data loads that go with them, in order. Each
one has already been run against production; they live here as the record of
how the database got its current shape, and as the recipe for building a fresh
one.

These are **not** tools you run during normal work — those are in `/scripts`.

Run in this order:

| # | DDL | Runner | What it does |
|---|---|---|---|
| 001 | `001_init.sql` | by hand (Neon console or psql) | four core tables |
| — | `../seed-gazetteer.sql` | by hand | starter gazetteer — verify the coordinates first |
| 002 | `002_detection_methods.sql` | `node db/migrations/apply-002.mjs` | detection method columns |
| 003 | `003_landmarks.sql` | `node db/migrations/apply-003.mjs` | `landmarks` table |
| — | — | `node db/migrations/import-landmarks.mjs <DomesticNames_WA.txt> prod` | GNIS features (see README §Landmarks) |
| 004 | `004_postgis.sql` | `node db/migrations/apply-004.mjs` | PostGIS extension |
| 005 | `005_water_areas.sql` | `node db/migrations/import-water-areas.mjs` | WDFW marine areas; applies its own DDL, then subdivides into `water_areas_sub` |
| 006 | `006_gazetteer_unique_name.sql` | by hand | unique index on `lower(name)` |
| 007 | `007_reasoning_on_sightings.sql` | `node db/migrations/apply-007.mjs --yes` | `ai_reasoning`/`ai_confidence` onto `sightings`, drops `geocode_candidates` |
| 008 | `008_gazetteer_geo_method.sql` | `node db/migrations/apply-008.mjs --yes` | `geo_method` value `catalog` → `gazetteer` |

Two data fixes, run once after the above and kept for the record:

- `backfill-landmarks.mjs` — re-ran stage 2b over already-flagged sightings
  after the landmarks import, resolving 64 of them.
- `add-webcam-gazetteer.mjs` — seeded gazetteer entries for the hydrophone and
  webcam sites.

Every runner reads `.env` from the repo root for `DATABASE_URL`, and each is
written to be safe to run twice.

## Two things that look wrong and are not

`001_init.sql` still creates `geocode_candidates`, which `007` then drops. That
is deliberate: these files are a replay of history, and `007` reads the table's
contents before dropping it. Rewriting `001` would break `007` on a database
that still has data to carry across.

**007 and 008 must be applied before deploying the code that expects them.**
007 adds columns the API selects (`ai_reasoning`); 008 renames a value the code
writes. Deploy first and `get-sightings` 500s on every request, or the database
ends up holding both `catalog` and `gazetteer` rows with the old ones invisible.

`backfill-landmarks.mjs` writes to `geocode_candidates` and will therefore fail
if run after `007`. It has already done its job (64 sightings) and is kept as
the record of it. Do not re-run it.
