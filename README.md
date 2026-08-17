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

   Check three things: the date parsed; every species section you expect
   appears under BANNERS RECOGNISED; and nothing under UNRECOGNISED ALL-CAPS
   LINES names a species.

   That third check matters most. An unrecognised banner raises no error — its
   sightings are swallowed into the *preceding* section and extracted under the
   wrong species. Add new banners to `SPECIES_BANNERS` in `lib/preprocess.js`.
   A genuinely new species also needs a key in `SPECIES_KEYS` (`lib/extract.js`),
   the allowed list in `lib/prompts.js`, and a label + colour in
   `src/map/species.js`.

4. **Ingest**:

   ```
   node scripts/run-ingest.mjs docs/sightings-newsletters/2026-07-29-whale-sighting-report.txt
   ```

   Each phase logs with elapsed time — per-chunk extraction progress, then
   geocoding, then the insert. Expect minutes: the dry-run's chunk count is the
   number of Claude calls, three of which run concurrently.

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
