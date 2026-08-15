// GPS parsing tests — every positive case is a real string from the fixture
// newsletter or the spec (§5).
import { describe, it, expect } from 'vitest';
import { parseGps } from '../lib/gps-parse.js';

const close = (v, expected) => expect(v).toBeCloseTo(expected, 4);

describe('parseGps', () => {
  it('parses bracketed approx decimal pairs', () => {
    const r = parseGps('Whales were headed through President Channel [approx. 48.672988, -123.047781].');
    close(r.lat, 48.672988);
    close(r.lng, -123.047781);
  });

  it('parses bare decimal pairs (spec form)', () => {
    const r = parseGps('48.522500,-122.690800');
    close(r.lat, 48.5225);
    close(r.lng, -122.6908);
  });

  it('parses parenthesized pairs', () => {
    const r = parseGps('Coordinates (if known): (48.6099260, -123.2124230)');
    close(r.lat, 48.609926);
    close(r.lng, -123.212423);
  });

  it('parses decimal + hemisphere letters', () => {
    const r = parseGps('Single Orca near Edmonds. [47.812031 N, 122.419909 W].');
    close(r.lat, 47.812031);
    close(r.lng, -122.419909);
  });

  it('parses decimal degrees with ° and hemispheres', () => {
    const r = parseGps('47.16750° N, 122.90850° W');
    close(r.lat, 47.1675);
    close(r.lng, -122.9085);
  });

  it('parses hemisphere on lat only, west implied (spec form)', () => {
    const r = parseGps('48.04269N 122.40669');
    close(r.lat, 48.04269);
    close(r.lng, -122.40669);
  });

  it('parses DMS', () => {
    const r = parseGps('Right here. [Approx. 47°22\'15.1"N 122°25\'20.7"W] Lots of flukes.');
    close(r.lat, 47 + 22 / 60 + 15.1 / 3600);
    close(r.lng, -(122 + 25 / 60 + 20.7 / 3600));
  });

  it('parses degrees + decimal minutes ("d" notation)', () => {
    const r = parseGps("N 48d00.258’, W 122d17.825’");
    close(r.lat, 48 + 0.258 / 60);
    close(r.lng, -(122 + 17.825 / 60));
  });

  it('returns null for text with no coordinates', () => {
    expect(parseGps('Coordinates (if known): Southeast side of island traveling North')).toBeNull();
    expect(parseGps('17:20 - EC [Emerald Clipper] is leaving a wonderfully milling whale')).toBeNull();
    expect(parseGps('')).toBeNull();
  });

  it('rejects number pairs outside the Salish Sea region', () => {
    expect(parseGps('12.3456, 56.7890')).toBeNull();
    expect(parseGps('3.14159, 2.71828')).toBeNull();
  });

  it('rejects plus codes and unparseable coordinate prose', () => {
    expect(parseGps('XC8W+6JW Galiano Island, British Columbia, Canada')).toBeNull();
  });
});
