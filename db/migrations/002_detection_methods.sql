-- 002: detection methods on sightings (architecture §12).
--
-- Orca Network reports mix on-scene visual sightings with hydrophone and
-- webcam detections. An acoustic fix is the location of the SENSOR, not the
-- animal, so the observation kind must ride on the row. Array-valued because
-- "Lime Kiln hydrophone and webcam" is genuinely both — matching how
-- behaviors and individual_ids already work.
--
-- Vocabulary (enforced in lib/extract.js, described in lib/prompts.js):
--   visual | hydrophone | webcam
--
-- Not backfilled by design: the modality mostly didn't survive into
-- raw_excerpt, and re-ingesting history would shift existing counts.
-- Empty array = recorded before this column existed, or the text didn't say.

alter table sightings
  add column detection_methods text[] not null default '{}';
