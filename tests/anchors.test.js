// Anchor seeding for AI geocoding (lib/geocode.js pickAnchors) — pure logic.
import { describe, it, expect } from 'vitest';
import { pickAnchors } from '../lib/geocode.js';

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
