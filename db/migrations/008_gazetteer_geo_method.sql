-- 008: geo_method 'catalog' -> 'gazetteer'.
--
-- "Catalog" was the original word for the curated place list. The table has
-- always been called `gazetteer`, the API endpoint is /api/gazetteer, the admin
-- tab says Gazetteer, and the word "catalog" was removed from the interface in
-- August. The only place it survived was the value written into geo_method —
-- which is the one place a person reads it, on every sighting badge.
--
-- Two words for one concept is how legacy confusion starts, so the term goes.
--
-- NB: no semicolons inside string literals in this file. The apply-NNN runners
-- split statements on ';', so one inside a quoted string truncates it.

update sightings set geo_method = 'gazetteer' where geo_method = 'catalog';

comment on column sightings.geo_method is
  'How this position was determined: gps | gazetteer | landmark | ai | manual | unresolved';
