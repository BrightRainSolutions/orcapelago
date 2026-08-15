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
toward zero** as the catalog grows, because stage 2 absorbs more of the work on
every subsequent ingest. That decay is the entire economic argument for the
learning loop.

---

## 5. The geocoding chain

Applied per sighting, in `lib/geocode.js`. Four stages, first hit wins.

| # | Stage | Mechanism | `geo_method` | `needs_review` | Cost |
|---|---|---|---|---|---|
| 1 | GPS in report | model-reported coords (bounds-checked), then our own `parseGps` of `location_raw` and `raw_excerpt` | `gps` | false | free |
| 2 | Catalog | exact name → alias → `pg_trgm` similarity ≥ 0.4 with ≥ 0.1 margin over runner-up | `catalog` | false | free |
| 3 | Claude | batched 60 per call, `inBounds` checked | `ai` | **true** | billed |
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

**`hit_count` is the leverage metric.** Candidates are served ordered by
`hit_count desc`, so you promote the locations that actually recur first. A
queue of 300 candidates does not mean 300 units of work — a small number of
high-frequency locations absorb a disproportionate share of the sightings.

### Two promotion paths (they are not equivalent)

1. **`CatalogPanel` → `POST /api/geocode-candidates/:id/promote`** — the bulk
   path. Creates the gazetteer entry (`source='ai_promoted'`) **and backfills
   every flagged sighting sharing that exact `location_raw`** — setting them to
   `geo_method='catalog'`, `needs_review=false` — in one statement. Returns the
   backfill count. *Use this one.*

2. **`ReviewQueue` → "Save + add to catalog"** — the per-sighting path. Works
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
- `sightings.gazetteer_id` is a **nullable** FK. Deleting a catalog entry nulls
  the link but *keeps the coordinates* (see `gazetteer.mjs` DELETE) — a sighting
  never silently loses its position because of catalog editing.
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

## 12. State as of 2026-08-14

Build order (spec §9) steps **1–7 complete**, verified against the live
database, not just written:

| Table | Rows |
|---|---|
| `newsletters` | 1 |
| `sightings` | 394 |
| `geocode_candidates` | 346 |
| `gazetteer` | 11 (10 seeded + 1 promoted) |

The pipeline has run end to end against the canonical fixture
(`docs/sample-newsletters/2026-07-15-whale-sighting-report.txt`). The 346
candidates against 394 sightings reflect the intended cold start — 11 catalog
entries can't match much — and the review queue is now the bottleneck.

**Remaining:**

- Step 8 — `AboutView.vue` and `SightingsView.vue` are stubs (headings only).
  About carries the Orca Network attribution and donate link that spec §1 treats
  as non-negotiable, so it blocks any public deploy. PWA icons missing.
- Step 9 — deploy. Nothing exists on Netlify; there is no git remote. It runs
  locally via `netlify dev` only.
- Work the candidate queue by `hit_count` via `CatalogPanel`, which backfills in
  bulk.
