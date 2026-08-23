# Orcapelago — Architecture & Decision Record

Companion to [design/orcapelago-spec.md](../design/orcapelago-spec.md). The spec says
*what* to build; this says *how it was built and why*. It exists because the
reasoning behind several choices is not recoverable from reading the code — the
code shows the shape, not the constraint that forced it.

Written 2026-08-14, reconstructed from the codebase and the live database.

---

## 1. Runtime topology

Two runtimes. No server process, no container, no session store, no background
worker pool.

```
┌─────────────────────────────────────────────────────────┐
│  BROWSER — Vue 3 SPA (static build in dist/)            │
│  MapView · SightingsView · AboutView · AdminView        │
│      │  src/api/client.js  →  fetch('/api/…')           │
└──────┼──────────────────────────────────────────────────┘
       │  same origin; netlify.toml rewrites /api/* → functions
┌──────▼──────────────────────────────────────────────────┐
│  NETLIFY FUNCTIONS — Node, stateless, per-request       │
│                                                          │
│  PUBLIC          get-sightings · get-newsletters         │
│                  gazetteer (GET only)                    │
│  ADMIN           gazetteer (POST/PATCH/DELETE) ·         │
│                  geocode-candidates · sightings-admin ·  │
│                  get-ingest-status                       │
│  BACKGROUND      ingest-newsletter-background (15 min)   │
│      │                              │                    │
│      │ lib/db.js (neon over HTTP)   │ Anthropic SDK      │
└──────┼──────────────────────────────┼───────────────────┘
       ▼                              ▼
  Neon Postgres                 Anthropic API
  (scale-to-zero)               claude-sonnet-4-6
```

The browser also talks directly to two unauthenticated tile services:
**OpenFreeMap** (Liberty basemap) and **tiles.openwaters.io** (Seascape
bathymetry). Neither needs a key.

**Why serverless + Postgres and nothing else:** spec §1 sets a ~$0/month cost
ceiling. Every layer sits on a free tier, and the only metered spend is
Anthropic API calls — a few dollars a year at newsletter volume. Neon's
scale-to-zero costs nothing when idle; the ~500ms cold start is acceptable for a
historical dataset nobody refreshes in real time.

---

## 2. Request paths

### A · Public read (no auth)

```
MapView.onMounted
  → fetchSightings()                    src/api/sightings.js
  → GET /api/sightings?from&to&species  netlify/functions/get-sightings.mjs
  → one parameterized query             lib/db.js → Neon
  → GeoJSON FeatureCollection
  → MapLibre clustered source
```

Cached `public, max-age=300, stale-while-revalidate=600`. Default output is
GeoJSON with unresolved sightings **excluded** (they have no coordinates and
would be invalid features); `?format=json` returns plain rows and **includes**
them, which is what the admin review queue consumes.

If the API is unreachable, `fetchSightings` silently falls back to
`src/dev/fake-sightings.js` and the map shows a **"demo data"** badge. This is
why the frontend was fully workable before the database existed (spec §9 build
order deliberately puts the map at step 3, before ingest at step 4).

### B · Admin ingest (token)

```
Paste in IngestPanel
  → client generates crypto.randomUUID()
  → POST /api/ingest { id, text, title? }   → 202 immediately
  → poll /api/ingest-status?id= every 5s until complete | failed
```

**The client invents the ID, and that is not a stylistic choice.** Netlify
background functions discard the response body, so the server *cannot* return a
generated row ID. The client must supply one up front or it has nothing to poll
on. This single platform constraint shapes the entire ingest API surface. See
the header comment in `netlify/functions/ingest-newsletter-background.mjs`.

Why a background function at all: extraction over a full newsletter takes
minutes, far past the 10s ceiling on a regular function. Background functions
return 202 and run up to 15 minutes.

### Update 2026-08-16 — ingest moved to the CLI

A real newsletter exceeds that 15-minute ceiling. A July 29 run passed 22
minutes still inside extraction, and eventually hung outright. The failure mode
when the platform kills a background function is worse than slow: the process
dies *outside* the `catch`, so `status='failed'` is never written. The row sits
at `processing` forever and `IngestPanel` — which polls every 5s with no
timeout — spins indefinitely showing no error.

Ingest therefore runs through `scripts/run-ingest.mjs`, which has no ceiling and
executes the identical code path (same auth check, preprocess, extract, geocode,
persist). The paste box still works and is left in place, but is not the
supported path for a full newsletter. The review queue and gazetteer are ordinary
fast functions and are unaffected — they stay in the browser.

This also retires the two constraints that shaped the ingest API: the
`-background` suffix and the client-generated UUID both exist only to serve a
deployed paste box. They're harmless where they are, but nothing depends on
them anymore.

**Always dry-run first:** `node scripts/dry-run.mjs <file>` is pure and free,
and catches the silent failure described in §3 stage 1. See the README runbook.

---

## 3. The ingest pipeline

Four stages inside `ingest-newsletter-background.mjs`.

