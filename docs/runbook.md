# Runbook — ingesting a newsletter

Five steps. Only step 4 spends money (~$3–6) or writes anything.

## 1 · Place the file

`docs/sightings-newsletters/<YYYY-MM-DD>-whale-sighting-report.txt` (gitignored).

Publication date alone on its own line within the first 10 lines —
`November 17, 2026`. Abbreviations are accepted and normalised.

## 2 · Dry run — free

```
node scripts/dry-run.mjs docs/sightings-newsletters/2026-11-17-whale-sighting-report.txt
```

Needs: exit 0, `✓ no preprocessor warnings`, and every species section you
expect marked `✓`. A `·` just means that section isn't in this issue.

A warning means a section header it doesn't recognise — **stop.** Those
sightings would be filed under the preceding species with no error at any later
stage. Adding a species takes four coordinated edits:
[architecture.md §3 Stage 1](architecture.md).

## 3 · Price it — free

```
node scripts/estimate-cost.mjs docs/sightings-newsletters/2026-11-17-whale-sighting-report.txt
```

Projects output from separator counts and runs high on dense Humpback issues.
Recent runs have cost $3–6; investigate anything outside that before spending.

## 4 · Ingest — spends money, writes rows

```
node scripts/run-ingest.mjs docs/sightings-newsletters/2026-11-17-whale-sighting-report.txt
```

20–30 minutes, holding a database connection — don't start it on a laptop you
are about to close. Needs `DATABASE_URL` and `ANTHROPIC_API_KEY` in `.env`; it
prints the database host as its first line, before anything bills.

It refuses, before any API call, if the publication date is missing or this
newsletter is already `complete` or `processing`.

Done when the summary shows the sighting count you expected, **AI placements
95% or better in water**, and no warnings. Nothing is inserted unless both
extraction and geocoding succeed, so a failed run leaves no sightings.

## 5 · Resolve locations at `/admin`

**Catalog first** — each Promote backfills every sighting sharing that raw text
and drains the review queue underneath you. **Then the review queue**, which
holds placements that failed the water check.

---

## When something looks wrong

Free and read-only unless marked.

| Question | Command |
|---|---|
| Why did *this* string land there? | `node scripts/explain-geocode.mjs "Blake Island"` |
| Is the geocoder better than what's stored? | `node scripts/measure-geocode.mjs --dry` |
| …measured for real — **billed** | `node scripts/measure-geocode.mjs --limit 120` |
| Is the database set up right? | `node scripts/check-db.mjs` |
| Iterating on the extraction prompt | `node scripts/test-extraction.mjs` |

Every model call from a real ingest lands in `db/ingest-runs/<id8>/` as numbered
request/response pairs — what the model was asked, and what it said.

**A failed or hung run** leaves a newsletter row that will block the next
attempt. Clear it first:

```sql
delete from newsletters where status in ('failed', 'processing');
```
