# Orcapelago — Build Specification

A public PWA that maps whale sightings from Orca Network newsletters. Newsletter text is pasted in by an admin, an AI extraction pipeline turns it into structured sighting records, a growing location catalog resolves named Salish Sea locations to coordinates, and the results render on a MapLibre map.

A Bright Rain Solutions portfolio project. Public, read-only for visitors; ingestion is admin-only.

---

## 1. Principles & Scope

- **v1 ingestion is copy-paste.** No email webhooks, no scraping. The pipeline behind the paste box is designed so an automated front door can be added later without rework.
- **The catalog gets smarter over time.** No big upfront gazetteer seed. Locations resolve from the catalog first; misses fall back to AI geocoding; human-confirmed results get promoted into the catalog.
- **Historical by nature, not real-time.** The data source is a digest published days-to-weeks after the fact. State this in the About text — it is a feature, not a bug (it sidesteps the "droves of people showing up" concern Orca Network has historically had).
- **Respect the source.** Prominent attribution to Orca Network, link to their donate page, link to Be Whale Wise. This app should read as a tribute, not a scrape.
- **Cost ceiling: ~$0/month.** Free tiers throughout. The only real spend is Anthropic API calls (a few dollars/year at newsletter volume).

Out of scope for v1: multi-user features, sighting submission, automated email ingestion, push notifications, historical backfill tooling (manual paste covers it).

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vue 3 + Vite, PWA via `vite-plugin-pwa` | Static build |
| Map | MapLibre GL JS | NOT Leaflet |
| Basemap | OpenFreeMap Liberty style (hosted, no key) | `https://tiles.openfreemap.org/styles/liberty` |
| Bathymetry | Seascape vector contour layers composed into the style | `@openwaters/seascape` npm package; hosted tiles at tiles.openwaters.io |
| Hosting | Netlify (static + functions) | |
| Ingest function | **Netlify Background Function** (`ingest-newsletter-background`) | Extraction exceeds the 10s sync timeout; Background Functions return 202 and run up to 15 min. Available on the free credit-based plan. |
| Read functions | Regular Netlify Functions | `get-sightings`, `get-newsletters`, `get-gazetteer`, `get-ingest-status`, plus admin PATCH endpoints |
| Database | Neon Postgres (free tier) | Scale-to-zero; does not archive inactive projects. Cold start ~500ms is acceptable. |
| AI | Anthropic API, `claude-sonnet-4-6` | Extraction + geocoding fallback |
| Runtime | Node throughout | |

**Admin auth:** a single shared secret token, stored as a Netlify environment variable, sent as a request header (`X-Admin-Token`) on ingest and review/edit endpoints. No user accounts.

**Environment variables:** `DATABASE_URL` (Neon), `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`.

---

## 3. Basemap Architecture

Isolate all basemap concerns in a single module (`src/map/basemap.js`) so the rest of the app never knows what's underneath:

1. Load OpenFreeMap Liberty as the base style.
2. Compose Seascape bathymetry contour layers into the style, inserted **above Liberty's water fill, below its place labels** (find a stable label layer id at runtime for `beforeId`). Use the `@openwaters/seascape` package's layer-composition support rather than pointing at their full style, so Liberty remains the base.
3. Seascape attribution flows through TileJSON automatically; ensure OpenFreeMap/OSM attribution is present.
4. Document (in a code comment + README) the escape hatch: both the basemap and bathymetry can later be swapped to self-hosted PMTiles files served as Netlify static assets via the `pmtiles` protocol adapter. The module boundary makes this a change to one file.

Sightings render as a **GeoJSON source** with MapLibre's built-in clustering. No plugins.

---

## 4. Data Model (Postgres)

Keep it to four tables.