### Stage 1 · Preprocess — `lib/preprocess.js`

Pure functions, zero API calls, the only part of the pipeline under unit test
(`tests/preprocess.test.js`). It:

1. Normalizes unicode (zero-width chars, non-breaking spaces, CRLF).
2. Cuts everything from the boilerplate footer (`ABOUT ORCA NETWORK`) onward.
3. Finds ALL-CAPS species banners (`SOUTHERN RESIDENTS`, `BIGG'S KILLER
   WHALES`, …) and maps each to a species key.
4. Extracts the `SUMMARY` block.
5. Within each species section, finds date/location headers like
   `Thu, Jul 9 - Puget Sound (T65A5)`.
6. Packs whole header-sections into chunks of **≤12,000 characters**, splitting
   an oversized section only at lone `-` report separators.

**Why 12,000 chars — sized from the output side, not the input.** A dense chunk
yields roughly one sighting per 200 input chars, and each sighting costs ~150
output tokens. So 12K chars ≈ 60 sightings ≈ 9K output tokens, comfortably
inside the 32K `max_tokens` extraction ceiling. A 24K-char chunk overflowed 16K
in testing. The constraint is the model's output budget; the input size is
merely the lever.

**Why chunks carry a `carriedHeader`.** Newsletter headers own everything below
them until the next header. If a section is split mid-way, chunk 2+ loses the
date and water body it inherits — so the header is passed forward explicitly and
injected into the prompt as "this text is a continuation under…".

**The sharpest failure mode in the whole pipeline: an unrecognised banner.**
Sections are delimited by ALL-CAPS species banners matched against
`SPECIES_BANNERS`. A banner that isn't in that list is not seen as a section
start — so its content is swallowed into the *preceding* section and extracted
under that section's species. Nothing errors. Nothing warns. You get rows that
are present but wrong, which is far harder to notice than rows that are missing.

This was live: the July 29, 2026 issue introduced `NORTHERN RESIDENT KILLER
WHALES` and `DOLPHINS`. The dolphin section — 3,406 characters across 5 date
headers — was being handed to Claude under the `UNIDENTIFIED BALEEN WHALES`
banner and would have been stored as `unidentified_baleen`. Adding a species
means four coordinated edits: `SPECIES_BANNERS` here, `SPECIES_KEYS` in
`extract.js`, the allowed list in `prompts.js`, and label/colour in
`src/map/species.js`. No migration — `species` is free text.

`scripts/dry-run.mjs` exists specifically to surface this before an ingest.

### Stage 2 · Extract — `lib/extract.js`

One Claude call per chunk, **3 concurrent**, `max_tokens: 32000`, strict JSON
array out. Then:

- `normalizeSighting` validates and coerces every field, dropping rows without a
  valid ISO date or a `location_raw` and recording *why* in `warnings`.
- `dedupeSightings` collapses duplicates across chunk boundaries on
  `date | time | location_raw`.

**Why it streams.** Not for UI feedback — the SDK *rejects* non-streaming
requests at that `max_tokens`. `.finalMessage()` returns the same shape a
non-streaming call would.

**Why truncation is survivable.** `salvageTruncatedArray` trims a response cut
off at `max_tokens` back to the last complete object and closes the array. A
truncated chunk therefore yields partial results plus a warning rather than
failing the whole ingest. Same fallback runs on malformed JSON.

**Why one bad chunk doesn't abort.** Each chunk's failure is captured as a
warning and skipped. Only *zero total sightings* fails the ingest. Warnings are
stitched into `newsletters.error_message` even on success — so `status =
'complete'` with a populated `error_message` is a normal, meaningful state.

### Stage 3 · Geocode — `lib/geocode.js`

See §5 below.

### Stage 4 · Persist

Insert sightings, then set `status='complete'` with `sighting_count`, or
`'failed'` with `error_message`.

---

## 4. Where we use the Anthropic API — and where we deliberately don't

**The rule: AI runs only where the input is unstructured human prose and the
output is structured data. Everything mechanical is deterministic code.**

There are exactly **two** call sites in the whole system.

| Call site | Input | Output | Model |
|---|---|---|---|
| `lib/extract.js` | one newsletter chunk (prose) | array of sighting records | `claude-sonnet-4-6` |
| `lib/geocode.js` | up to 60 location strings | coordinates + confidence | `claude-sonnet-4-6` |

Both prompts live in `lib/prompts.js`, along with the `MODEL` constant — one
place to change the model.

### What is deliberately NOT AI

- **Chunking and header parsing** (`preprocess.js`) — the newsletter has a
  reliable, repeating structure. Regex and line scanning are free, instant,
  deterministic, and unit-testable. Sending this to a model would cost money to
  do a worse job.
- **GPS extraction** (`gps-parse.js`) — eight observed coordinate formats, all
  regular. Handled by four regexes with a Salish Sea bounds check so stray
  number pairs (times, counts) can never parse as coordinates.
