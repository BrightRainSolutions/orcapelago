-- 003: landmarks reference layer (architecture §12) + sighting provenance FK.
--
-- Authoritative named features (GNIS now; CGNDB for the Canadian side and
-- hand-curated hotspots later), distinct from the gazetteer on purpose: the
-- gazetteer is a geocoding cache keyed on reporter text; landmarks are a
-- reference layer with federal provenance. Consumed by the geocoding chain
-- (free stage after the gazetteer) and, later, a map label layer.
--
-- Coordinates are stored exactly where the source puts them — including on
-- land (Hidden Beach, the bluffs). Only sighting placement cares about water.

create table landmarks (
  id            uuid primary key default gen_random_uuid(),
  gnis_id       text unique,          -- USGS feature_id; null for cgndb/manual
  name          text not null,
  feature_class text not null,        -- GNIS class: Bay, Cape, Island, Bar, ...
  lat           double precision not null,
  lng           double precision not null,
  county        text,
  source        text not null default 'gnis',
                -- gnis | cgndb | manual
  created_at    timestamptz not null default now()
);

create index idx_landmarks_name_trgm on landmarks using gin (lower(name) gin_trgm_ops);
create index idx_landmarks_class on landmarks (feature_class);

-- Provenance link, mirroring gazetteer_id: which landmark resolved this
-- sighting's coordinate (geo_method='landmark'). Nullable; landmark deletion
-- should null the link but keep coordinates, same policy as the gazetteer.
alter table sightings
  add column landmark_id uuid references landmarks(id);
