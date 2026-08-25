// Anchor seeding for AI geocoding (lib/geocode.js pickAnchors) — pure logic.
import { describe, it, expect } from 'vitest';
import { pickAnchors, landmarkLookup } from '../lib/geocode.js';
import { parseJsonArray } from '../lib/extract.js';

const landmarks = [
  { name: 'Protection Island', feature_class: 'Island', lat: 48.126, lng: -122.929 },
  { name: 'Bush Point', feature_class: 'Cape', lat: 48.033, lng: -122.606 },
  { name: 'Penn Cove', feature_class: 'Bay', lat: 48.22, lng: -122.7 },
  { name: 'Alki Beach', feature_class: 'Beach', lat: 47.576, lng: -122.415 },
  { name: 'Sea', feature_class: 'Sea', lat: 48.5, lng: -123.0 }
];

describe('pickAnchors', () => {
  it('finds landmarks named inside relational descriptions', () => {
    const anchors = pickAnchors(['a half mile north of Protection Island'], landmarks);
    expect(anchors.map((a) => a.name)).toEqual(['Protection Island']);
  });

  it('matches case-insensitively and mid-string', () => {
    const anchors = pickAnchors(['Northbound past bush point near Whidbey'], landmarks);
    expect(anchors.map((a) => a.name)).toEqual(['Bush Point']);
  });

  it('collects anchors across the whole batch, once each', () => {
    const anchors = pickAnchors(
      ['off Penn Cove', 'Penn Cove again', 'between Alki Beach and Blake Island'],
      landmarks
    );
    expect(anchors.map((a) => a.name).sort()).toEqual(['Alki Beach', 'Penn Cove']);
  });

  it('ignores too-short names that would substring-match noise', () => {
    const anchors = pickAnchors(['seals in the sea today'], landmarks);
    expect(anchors).toEqual([]);
  });

  it('caps the anchor count, keeping longest (most specific) names', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `Spot ${String(i).padStart(3, '0')}`,
      feature_class: 'Bay',
      lat: 48, lng: -122.5
    }));
    many.push({ name: 'A Very Specific Long Passage Name', feature_class: 'Bay', lat: 48, lng: -122.5 });
    const locations = [...many.map((l) => `near ${l.name}`)];
    const anchors = pickAnchors(locations, many, 10);
    expect(anchors).toHaveLength(10);
    expect(anchors[0].name).toBe('A Very Specific Long Passage Name');
  });

  it('returns empty for empty landmark list (pre-003 databases)', () => {
    expect(pickAnchors(['off Bush Point'], [])).toEqual([]);
  });
});


describe('generic place names', () => {
  // Washington really does have populated places called Beach, Cove, Home,
  // Summit and Bayview. Substring anchoring on those seeds the model with a
  // hamlet nowhere near the report.
  const withTown = [
    { name: 'Beach', feature_class: 'Populated Place', lat: 46.95, lng: -123.8 },
    { name: 'Hidden Beach', feature_class: 'Beach', lat: 48.1289, lng: -122.5628 }
  ];

  it('does not anchor on a town whose name is an ordinary noun', () => {
    const anchors = pickAnchors(['Wonn Rd [Road] beach access'], withTown);
    expect(anchors.map((a) => a.name)).toEqual([]);
  });

  it('still anchors the specific name that contains it', () => {
    const anchors = pickAnchors(['1.5 miles north of Hidden Beach'], withTown);
    expect(anchors.map((a) => a.name)).toEqual(['Hidden Beach']);
  });
});

describe('landmarkLookup', () => {
  // Stage 2b sets needs_review=false, so anything it matches is asserted as
  // correct without human review. Town centroids are points on land.
  const landmarks = [
    { name: 'Clinton', feature_class: 'Populated Place', lat: 47.9762, lng: -122.3529 },
    { name: 'Penn Cove', feature_class: 'Bay', lat: 48.22, lng: -122.7 },
    { name: 'Rocky Point', feature_class: 'Cape', lat: 48.1, lng: -122.6 },
    { name: 'Rocky Point', feature_class: 'Cape', lat: 47.4, lng: -122.9 }
  ];

  it('resolves a unique water feature', () => {
    expect(landmarkLookup('Penn Cove', landmarks)?.lat).toBe(48.22);
  });

  it('refuses a populated place even on an exact name match', () => {
    expect(landmarkLookup('Clinton', landmarks)).toBeNull();
  });

  it('still refuses an ambiguous water name', () => {
    expect(landmarkLookup('Rocky Point', landmarks)).toBeNull();
  });
});

describe('repairControlChars', () => {
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);

  it('rescues a raw newline inside a JSON string value', () => {
    const broken = '[{"input":"mid channel, headed SW' + NL + '[southwest]","lat":48.1,"lng":-122.5}]';
    expect(() => JSON.parse(broken)).toThrow();
    const [row] = parseJsonArray(broken);
    expect(row.input).toContain('mid channel');
    expect(row.lat).toBe(48.1);
  });

  it('leaves the newlines that format the JSON alone', () => {
    const pretty = '[' + NL + '  {"input":"Penn Cove","lat":48.2}' + NL + ']';
    expect(parseJsonArray(pretty)).toEqual([{ input: 'Penn Cove', lat: 48.2 }]);
  });

  it('handles tabs and an escaped quote in the same value', () => {
    const broken = '[{"input":"a' + TAB + 'b \\"quoted\\" c","lat":1}]';
    const [row] = parseJsonArray(broken);
    expect(row.input).toBe('a' + TAB + 'b "quoted" c');
  });
});