- **Catalog lookup** (`geocode.js` stage 2) — exact match, alias match, then
  Postgres `pg_trgm` similarity. Free and instant.
- **Dedupe, validation, coercion** — plain code.

### Why the ordering matters

The geocoding chain runs **cheapest-first**: free deterministic stages exhaust
themselves before anything is billed. AI sees only what genuinely requires
judgment. This is the cost ceiling in mechanical form.

### Why the two call sites parallelize differently

- **Extraction is parallel-by-chunk** (concurrency 3). Each input is large, so
  batching inputs is impossible — you parallelize the calls instead.
- **Geocoding is batched-by-payload** (60 locations per call, sequential loop).
  Each input is a short string, so per-call overhead dominates. Batching 60
  amortizes it, and at ~80 output tokens per item the response stays well under
  `max_tokens: 8000`.

Same API, opposite strategies, for opposite reasons.

### The trust model

Every AI output is treated as **provisional**:

- Extraction output is validated and coerced by `normalizeSighting`; anything
  unsupportable is dropped, not trusted.
- Geocoding output is bounds-checked (`inBounds`), and results are written with
  `geo_method='ai'` and `needs_review=true`.
- `geo_method` is a permanent provenance record on every sighting — `gps`,
  `catalog`, `ai`, `manual`, or `unresolved` — so you can always ask "how did
  this coordinate get here?"

Human promotion is what converts probabilistic output into deterministic data.
See §6.

### The cost curve

Extraction cost is roughly **fixed** per newsletter. Geocoding cost **decays
toward zero** as the gazetteer grows, because stage 2 absorbs more of the work on
every subsequent ingest. That decay is the entire economic argument for the
learning loop.

---

## 5. The geocoding chain

Applied per sighting, in `lib/geocode.js`. Four stages, first hit wins.

| # | Stage | Mechanism | `geo_method` | `needs_review` | Cost |
|---|---|---|---|---|---|
| 1 | GPS in report | model-reported coords (bounds-checked), then our own `parseGps` of `location_raw` and `raw_excerpt` | `gps` | false | free |
| 2 | Gazetteer | exact name → alias → `pg_trgm` similarity ≥ 0.4 with ≥ 0.1 margin over runner-up | `catalog` | false | free |
| 2b | Landmarks (GNIS) | **unique exact** name match only — duplicates and fuzzy fall through to anchored AI (no trigram threshold separates "Pt Robinson"→Point Robinson 0.588 from "Active Pass"→Active Cove 0.438, 25km wrong) | `landmark` | false | free |
| 3 | Claude | batched 60 per call, `inBounds` checked; prompt seeded with anchor landmarks named in the batch | `ai` | **true** | billed |
| 4 | Nothing worked | — | `unresolved` | **true** | free |

Stage 2 runs **once per distinct `location_raw`**, not once per sighting — the
same place name recurs constantly within a newsletter.

**Why the fuzzy match demands a margin.** A trigram score ≥ 0.4 alone isn't
enough; the code also requires the top hit to beat the runner-up by ≥ 0.1. Two
near-equal matches mean the string is ambiguous, and guessing wrong writes a
confidently incorrect coordinate that nothing downstream would flag. Ambiguity
falls through to AI, which sets `needs_review`. *Consequence: duplicate
gazetteer names silently defeat stage 2 forever — two "Bush Point" rows always
tie, always fall through, always cost money.*

**Why an LLM instead of a real geocoder.** The inputs are informal, hyper-local,
and often relational: *"Just off Blakely Rock with the sailboat"*, *"mid-channel
off Bush Point"*, *"north end of Saratoga Passage"*. Google/Mapbox/Nominatim
resolve street addresses and official place names — they fail on whale-watcher
shorthand, and when they do resolve something they happily return a point on
land. The prompt in `lib/prompts.js` does two things no conventional geocoder
can: it establishes Salish Sea domain framing (points, passages, parks, ferry
routes, informal landmarks), and it demands the coordinate be placed **on the
water adjacent to the named feature**. It also returns a `confidence` field and
its reasoning, both stored on the candidate for human review.

**Why stage 3 failures are non-fatal.** The whole AI block is wrapped in a
try/catch that records a warning and leaves those sightings `unresolved`. The
ingest still completes; the locations land in the review queue.

---

## 6. The learning loop

This is the project's thesis (spec §1: *"the catalog gets smarter over time"*)
and the reason there is no big upfront gazetteer.

```
AI-geocoded sighting  → geo_method='ai', needs_review=true
                      → row in geocode_candidates
                        (hit_count++ on repeat sightings of the same raw text)
                      → admin promotes it
                      → gazetteer row, source='ai_promoted'
                      → next ingest resolves it at stage 2 — free, instant
```

**`hit_count` = how many flagged sightings a promote would fix.** Candidates are
served ordered by `hit_count desc`, so the top of the queue is the highest-
leverage work. A queue of 800 candidates is not 800 units of work — a small
number of locations absorb a disproportionate share of the sightings.

