# Ask Orca — domain rules

Sent with the DDL on every Ask Orca call. The DDL says what the columns are;
this says where the data came from, how it was made, and what it therefore
does and does not support.

**No statistics live here by design.** Counts, proportions and distributions
change with every ingest and every hour of review — query the database for
those. This document holds only rules, which change when the process changes.

## The source

Every sighting originates in an Orca Network *Whale Sighting Report*
newsletter: volunteer observers report to Orca Network, an editor compiles and
publishes, and this project ingests the published text.

That gives the data its shape:

- **Reports, not surveys.** Coverage follows where people are watching, not
  where whales are. Absence of reports in an area is evidence about observers
  first, whales second.
- **A row is one report from one observer at one moment.** It is not a whale
  and not an encounter. A pod travelling down a passage generates many rows
  from many watchers. Never phrase a count as a number of animals.
- **Attribution is owed.** Orca Network is the source of every sighting;
  hydrophone positions belong to Orcasound; the Lime Kiln camera belongs to
  The Whale Museum and SMRU Consulting.

## How a sighting is made

1. **Preprocess** — the newsletter is split on ALL-CAPS species banners, then
   on date headers, then packed into chunks. Pure text handling, no model.
2. **Extract** — a language model reads each chunk and returns structured
   sightings.
3. **Geocode** — the location text is resolved to a coordinate (below).
4. **Persist** — rows are written with the provenance of every decision.

Two consequences worth holding onto:

- **Species comes from the section banner, not from the report text.** A report
  filed under BIGG'S KILLER WHALES is Bigg's because of where it sat in the
  newsletter. If a banner is not recognised, its reports are absorbed into the
  preceding section and take the wrong species — silently. Warnings from that
  check land in `newsletters.error_message`.
- **Section size drives counts.** One species dominating a period usually
  reflects how much the newsletter wrote about it. Compare species only with
  that stated.

## Geolocation: the chain, and what each outcome means

Location text is resolved in a fixed order, first match wins. `geo_method`
records which stage produced the coordinate, and it is the confidence signal:

| `geo_method` | How it was derived | Confidence |
|---|---|---|
| `gps` | coordinates were written in the report itself | highest |
| `gazetteer` | matched the **gazetteer** — a place a human verified | high |
| `landmark` | matched a GNIS federal place name, exact and unique | high |
| `manual` | a person placed this pin by hand during review | high |
| `ai` | a model estimated the position from free text | **low** |
| `unresolved` | nothing resolved it | none |

(`catalog` was the old name for `gazetteer`, migrated away in 008. Data
exported before 2026-09-02 may still carry it — same meaning.)

**`ai` is an estimate, not a measurement.** The model is asked to place phrases
like "just south of Hat Island" or "mid-channel off Bush Point". It is seeded
with authoritative anchor coordinates for any place name it recognises, which
helps, but two near-identical phrasings can still land tens of kilometres
apart. Treat `ai` positions as approximate at the scale of a passage, not a
beach.

**Any spatial answer must disclose its confidence composition** — how many of
the rows it used were `ai` or `unresolved`. Compute that from the data; do not
assume it.

## What a coordinate refers to

The coordinate means whatever its derivation makes it mean, and that differs:

- A **shore report** is the observer's vantage point, not the whale.
- A **hydrophone detection** is the sensor's position. The animals were
  audible, which can mean kilometres away and in a direction unrecorded.
- A **webcam detection** is placed offshore in the camera's field of view,
  deliberately not on the camera.
- A **positional phrase** ("two miles NW of Fox Spit") estimates the whale.

No column distinguishes these; `detection_methods` is the nearest signal.

## Detection methods

Values are `visual`, `hydrophone`, `webcam`, and the column is array-valued
because "heard on the Lime Kiln hydrophone and seen on the webcam" is both.

**An empty array means the modality was not recorded — never that it was not
detected that way.** The column was added part-way through the project's life
and rows ingested before it are empty regardless of how the whales were seen.
Never compute a proportion over this column without excluding newsletters
ingested before it existed.

## Verification and the review queue

`needs_review = true` marks a row whose position needs human eyes — set
automatically whenever the coordinate came from the AI stage.

`needs_review = false` means **a human cleared the flag**, which is weaker than
it sounds: a reviewer may have accepted the position without moving the pin.
It is "someone looked", not "surveyed".

## The three place tables are different kinds of thing

- **`gazetteer`** — small, human-verified places with `aliases[]`. The
  project's own authority, checked first. Also how ambiguity in the federal
  data is settled: when a name exists twice, a gazetteer entry says which one
  this project means.
- **`landmarks`** — GNIS federal place names, imported wholesale. Reference
  data, matched only on exact and unique names because duplicate names are
  common.
- **`sightings.ai_reasoning` / `ai_confidence`** — the model's own account of
  why a sighting sits where it does, on rows with `geo_method='ai'`. Review
  apparatus, admin-only, and **not a source of truth about places**: it is the
  machine explaining a guess. A gazetteer entry is made by a person; an AI
  placement is not. Never present one as a confirmed place.

  (These replaced a `geocode_candidates` work-queue table in migration 007.)

Name matching is exact only — see `lib/geocode.js` for why fuzzy was removed.

## Newsletters and time

- **Issues overlap in date range and that is normal.** Orca Network publishes
  late-arriving reports for earlier dates, so a later issue commonly covers
  days an earlier one already covered. Overlapping ranges do not imply
  duplicate reports.
- **There is no cross-newsletter deduplication.** If the same report were ever
  published twice, both rows would exist.
- **`sighting_date` carries no year of its own** — section headers omit it and
  it is inherited from the newsletter's publication date.
- **`sighting_time` is local Pacific time and is often null.** Commentary lines
  carry no time. Null is not midnight.

## Answering well

- Say "reports", never "whales".
- State the confidence mix on any spatial claim.
- Prefer showing the query behind a surprising result.
- When the data cannot support a question — and much of it cannot be answered
  precisely from volunteer reports — say so plainly rather than computing
  something adjacent and presenting it as the answer.
