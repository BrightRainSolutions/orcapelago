-- 007: move the model's reasoning onto the sighting, drop geocode_candidates.
--
-- geocode_candidates was the spec's "AI proposes, human promotes" loop, written
-- before the review queue existed. The review queue then grew map placement and
-- an opt-in "Also save this as a gazetteer place", which does the same job with
-- the water visible. Measured before dropping: 2,447 pending candidates, ONE
-- ever promoted, against 36 gazetteer entries made through review.
--
-- The table was also largely a cache of things already stored: hit_count agreed
-- with a live count over sightings on 2,284 of 2,287 rows (the 3 that differed
-- were stale), and 2,099 of 2,422 coordinates were byte-identical to the
-- sighting they came from.
--
-- Only ai_reasoning and ai_confidence were unique, and those belong on the
-- sighting, where review actually happens.

alter table sightings
  add column if not exists ai_reasoning  text,
  add column if not exists ai_confidence text;   -- high | medium | low

-- NB: no semicolons inside string literals in this file. The apply-NNN runners
-- split statements on ';', so one inside a quoted string truncates it.
comment on column sightings.ai_reasoning is
  'Why the model placed this sighting here. Admin-only, never returned publicly.';

-- Carry across what the candidates table already holds, so the reasoning for
-- sightings placed before this migration is not lost. Matched on location_raw,
-- which is what geocode_candidates was keyed on.
update sightings s
   set ai_reasoning  = c.ai_reasoning,
       ai_confidence = c.ai_confidence
  from geocode_candidates c
 where c.location_raw = s.location_raw
   and s.geo_method = 'ai'
   and s.ai_reasoning is null;

drop table if exists geocode_candidates;