That is only true because of a fix on 2026-08-17. `upsertCandidate` originally
incremented by **one per ingest run**, since it is called once per *distinct
location*, not once per sighting. So the number counted newsletters, not
sightings, and the ordering was wrong in the way that mattered: a location with
five flagged sightings sorted below one with a single sighting. It now
increments by the size of the sighting group. If you ever need to rebuild the
column from scratch:

```sql
update geocode_candidates c
set hit_count = (
  select count(*) from sightings s
  where s.location_raw = c.location_raw and s.needs_review
)
where c.status = 'pending';
```

**Candidates outlive the sightings that created them.** `geocode_candidates` has
no FK to `newsletters`, so deleting a newsletter leaves its candidates behind.
They become unpromotable noise — a promote backfills nothing. Clear them with:

```sql
delete from geocode_candidates c
where c.status = 'pending'
  and not exists (select 1 from sightings s where s.location_raw = c.location_raw);
```

### Two promotion paths (they are not equivalent)

1. **`CatalogPanel` → `POST /api/geocode-candidates/:id/promote`** — the bulk
   path. Creates the gazetteer entry (`source='ai_promoted'`) **and backfills
   every flagged sighting sharing that exact `location_raw`** — setting them to
   `geo_method='catalog'`, `needs_review=false` — in one statement. Returns the
   backfill count. *Use this one.*

2. **`ReviewQueue` → "Save & add to gazetteer"** — the per-sighting path. Works
   from a flagged *sighting*, creates a `source='manual'` gazetteer entry, and
   patches **only that one sighting**. Right for one-off corrections and
   mini-map click placement (`geo_method='manual'`); wrong for clearing a large
   queue.

The distinction matters operationally: path 1 can clear dozens of sightings per
click, path 2 clears exactly one.

---

## 7. Data model notes

Four tables (`db/migrations/001_init.sql`). Full column definitions are in
spec §4; only the non-obvious parts are here.

- `newsletters` 1 → N `sightings`, `on delete cascade`. Deleting a newsletter
  removes its sightings — the intended re-ingest path.
- `sightings.gazetteer_id` is a **nullable** FK. Deleting a gazetteer entry nulls
  the link but *keeps the coordinates* (see `gazetteer.mjs` DELETE) — a sighting
  never silently loses its position because of gazetteer editing.
- `geocode_candidates` is a standalone work queue, not joined to anything. It
  keys on `location_raw` text, which is why `upsertCandidate` dedupes on that
  column rather than an ID.
- `date_range` is a Postgres `daterange`, written as `[from,to]` and read back
  with `upper(date_range) - 1` because the upper bound is exclusive.

**Migrations are manual.** No Drizzle, no Prisma, no runner. You apply
`001_init.sql` by hand in the Neon console or psql; schema changes mean writing
`002_*.sql` and remembering to run it. Neither the schema file nor the seed file
is idempotent — `create table` (not `if not exists`), and the seed is a bare
`insert` with no `on conflict`.

**The data layer is 9 lines.** `lib/db.js` returns `neon(DATABASE_URL)`. No ORM,
no query builder. Queries are tagged templates, so `${x}` is a **bind
parameter**, not string interpolation — it looks alarming and is safe. The
driver is HTTP-based, not TCP, which is why `getSql()` can be called fresh per
request with no pooling and nothing to leak. It also accepts only **one
statement per call** — hence the `runRaw` shim in `scripts/check-db.mjs` for
pushing the multi-statement seed file through.

**The null-guard query pattern.** Every optional filter in `get-sightings.mjs`
is written as `(${param}::date is null or column >= ${param}::date)`. One static
query serves every combination of `from`/`to`/`species`/`bbox`/`needs_review`,
so there is no dynamic SQL assembly anywhere in the codebase. The `::type` casts
are required because a bound `null` arrives untyped. Preserve this pattern when
adding filters.

---

## 8. Auth

A single shared secret (`ADMIN_TOKEN`) sent as the `X-Admin-Token` header. No
user accounts, no sessions — spec §2.

`lib/auth.js` `isAdmin(req)` is the **only** real enforcement, called at the top
of every admin function. The client-side gate in `AdminView` is convenience
only: `validateAdminToken()` simply calls `/api/geocode-candidates` and checks
whether it gets a 401. The token lives in `localStorage`.

`gazetteer.mjs` is method-aware — `GET` is public, everything else calls
`isAdmin` — because Netlify redirects can't split HTTP methods across functions.

---

## 9. Basemap

All basemap concerns are isolated in `src/map/basemap.js`; the rest of the app
never knows what's underneath (spec §3).

It fetches the OpenFreeMap Liberty style JSON, then splices Seascape's **vector
contour layers only** in at the index of the first `symbol` layer — so
bathymetry renders above Liberty's water fill but below its place labels. It
overrides Seascape's default font to `Noto Sans Regular` because Liberty's glyph
endpoint serves Noto, not Open Sans.

