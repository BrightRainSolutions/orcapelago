-- 005: marine water polygons, for telling water from land.
--
-- Source: WDFW "Recreational Marine Area Code" (MajorFishingArea/MapServer/6),
-- downloaded once to db/wdfw-marine-areas.geojson and imported here. NOT
-- called at runtime: a WDFW URL change broke an earlier Bright Rain project
-- that queried the service live, so the geometry lives in our database and the
-- service is never contacted again.
--
-- These are fishing management areas, so the outer edges are administrative
-- lines across open water while the inner edges follow the shoreline closely
-- (verified: the boundary traces the inlet east of Polnell Point, and the San
-- Juans polygon carries ~60,000 vertices). Washington only — anything in
-- Canadian water falls outside every polygon and must not be read as "on land".
create table if not exists water_areas (
  id         serial primary key,
  area_name  text not null,
  area_title text not null,
  wac        text,
  geom       geography(MultiPolygon, 4326) not null
);

create index if not exists water_areas_geom_idx on water_areas using gist (geom);
