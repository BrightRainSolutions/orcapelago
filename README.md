# Orcapelago

A public PWA that maps whale sightings from [Orca Network](https://www.orcanetwork.org/) newsletters. Newsletter text is pasted in by an admin, an AI extraction pipeline turns it into structured sighting records, a growing location catalog resolves named Salish Sea locations to coordinates, and the results render on a MapLibre map.

A Bright Rain Solutions portfolio project. Public and read-only for visitors; ingestion is admin-only. The data is historical by nature — the source is a digest published days-to-weeks after the fact.

Full specification: [design/orcapelago-spec.md](design/orcapelago-spec.md)

## Stack

Vue 3 + Vite (PWA) · MapLibre GL JS · OpenFreeMap Liberty basemap + Seascape bathymetry · Netlify (static + functions, ingest as a Background Function) · Neon Postgres · Anthropic API (`claude-sonnet-4-6`).

The basemap is isolated in [src/map/basemap.js](src/map/basemap.js); both the basemap and bathymetry can later be swapped to self-hosted PMTiles by changing that one file.

## Project tree

```
design/                     spec + raw newsletter source material
docs/sightings-newsletters/ newsletter source text (July 15 + July 29, 2026)
db/                         migrations + gazetteer seed SQL
lib/                        shared server logic (pure where possible, unit-testable)
  preprocess.js               strip boilerplate, detect SUMMARY, chunk on headers
  extract.js                  Claude extraction per chunk + dedupe
  geocode.js                  GPS → catalog → AI batch → candidates chain
  gps-parse.js                embedded coordinate formats
  prompts.js                  extraction + geocoding prompt templates
  db.js / auth.js             Neon client, X-Admin-Token check
netlify/functions/          API endpoints (see netlify.toml for /api/* routing)
src/                        Vue app: map, sightings table, about, admin
tests/                      vitest — preprocessing + GPS parsing, no API calls
```

## Working inside Dropbox (multi-machine dev)

This repo deliberately lives in Dropbox so development hops between machines. Machine-local folders (`node_modules`, `dist`, `dev-dist`, `.netlify`) must be excluded from sync per machine, or Dropbox locks files mid-write and Vite fails with EBUSY.

**First time on a new machine:** run `scripts/dev-setup.ps1` (Windows) or `scripts/dev-setup.sh` (macOS). It marks those folders Dropbox-ignored (a per-machine attribute), clears Vite's dep cache, and runs `npm install`.

**When switching machines:**
1. Stop dev servers, let Dropbox finish syncing on the machine you're leaving.
2. On the new machine, wait for Dropbox to settle before running git or npm.
3. `.env` is gitignored but *not* Dropbox-ignored — secrets follow you automatically.
4. Any EBUSY error later → re-run the setup script.

Note: `.git` syncs through Dropbox too, which is fine for one person working one machine at a time with sync settled. Once the repo has a GitHub remote, that becomes the safer transport for repo state.

## Setup

1. `npm install` (or the per-machine script above)
2. Create a Neon project; run `db/migrations/001_init.sql`, then `db/seed-gazetteer.sql` (verify seed coordinates first).
3. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`.
4. `npm run dev` (Netlify Dev: Vite + functions), or `npm run dev:vite` for frontend only.
5. `npm test`

## Ingesting a newsletter

Ingest runs from the CLI, not the admin paste box. A real newsletter takes
longer than Netlify's 15-minute background-function ceiling, so the deployed
Ingest tab cannot finish one. `run-ingest.mjs` has no such limit and runs the
identical code path.

1. **Save the text** to `docs/sightings-newsletters/YYYY-MM-DD-whale-sighting-report.txt`.

2. **Put the publication date alone on its own line at the top** — `July 29, 2026`,
   nothing else on that line, within the first 10 lines. Without it the ingest
   aborts. Section headers (`Fri, Jul 10 - Puget Sound`) carry no year and
   borrow it from this date.

3. **Dry-run it.** Free — no API calls, no database, no `.env`:

   ```
   node scripts/dry-run.mjs docs/sightings-newsletters/2026-07-29-whale-sighting-report.txt
   ```

   It **exits non-zero** if the ingest would abort (no publication date, no
   sections) *or* would appear to succeed while misfiling sightings. Confirm
   the date parsed and that every species section you expect shows under
   BANNERS RECOGNISED.

   The misfiling case is the one to respect. An unrecognised ALL-CAPS banner
   raises no error during ingest — its sightings are swallowed into the
   *preceding* section and stored under the wrong species, so you get rows that
   are present but wrong. Add new banners to `SPECIES_BANNERS` in
   `lib/preprocess.js`. A genuinely new species also needs a key in
   `SPECIES_KEYS` (`lib/extract.js`), the allowed list in `lib/prompts.js`, and
   a label + colour in `src/map/species.js`.

   The `detection_methods` vocabulary (`visual | hydrophone | webcam`) has the
   same shape on a smaller scale: described in `lib/prompts.js`, enforced in
   `DETECTION_METHODS` (`lib/extract.js`), badged in
   `src/components/SightingPanel.vue`.

   Ingest carries the same guard: unrecognised banners and any species the
   model returns outside the vocabulary both land in the newsletter's
   `error_message`, visible in the admin Notes column.

4. **Ingest**:

   ```
   node scripts/run-ingest.mjs docs/sightings-newsletters/2026-07-29-whale-sighting-report.txt
   ```

   Each phase logs with elapsed time — per-chunk extraction progress, then
   geocoding, then the insert. Expect minutes: the dry-run's chunk count is the
   number of Claude calls, three of which run concurrently.

   It refuses, before making any API call, if a newsletter with the same
   publication date is already `complete` or `processing` — the latter is what
   stops a second launch while one is still running. Every invocation mints a
   fresh UUID, so without that guard a re-run silently creates a duplicate
   newsletter and several hundred duplicate sightings. Pass `--force` only when
   you genuinely intend a second copy.

5. **Resolve locations** at `/admin`:
   - **Catalog first.** Pending candidates are ordered by `hit_count`, and each
     Promote backfills every flagged sighting sharing that raw text — it drains
     the review queue underneath you.
   - **Review queue second**, for what remains. Click-placing on the mini-map
     sets `geo_method='manual'`.

Sightings are inserted only after extraction *and* geocoding both finish, so a
failed or hung run leaves nothing half-written:

```sql
delete from newsletters where status in ('failed', 'processing');
```

That cascades to any sightings the run did write. Don't run it while an ingest
is genuinely in flight.

## Landmarks (GNIS reference layer)

Authoritative marine features (USGS GNIS) live in the `landmarks` table —
distinct from the gazetteer, which is a geocoding cache keyed on reporter
text. They feed a free geocoding stage after the gazetteer and anchor-seed
the AI geocoding prompt. To refresh or extend (new state file, updated data):

```
node scripts/import-landmarks.mjs path/to/DomesticNames_WA.txt prod
```

Idempotent on `gnis_id`. Class list and bbox live at the top of the script;
GNIS quirks (passages file under Bay, reefs under Bar, no Harbor class) are
documented in [docs/architecture.md](docs/architecture.md) §12. Canadian
features (CGNDB) are v2, `source='cgndb'`.

## Build order (spec §9)

1. ~~Schema + seed~~ (files in `db/`)
2. `get-sightings` + `get-newsletters` against seed data
3. Map view: clustering, popups, filters (fake data first)
4. Ingest background function: pre-process + chunking, tested against the fixture
5. Extraction prompt + parsing + persistence
6. Geocoding chain
7. Admin UI: paste, status polling, review queue, catalog editor
8. About page, PWA polish, attribution
9. Deploy: Netlify + Neon production