**It always falls back.** Any failure — style fetch, composition, unreachable
tiles — returns the plain Liberty style URL and logs a warning. The map must
never be blank because bathymetry broke.

**Escape hatch:** both basemap and bathymetry can move to self-hosted PMTiles
served as Netlify static assets via the `pmtiles` protocol adapter. The module
boundary makes that a change to this one file.

---

## 10. Decisions you can't recover from the code

Collected for convenience — each is explained in context above.

1. **The client generates the newsletter UUID** because background functions
   discard the response body. (§2B)
2. **Chunk size was derived from the output token budget**, not input size. (§3)
3. **Extraction streams because the SDK rejects non-streaming at 32K
   `max_tokens`** — not for UI streaming. (§3)
4. **The client admin gate is cosmetic**; all enforcement is server-side. (§8)
5. **The fuzzy-match margin exists to make ambiguity fall through to AI**
   rather than guess. (§5)
6. **An LLM geocoder was chosen over a conventional one** because the inputs are
   informal landmarks and the output must land on water. (§5)
7. **`status='complete'` with a non-null `error_message`** is normal — that's
   how per-chunk warnings surface. (§3)

---

## 11. Known rough edges

- **N+1 inserts.** Persistence loops one `INSERT` per sighting over an HTTP
  driver — a 400-sighting newsletter is 400 sequential round trips. Inside the
  15-minute budget, but a single multi-row insert is the obvious first
  optimization.
- **The first insert sits outside the try/catch.** In
  `ingest-newsletter-background.mjs`, `insert into newsletters` runs *before*
  the error handler. If it throws (missing table, bad `DATABASE_URL`), no row is
  written, so the admin UI polls `/api/ingest-status` forever getting 404s —
  which `IngestPanel` reads as "still starting". A hung spinner instead of an
  error.
- **Seed coordinates are unverified.** `db/seed-gazetteer.sql` carries its own
  TODO: check each against a chart before trusting production.
- **PWA icons don't exist.** `vite.config.js` points the manifest at
  `/icons/icon-192.png` and `/icons/icon-512.png`; there is no `public/`
  directory.
- **`.env` points at the Neon `production` branch**, so local scripts write to
  production. Neon branching gives you a disposable copy-on-write clone — worth
  using before test ingests.

---

## 12. Roadmap

Deliberately deferred, with the reasoning, so it isn't rediscovered from scratch.

**Detection method on sightings.** Orca Network reports mix on-scene visual
sightings with hydrophone and webcam detections — the whole 2026-08-02 Southern
Resident encounter was acoustic, heard on the Lime Kiln and Andrews Bay
hydrophones. Those aren't the same kind of observation: an acoustic fix is the
location of the *sensor*, not of the animal, yet it currently claims the same
precision as "I watched them from the shore".

Shape: `alter table sightings add column detection_methods text[] not null
default '{}'` — array-valued, because "Lime Kiln hydrophone and webcam" is
genuinely both, matching how `behaviors` and `individual_ids` already work.
Then vocabulary in `prompts.js`, validation in `extract.js`, the column in the
ingest INSERT and in `get-sightings`, and a badge in `SightingPanel`.

Note this is a different axis from `report_kind`, which records the
newsletter's *format* (timestamped / form_submission / header_summary).

**Update 2026-08-19 — implemented.** Migration `002_detection_methods.sql`;
vocabulary `visual | hydrophone | webcam`, described in `prompts.js` and
enforced in `extract.js` (`DETECTION_METHODS`, out-of-vocabulary values
dropped with a warning); column carried through the ingest INSERT and
`get-sightings`. `SightingPanel` badges only the sensor-based methods —
`visual` is the norm and stays unbadged; the hydrophone badge's tooltip
carries the sensor-not-animal caveat. History left empty as planned.

**It cannot be backfilled.** Only 9 of 1,331 existing rows mention a hydrophone
or webcam in `raw_excerpt`, because that field is capped at 400–600 characters
and the model chooses what to include — the modality mostly didn't survive
into storage. Populating history would mean re-ingesting all three newsletters:
~40 chunks, on the order of 600K output tokens, and because extraction is not
deterministic the existing counts would shift (the same July 29 file yielded
384, 574 and 549 across three runs). Let history stay empty; populate forward.

**A curated landmarks layer.**

The map labels water bodies (Salish Sea, Saratoga Passage) from OpenStreetMap
via the basemap, and nothing below that. The features that actually matter to
this dataset are invisible: Hidden Beach on the Saratoga Passage shore of
Whidbey (the east side — an earlier draft of this doc said west, wrongly), the
beds in Saratoga Passage where gray whales feed. These are hotspots of whale activity, known to
the people who watch these waters, and no general-purpose basemap will ever
carry them because they are not "places" in the OSM sense.

Two routes were investigated on 2026-08-18 and both rejected:

- **Borrowing Liberty's POI layers into positron.** They transplant cleanly, but
  the OpenMapTiles `poi` layer is amenity data (cafés, shops, parking) gated to
  `minzoom` 15–16. Coffee shops at street zoom, not shoreline features.
