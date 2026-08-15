-- Orcapelago initial schema (spec §4)

create extension if not exists pg_trgm;

create table newsletters (
  id            uuid primary key default gen_random_uuid(),
  pasted_at     timestamptz not null default now(),
  title         text,                 -- e.g. "July 15, 2026 WS Report"
  date_range    daterange,            -- span of sightings covered
  raw_text      text not null,
  status        text not null default 'pending',
                -- pending | processing | complete | failed
  error_message text,
  sighting_count int
);

create table gazetteer (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,        -- canonical: "Bush Point"
  aliases       text[] not null default '{}',
  lat           double precision not null,
  lng           double precision not null,
  region        text,                 -- "Admiralty Inlet", "Saratoga Passage"...
  source        text not null default 'manual',
                -- manual | ai_promoted
  created_at    timestamptz not null default now()
);

create table sightings (
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
);

create table geocode_candidates (
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
);

create index idx_sightings_date          on sightings (sighting_date);
create index idx_sightings_species       on sightings (species);
create index idx_sightings_newsletter    on sightings (newsletter_id);
create index idx_sightings_needs_review  on sightings (needs_review);
create index idx_gazetteer_name_trgm     on gazetteer using gin (lower(name) gin_trgm_ops);
create index idx_gazetteer_aliases       on gazetteer using gin (aliases);