```sql
newsletters (
  id            uuid primary key default gen_random_uuid(),
  pasted_at     timestamptz not null default now(),
  title         text,                 -- e.g. "March 31, 2026 WS Report"
  date_range    daterange,            -- span of sightings covered
  raw_text      text not null,
  status        text not null default 'pending',
                -- pending | processing | complete | failed
  error_message text,
  sighting_count int
)

sightings (
  id            uuid primary key default gen_random_uuid(),
  newsletter_id uuid not null references newsletters(id) on delete cascade,

  sighting_date date not null,
  sighting_time time,                 -- null when date-only

  species       text not null,
                -- southern_resident | biggs | gray | humpback | minke | unidentified_orca | unidentified_baleen | other
  species_raw   text,                 -- original text ("Bigg's Killer Whales", "Gray")
  pod_or_group  text,                 -- "J Pod", "T99s", "T36/T36Bs & T99s", etc.
  individual_ids text[],              -- ["T99C", "CRC53"]
  count         int,
  direction     text,                 -- "southbound", "W", null
  behaviors     text[],               -- ["traveling","breaching","feeding"]

  location_raw  text not null,        -- exact text: "Just off Blakely Rock with the sailboat"
  gazetteer_id  uuid references gazetteer(id),
  lat           double precision,
  lng           double precision,
  geo_method    text not null default 'unresolved',
                -- gps | catalog | ai | manual | unresolved
  needs_review  boolean not null default false,

  summary       text,                 -- one-sentence AI summary
  raw_excerpt   text,                 -- source text block
  reporter      text,                 -- "Marla Smith, Orca Network"
  report_kind   text                  -- header_summary | timestamped | form_submission
)

gazetteer (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,        -- canonical: "Bush Point"
  aliases       text[] not null default '{}',
  lat           double precision not null,
  lng           double precision not null,
  region        text,                 -- "Admiralty Inlet", "Saratoga Passage"...
  source        text not null default 'manual',
                -- manual | ai_promoted
  created_at    timestamptz not null default now()
)

geocode_candidates (
  id            uuid primary key default gen_random_uuid(),
  location_raw  text not null,
  suggested_name text,
  lat           double precision,
  lng           double precision,
  ai_confidence text,                 -- high | medium | low
  ai_reasoning  text,
  hit_count     int not null default 1,   -- times this raw string has been seen
  status        text not null default 'pending'
                -- pending | promoted | rejected
)
```

Indexes: `sightings(sighting_date)`, `sightings(species)`, `sightings(newsletter_id)`, `sightings(needs_review)`, and a trigram or lower() index on `gazetteer(name)` plus GIN on `gazetteer(aliases)` for lookup.

---

## 5. Newsletter Structure (ground truth)