- **Labelling from the gazetteer.** It looks appealing because the catalogue
  grows as candidates are promoted, but it conflates two different things. The
  gazetteer is a *geocoding cache* keyed on whatever text a reporter typed, not
  a place catalogue. Measured against the live queue: of 1,092 pending
  candidates, **863 (79%) are positional descriptions** ("west side of San Juan
  Island", "past the buoy from Bangor, closer to Quilcene side") rather than
  names. Of the 229 real names, most are features OSM already knows. And the
  11 existing gazetteer rows are hand-seeded with their own unverified TODO.

**The route that would work is GNIS**, the USGS Geographic Names Information
System — the federal gazetteer, downloadable per state, carrying exactly the
feature classes needed: Bay, Beach, Cape, Channel, Cove, Harbor, Island, Point,
Reef, Bar, Narrows. Authoritative names with coordinates, already verified.

**And the bigger prize is geocoding, not labels.** Seeding those features into
the *gazetteer* would let stage 2 (gazetteer lookup, free and instant) resolve
locations that currently fall through to a paid AI call and land in the review
queue. Penn Cove, Holmes Harbor, Active Pass, Thatcher Pass, San Juan Channel,
Port Susan, Bellingham Bay — all textbook GNIS features, all sitting unresolved
in the queue today. The label layer is the second-order benefit of the same
seed.

Two constraints:

- **GNIS is US-only.** The Salish Sea spans the border, and the data already
  contains Active Pass, Porlier Pass, Johnstone Strait and Port Hardy. Full
  coverage needs the Canadian Geographical Names Database (Natural Resources
  Canada) as well.
- **Filtering is the work.** GNIS carries every school, church and cemetery in
  the state. Marine feature classes clipped to a Salish Sea bounding box turns a
  huge national file into a few hundred rows worth having.

GNIS gives a point per feature, which suits beaches and points but is a rough
anchor for linear features like passages and channels. Hand-curation still has a
place on top of it, for hotspots that are known locally but unnamed federally.

Design constraints to settle when building it: labels must sit *below* the
sighting layers with `text-allow-overlap: false` so markers always win a
collision, and density needs to be zoom-dependent or a few dozen labels will
bury the data they exist to contextualise.

**This is also the first real use for a Neon dev branch.** A schema change is
the one case where rehearsing against a throwaway copy clearly beats running
DDL straight at production. See §11.

**Update 2026-08-19 — landmarks implemented** (migration `003_landmarks.sql`,
`scripts/import-landmarks.mjs`). Profiling the real `DomesticNames_WA` file
corrected the roadmap's assumed class list: GNIS files passages, sounds, and
harbors under **Bay** (Puget Sound itself is class Bay), reefs and shoals
under **Bar**, and points/heads under **Cape**; there is no Reef, Shoal, or
Harbor class, and Channel holds only Duwamish waterways. Imported classes:
Bay, Cape, Island, Bar, Beach, Cliff, Pillar, Gut, Channel, Sea (~1,500 rows
in the spec bbox). `Populated Place` deliberately excluded — inland centroids
that would geocode sightings ashore. Landmarks are stored exactly where GNIS
puts them, **including on land** — Hidden Beach and the bluffs are the whole
point; only *sighting placement* cares about water, and shoreline-class
points sit at the waterline anyway.

**First manual landmark, 2026-08-20.** Hidden Beach is a significant hotspot
and is NOT in GNIS. Added with `source='manual'`, `gnis_id=null`, at
48.1289, -122.5628 — Washington DOH's shellfish-safety map publishes an
explicit "Middle of Beach" coordinate for it, which is a state agency source
rather than a guess.

Why it mattered: 17 distinct phrasings across 18 sightings, and the AI had
placed them across ~18 km. Strings mentioning Saratoga Passage landed 4.5 km
too far east; bare ones landed 8 km south. Nothing resolves it by exact match,
so `landmarkLookup` and the backfill do not touch those rows — the fix is
**anchor seeding**, which covers all 17 because `pickAnchors` matches on
substring. Existing rows stay wrong until re-ingested or corrected by hand.

Two open threads it creates: the row is `feature_class='Beach'`, so it renders
only in `landmarks-minor` at minzoom 13 despite being one of the more important
features on the map — an argument for a prominence column rather than leaning
on GNIS class for label banding. And if the Board on Geographic Names accepts a
submission for it, re-importing would produce a second row, since
`import-landmarks.mjs` dedupes on `gnis_id` alone and this row has none.

Geocoding integration: a free landmark stage after the gazetteer (same
exact/trigram discipline, `geo_method='landmark'`, `landmark_id` provenance
FK), and AI geocoding now receives **anchor seeding** — landmarks whose names
appear in the batch's location strings are injected into the prompt with
their authoritative coordinates, so the model offsets from federal ground
truth instead of recalling coordinates from memory.

### Whale or whale-seer? (added 2026-08-19)

A sighting coordinate's *referent* varies by how it was derived, and the
schema does not currently say which:

| Derivation | The coordinate is… |
|---|---|
| AI on relational text ("half mile north of Protection Island") | the whale, inferred |
| catalog/landmark hit ("off Hidden Beach") | the named feature (≈ the seer, for shore reports) |
| GPS in report | ambiguous — boat marking the animals, or observer's phone pin |
| hydrophone detection | the sensor, definitively not the whale |

The deeper observation: conventional geocoding resolves *nouns*; whale
reports locate the animal with *prepositions* ("half a mile north of",
"mid-channel between", "200 yards off the Whidbey side"). Parsing relational
spatial language is the genuinely new capability the LLM adds — the
gazetteer provides the nouns, the model parses the prepositions.

**Review edits are `manual`, 2026-08-21.** Saving a review sets
`geo_method='manual'` whenever the coordinate differs from the loaded row —
map click, pin drag, or typing into the lat/lng fields alike. Adding the
location to the gazetteer in the same action sets `gazetteer_id` but does NOT
set `geo_method='catalog'`: the coordinate came from a person and the
gazetteer entry was created *from* it, so claiming a gazetteer lookup would
invert the provenance. Future sightings matching that name get `catalog`
honestly, at ingest. Accepting an AI position unchanged leaves `geo_method`
alone and only clears `needs_review` — reviewed-and-endorsed is not the same
as human-placed, and the schema should not blur them.

Deferred v2 shape, once anchor seeding proves out: have the model return a
structured inference — `{anchor: <landmark id>, bearing, distance_m}` — and
compute the coordinate deterministically. Positions become auditable and
recomputable: deterministic anchor, explicit offset, model only where
judgment lives. If the referent distinction ever deserves first-class
treatment, it's a small `position_refers_to` column
(`whale | observer | feature | sensor`) — but anchor-and-offset would make
whale-referent the norm, which is the better fix.

---

## 13. State as of 2026-08-14

Build order (spec §9) steps **1–7 complete**, verified against the live
database, not just written:

| Table | Rows |
|---|---|
| `newsletters` | 1 |
| `sightings` | 394 |
| `geocode_candidates` | 346 |
| `gazetteer` | 11 (10 seeded + 1 promoted) |

The pipeline has run end to end against the canonical fixture
(`docs/sightings-newsletters/2026-07-15-whale-sighting-report.txt`). The 346
candidates against 394 sightings reflect the intended cold start — 11 gazetteer
entries can't match much — and the review queue is now the bottleneck.

Since then: the sightings table view is built (with row → map deep linking via
`/?sighting=<id>`), ingest logs every phase with elapsed time, `scripts/dry-run.mjs`
pre-flights newsletters, and `northern_resident` was added as a species. The
repo is on GitHub at `BrightRainSolutions/orcapelago` (private).

*(Remaining-work list superseded by §14.)*

---

## 14. State as of 2026-08-19

| Table | Rows |
|---|---|
| `newsletters` | 3 (Jul 15, Jul 29, Aug 7 — all complete) |
| `sightings` | 1,331 (1,086 flagged for review) |
| `geocode_candidates` | 1,048 pending |
| `gazetteer` | 11 |
| `landmarks` | **1,509 (new)** |

Landed this session, in order:

1. **`detection_methods`** (migration 002) — vocabulary
   `visual | hydrophone | webcam`, wired through prompt → validation → INSERT
   → `get-sightings` → sensor-only badges in `SightingPanel`. History left
   empty by design; **populates from the next ingest onward** — the next
   newsletter (due ~Aug 21 on current cadence) is its first live test.
2. **Landmarks layer, database side** (migration 003 +
   `scripts/import-landmarks.mjs`) — 1,509 GNIS marine features imported,
   stage 2b in the geocoding chain (unique-exact only), anchor seeding into
   the AI prompt, and `scripts/backfill-landmarks.mjs` resolved 64 flagged
   sightings / retired 44 candidates retroactively. Full reasoning — the
   GNIS class surprises, the no-trigram decision, whale-vs-seer — is in §12's
   2026-08-19 updates and the §5 table.
3. **Neon branch workflow proven** — migrations 002/003 and the import were
   rehearsed on throwaway `dev` branches first; the rehearsals caught three
   real script bugs (a comment-swallowing SQL splitter twice, and GNIS's BOM)
   before production. `.env` gains `DEV_DATABASE_URL` when a branch exists —
   note branches auto-delete after 1 day, so a synced `.env` may carry a
   stale one; create a fresh branch per rehearsal.

**Remaining:**

- **Landmark labels on the map** — the second consumer of the landmarks
  table (`get-landmarks` endpoint → symbol layer below sightings,
  `text-allow-overlap: false`, zoom-gated by feature class). Next up.
- **CGNDB (Canadian names)** — promoted from nice-to-have by the Active Pass
  false-positive (§5): BC features can't resolve from US GNIS. Same table,
  `source='cgndb'`.
- Step 8 — `AboutView.vue` is still a stub. It carries the Orca Network
  attribution and donate link that spec §1 treats as non-negotiable, so it
  blocks any public deploy. PWA icons (`/icons/icon-192.png`, `icon-512.png`)
  don't exist (public/ has only the Orca Network logo).
- Step 9 — deploy. Nothing exists on Netlify yet. **Parked for deploy time**
  (decided 2026-08-19): split environments — local `.env` points at a
  standing dev branch, production string lives only in Netlify env vars, and
  `run-ingest.mjs` gets an explicit `--prod` guard so content publishing is
  always a stated intention.
- Work the candidate queue by `hit_count` via `CatalogPanel` (bulk backfill
  per promote); 1,048 pending after the landmark sweep.
- Known gap: no timeout on the per-chunk Anthropic call. A stalled request
  hangs the run indefinitely; phase logging makes it visible but does not cut
  it off.


## 15. Vocabulary, and the map → edit path (added 2026-08-21)

### "Catalog" is gone from the interface

The admin UI called one thing "Catalog" and it was standing in for two
different things, which is why it read as confusing:

| Term | What it is | Who makes it |
|---|---|---|
| **Candidate** (`geocode_candidates`) | a location string the AI had to guess at | the machine, at ingest |
| **Gazetteer entry** (`gazetteer`) | a verified place with a coordinate you stand behind | you |
| **Landmark** (`landmarks`) | a GNIS feature, imported wholesale | the USGS |

The one-line rule: **a candidate is made by the machine; a gazetteer entry is
made by you.** Confirming a place — by promoting a candidate, or by typing a
name into the review editor's optional field — is the act that moves knowledge
from the first column to the second. "Catalog" was never a fourth thing, and
every user-facing string now says candidate, gazetteer, or landmark.

**The stored value `geo_method='catalog'` is deliberately unchanged.** Renaming
it is a production data migration over ~46 rows plus the writers in
`lib/geocode.js`, and the label is only ever seen as a provenance badge. Left
as a known naming wart rather than a silent DDL change.

### Editing a sighting you found on the map

The review queue was the only way in, and it was addressed by *backlog
position*: to fix one wrong dot you had to find it among a thousand flagged
rows, and if it had already been reviewed it was not in the list at all. That
made bad coordinates on the public map effectively unfixable.

Sightings are now addressable by id:

- `SightingPanel` shows **Edit this sighting** when an admin token is present,
  linking to `/admin?tab=review&sighting=<id>`.
- `CandidatesPanel` gives each row a **Map** link to one of its sightings
  (`sample_sighting_id`, a subquery in `geocode-candidates.mjs`), so you can
  see where a candidate actually lands before promoting it. 1,046 of 1,048
  rows have one; the two without are candidates whose sightings were already
  cleared.
- `sightings-admin.mjs` gained **GET** for a single row. Necessary because the
  queue only ever loaded `needs_review = true`, and the whole point is opening
  rows that are *not* flagged.
- `ReviewQueue` takes an `openSightingId` prop: select it if it is already in
  the queue, otherwise fetch it and prepend it, tagged `opened` so it is not
  mistaken for backlog. `flaggedCount` counts only genuinely flagged rows, and
  the save button says "Save changes" rather than "Save & clear flag" when
  there is no flag to clear.

`location_raw` is now shown read-only above the edit fields. It is the key both
the gazetteer aliases and the candidate queue are matched on, so editing it in
place would silently detach the row from both.

### The CSS trap that hid every selected state (2026-08-21)

`.admin button` sets the filled black action-button style — `background:
var(--ink); color: #fff` — at specificity (0,1,1). Three pieces of chrome are
also `<button>`s, and each was styled at equal-or-lower specificity *earlier*
in the file, so the blanket rule won:

- **Review queue rows** (`.review-item`, 0,1,0) — every row rendered black on
  white text, so the selected row's `.active` painted black on black.
- **Admin tabs** (`.admin-tabs button`, 0,1,1 — equal, but earlier) — all four
  tabs rendered black, so the active tab was indistinguishable.
- **Panel close ×** (`.sp-close`, 0,1,0) — rendered as a solid black block.

Both selection bugs read as "selection isn't working" when the selection logic
was never at fault. Note the diagnostic trap: measuring the *selected* element
proves nothing, because black-on-black computes exactly as a working highlight
does. **Compare it against an unselected sibling.**

Fixed at the source rather than per-symptom: the action style now excludes that
chrome via `:not(:where(.admin-tabs button, .review-item, .sp-close))`.
`:where()` contributes zero specificity, so the rule stays (0,1,1) and no
existing button changes. Any future chrome button goes in that list — do not
answer it with a more specific override downstream, which is what buried it
twice.

One knock-on remains, unchanged for now: queue rows inherit `text-transform:
uppercase` from the same rule, which is why raw location strings are shouted.
It matches the visual language, so it stays until you decide otherwise.
