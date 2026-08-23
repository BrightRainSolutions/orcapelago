-- 004: PostGIS.
--
-- Enables real distance and containment maths for proximity questions
-- ("what was seen near Coleman Dock", "did Bigg's activity shift north").
-- Today lat/lng are plain numerics and any distance is bounding-box
-- arithmetic, which is wrong at the scale of a passage and embarrassing at
-- the scale of a beach.
--
-- EXTENSION ONLY, deliberately. Making the data genuinely spatial needs
-- decisions this migration does not presume — a geometry column, an
-- uncertainty radius per geocoding method, the observer-vs-animal referent,
-- and a water mask. See architecture.md §16.
--
-- Neon ships PostGIS 3.6 as an available extension; nothing to install
-- server-side, and it is additive — no existing column or row changes.

create extension if not exists postgis;