Design the extraction against the real format. A newsletter contains, in order: photos-of-the-day, a **SUMMARY** section, events/promo material, then the detailed sightings body organized by **species section banners** (SOUTHERN RESIDENTS, BIGG'S KILLER WHALES, UNIDENTIFIED KILLER WHALES, GRAY WHALES, HUMPBACK WHALES, MINKE WHALES, UNIDENTIFIED BALEEN WHALES), and a footer of boilerplate.

Within each species section, **date/location headers** are the structural unit:

```
Thu, Mar 26 - Puget Sound (T36/T36Bs, T65As [minus T65A3 & T65A5], & T99s)
```

Each header carries: day+date, general water body, and (often) pod/matriline or individual IDs in parentheses. **Everything below a header inherits its context until the next header.**

Under each header, three report kinds appear:

1. **Timestamped narrative reports** — `HH:MM - text` followed by a reporter name line. Often several timestamps per reporter block. These are the bulk.
2. **Form submissions** — labeled fields (Name, Date of Sighting, Time, Species seen, Number, Where seen, Direction, Behaviors, etc.). Cleanest to parse. "Where seen" sometimes contains raw GPS coordinates.
3. **Photo captions / relay notes** — looser prose with embedded location and photographer credit. Lower extraction priority; capture when a location and date are recoverable.

Embedded GPS appears in several forms and must be parsed directly: `48.522500,-122.690800`, `[approx. 47.430891, -122.527903]`, `48.04269N 122.40669`.

The **SUMMARY** section duplicates the detail sections at day/area granularity. **Skip it for extraction** (it would create duplicates); optionally use it to derive `newsletters.date_range`.

**Granularity rule:** a single pod moving down a channel generates dozens of timestamped micro-reports. Extract each timestamped report with a resolvable location as its own sighting row — the map UI handles density via clustering, and this preserves the track-line option for later. Reports with no resolvable location (pure hydrophone chatter like "calls on Lime Kiln hydrophone" may be kept, geocoded to the hydrophone's location, and tagged behavior `acoustic`; truly location-free lines are dropped).

---

## 6. Ingestion Pipeline

```
POST /api/ingest  (admin token, Background Function)
  → insert newsletters row (status=pending), return 202 + newsletter id immediately
  → [background continues]
  → PRE-PROCESS: strip boilerplate footer, events section, photo credits noise;
    detect SUMMARY vs detail sections; split detail body into chunks on
    species banners and date/location headers (target chunks ≤ ~8K tokens,
    never splitting mid-header-section)
  → EXTRACT: for each chunk, call claude-sonnet-4-6 with the extraction
    prompt (below) + the chunk + its inherited context (species section,
    any carried header). Parse strict-JSON response. Collect sightings.
  → DEDUPE: same date+time+location_raw across chunk boundaries → keep one.
  → GEOCODE each sighting:
      1. GPS in location_raw → parse, geo_method='gps'
      2. Catalog lookup: normalized exact match on gazetteer.name,
         then aliases, then fuzzy (trigram similarity ≥ 0.4 with a
         clear winner) → geo_method='catalog'
      3. Claude geocode call (batch the misses into one call) →
         geo_method='ai', needs_review=true, upsert geocode_candidates
         (increment hit_count on repeat raw strings)
      4. Still nothing → geo_method='unresolved', needs_review=true
  → PERSIST sightings; update newsletter status=complete, sighting_count.
    On any fatal error: status=failed + error_message.

GET /api/ingest-status?id=...  → { status, sighting_count, error_message }
```

The admin UI polls `ingest-status` after paste and shows progress. Loading message easter egg: **"Thar she blows..."** while processing.

### Extraction prompt (system, abbreviated — build as a template)

```
You extract whale sightings from Orca Network newsletter text (Salish Sea, WA/BC).
You receive one section of a newsletter plus its inherited context:
the species section it came from and its date/location header.

Rules:
- Every timestamped report (HH:MM - ...) with a location is one sighting.
- Form submissions (labeled fields) are one sighting each.
- Inherit date, water body, and pod/group from the header context unless
  the report itself overrides them.
- Parse GPS coordinates when present in any format.
- location_raw is the exact location text from the report, verbatim.
- Do not invent locations, times, or counts. Omit fields you cannot support.
- Return ONLY a JSON array matching this schema, no prose, no fences:
  [{ sighting_date, sighting_time, species, species_raw, pod_or_group,
     individual_ids, count, direction, behaviors, location_raw,
     gps: {lat,lng} | null, summary, raw_excerpt, reporter, report_kind }]
```

### Geocoding prompt (for catalog misses, batched)

```
You are an expert on Salish Sea marine geography (Puget Sound, San Juan
Islands, Gulf Islands, Hood Canal, and connecting waters), including named
points, passages, parks, ferry routes, and informal landmarks used by
whale watchers. For each location description below, return your best
coordinate estimate ON THE WATER adjacent to the named feature.
Return ONLY JSON: [{ input, resolved_name, lat, lng, confidence, reasoning }]
Use confidence "none" with null coordinates when unresolvable.
```

---

## 7. API Surface (Netlify Functions)

```
POST  /api/ingest                    admin  (Background Function)
GET   /api/ingest-status?id=         admin
GET   /api/sightings                 public
        ?from=&to=&species=a,b&bbox=&needs_review=&limit=&offset=
        → GeoJSON FeatureCollection (map) or JSON rows (?format=json)
GET   /api/newsletters               public (id, title, date_range, status, count)
PATCH /api/sightings/:id             admin  (review edits: lat/lng, species, date, needs_review=false, geo_method='manual')
GET   /api/gazetteer                 public
POST  /api/gazetteer                 admin
PATCH /api/gazetteer/:id             admin
GET   /api/geocode-candidates        admin  (pending, ordered by hit_count desc)
POST  /api/geocode-candidates/:id/promote  admin  (→ gazetteer, backfill matching sightings, needs_review=false)
POST  /api/geocode-candidates/:id/reject   admin
```

`get-sightings` is the hot path: cache-friendly (send `Cache-Control` headers), and by default excludes unresolved sightings from the GeoJSON response.

---

## 8. Frontend

**Views:**

1. **Map (default, public).** Full-bleed MapLibre map centered on the Salish Sea (~48.2N, -122.6, z8). Sightings as clustered circle layers colored by species (Southern Resident teal `#006D77`, Bigg's slate `#3D405B`, gray whale warm gray `#8B8589`, humpback blue `#2176AE`, minke/other amber `#E9C46A`). Click → popup: species + pod/IDs, date/time, location name, direction/behaviors, reporter, one-line summary, small badge for geo_method. Filter panel: date range (default: most recent newsletter's range), species checkboxes. Sighting count indicator.
2. **Sightings (public).** Filterable table view of the same data; links each row to its map location.
3. **About (public).** What this is, the historical-not-realtime framing, Orca Network attribution + donate link, Be Whale Wise link, Bright Rain credit.
4. **Admin (token-gated client-side; token stored in localStorage and sent on admin calls).**
   - Paste box → ingest → status polling
   - Newsletter list with status/counts
   - **Review queue:** each flagged sighting shows raw_excerpt beside extracted fields, editable; a mini-map to click-place coordinates (sets geo_method='manual'); "promote to catalog" button when a location resolves
   - **Catalog editor:** gazetteer table CRUD + pending candidates ordered by hit_count

**PWA:** manifest (name Orcapelago, theme `#006D77`, standalone), Workbox service worker via vite-plugin-pwa — cache-first for app shell, network-first for `/api/sightings`. Vector tiles are left to default HTTP caching.

**Formatting note:** the admin token check is a convenience gate, not security — actual enforcement is the header check in the functions.

---

## 9. Build Order

1. Neon schema + migration script; seed gazetteer with ~10 hand-entered locations for testing (Bush Point, Lime Kiln, Sandy Point, Possession Point, Alki Point, Point No Point, Edmonds ferry dock, Langley, East Point [Whidbey], Olalla Bay).
2. `get-sightings` + `get-newsletters` functions against seed data.
3. Map view with clustering + popups + filters (fake data first).
4. Ingest Background Function: pre-process + chunking, tested against the sample newsletter in `docs/sightings-newsletters/`.
5. Extraction prompt + parsing + persistence. Iterate against the sample until recall on form submissions and timestamped reports is solid.
6. Geocoding chain (GPS parse → catalog → AI batch → candidates).
7. Admin UI: paste, status, review queue, catalog editor.
8. About page, PWA manifest/service worker, attribution.
9. Deploy: Netlify site + env vars, Neon production branch.

Include the March 31, 2026 sample newsletter in the repo as the canonical test fixture, plus a unit-test suite that runs extraction pre-processing (chunking/header parsing) without API calls.

---

## 10. Deferred / v2

- Automated ingestion (email forward via inbound webhook, or polite daily scrape of orcanetwork.org/recent-sightings)
- Track lines connecting sequential sightings of a pod within a day (MapLibre line layers — the per-report granularity in the data model already supports this)
- Timeline scrubber / playback animation
- Individual whale pages (all sightings of T99C, CRC53...)
- Self-hosted PMTiles basemap + custom bathymetry build (see companion note)
- Stranding map (the 20-year-old Howard idea — same architecture, different dataset)
- GPX/KML export

---

## Companion note: custom bathymetry project (optional, separate)

Deferred and non-blocking. If Seascape's hosted tiles ever disappear or the craft itch strikes: extract Salish Sea bbox (46.9–50.0N, -125.5 to -121.9) from NOAA CUDEM/S-102 + GEBCO, `gdal_contour` for lines + depth-band polygons, tippecanoe → single PMTiles archive hosted as a Netlify static asset, styled into the same insertion point `basemap.js` already defines. Seascape's open-source build pipeline (github.com/openwatersio/seascape) is the reference implementation to start from rather than raw DEMs.
