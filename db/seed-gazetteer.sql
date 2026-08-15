-- Seed gazetteer: ~10 hand-entered locations for testing (spec §9.1).
-- Coordinates are approximate, placed on the water adjacent to the feature.
-- TODO: verify each against a chart before seeding production.

insert into gazetteer (name, aliases, lat, lng, region, source) values
  ('Bush Point',            '{}',                          48.0330, -122.6120, 'Admiralty Inlet',   'manual'),
  ('Lime Kiln Point',       '{"Lime Kiln","Lime Kiln State Park"}', 48.5160, -123.1550, 'Haro Strait', 'manual'),
  ('Sandy Point',           '{"Sandy Point, Whidbey"}',    48.0520, -122.3770, 'Saratoga Passage',  'manual'),
  ('Possession Point',      '{}',                          47.9020, -122.3830, 'Possession Sound',  'manual'),
  ('Alki Point',            '{"Alki"}',                    47.5765, -122.4230, 'Puget Sound',       'manual'),
  ('Point No Point',        '{}',                          47.9125, -122.5220, 'Admiralty Inlet',   'manual'),
  ('Edmonds Ferry Dock',    '{"Edmonds ferry","Edmonds"}', 47.8130, -122.3860, 'Puget Sound',       'manual'),
  ('Langley',               '{"Langley, Whidbey"}',        48.0420, -122.4030, 'Saratoga Passage',  'manual'),
  ('East Point (Whidbey)',  '{"East Point"}',              48.0900, -122.3500, 'Saratoga Passage',  'manual'),
  ('Olalla Bay',            '{"Olalla"}',                  47.4265, -122.5430, 'Colvos Passage',    'manual');
