// Pre-processing tests against the canonical fixture — no API calls (spec §9).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  preprocessNewsletter,
  parseHeaderLine,
  headerDateToIso,
  bannerFor
} from '../lib/preprocess.js';

const fixture = readFileSync(
  new URL('../docs/sample-newsletters/2026-07-15-whale-sighting-report.txt', import.meta.url),
  'utf8'
);
const result = preprocessNewsletter(fixture);
const allChunkText = result.chunks.map((c) => c.text).join('\n');

describe('parseHeaderLine', () => {
  it('parses a standard header with pod group', () => {
    expect(parseHeaderLine('Thu, Jul 9 - Puget Sound (T65A5)')).toMatchObject({
      month: 7, day: 9, waterBody: 'Puget Sound', podGroup: 'T65A5'
    });
  });

  it('parses a header without pod group', () => {
    expect(parseHeaderLine('Tue, Jul 7 - Discovery Bay')).toMatchObject({
      month: 7, day: 7, waterBody: 'Discovery Bay', podGroup: null
    });
  });

  it('tolerates a period after the weekday (real-world "Sat. Jul 4")', () => {
    expect(parseHeaderLine('Sat. Jul 4 - Strait of Juan de Fuca')).toMatchObject({
      month: 7, day: 4, waterBody: 'Strait of Juan de Fuca'
    });
  });

  it('keeps compound water bodies intact', () => {
    expect(parseHeaderLine('Sun, Jul 5 - Possession Sound/Port Susan (T77C & T77E)')).toMatchObject({
      waterBody: 'Possession Sound/Port Susan', podGroup: 'T77C & T77E'
    });
  });

  it('rejects timestamped report lines and prose', () => {
    expect(parseHeaderLine('07:57 - 08:02 - Today I witnessed something')).toBeNull();
    expect(parseHeaderLine('photo by Kevin Toomer, July 10, 2026')).toBeNull();
  });
});

describe('headerDateToIso', () => {
  it('uses the newsletter year', () => {
    expect(headerDateToIso(7, 9, '2026-07-15')).toBe('2026-07-09');
  });
  it('wraps to the previous year for Dec sightings in a Jan issue', () => {
    expect(headerDateToIso(12, 28, '2026-01-05')).toBe('2025-12-28');
  });
});

describe('bannerFor', () => {
  it('matches banners with trailing parentheticals', () => {
    expect(bannerFor("BIGG'S KILLER WHALES (mammal-eating ecotype)")).toMatchObject({
      species: 'biggs'
    });
  });
  it('matches curly-apostrophe variants', () => {
    expect(bannerFor('BIGG’S KILLER WHALES')).toMatchObject({ species: 'biggs' });
  });
  it('does not match prose or announcements', () => {
    expect(bannerFor('ANNOUNCEMENTS:')).toBeNull();
    expect(bannerFor('We saw gray whales today')).toBeNull();
  });
});

describe('preprocessNewsletter (fixture)', () => {
  it('extracts title and newsletter date', () => {
    expect(result.title).toBe('July 15, 2026');
    expect(result.newsletterDate).toBe('2026-07-15');
  });

  it('captures the SUMMARY section separately', () => {
    expect(result.summaryText).toContain("Bigg's Killer Whales - On July 3");
    expect(allChunkText).not.toContain('Sightings through July 10');
  });

  it('strips announcements, photos-of-the-day, and footer boilerplate', () => {
    expect(allChunkText).not.toContain('Goose Community Grocer');
    expect(allChunkText).not.toContain('PHOTOS OF THE DAY');
    expect(allChunkText).not.toContain('1-866-ORCANET');
    expect(allChunkText).not.toContain('Constant Contact');
  });

  it('detects the species sections present in this issue', () => {
    const species = new Set(result.chunks.map((c) => c.species));
    expect(species).toEqual(
      new Set(['biggs', 'gray', 'humpback', 'minke', 'unidentified_baleen', 'other'])
    );
  });

  it('derives date_range from header dates', () => {
    expect(result.dateRange).toEqual({ from: '2026-07-01', to: '2026-07-10' });
  });

  it('keeps every chunk under the size cap and non-empty', () => {
    for (const c of result.chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.text.length).toBeLessThanOrEqual(12000);
    }
  });

  it('starts each chunk at a header, or carries the header it continues', () => {
    for (const c of result.chunks) {
      const startsWithHeader = parseHeaderLine(c.text.split('\n')[0]) !== null;
      expect(startsWithHeader || c.carriedHeader !== null).toBe(true);
    }
  });

  it('preserves each report in exactly one chunk (no loss, no duplication)', () => {
    const probes = [
      '06:50 - Orcas just past Browns Point Lighthouse',
      'Name: Maddie Pace',
      '16:38 - Minke whale at Admirals Cove',
      '13:09 - Donna McCrea, WSF Marine Ops, emailed at 13:10',
      '14:14 - Dahl\'s porpoise are visible from Salisbury'
    ];
    for (const probe of probes) {
      const hits = result.chunks.filter((c) => c.text.includes(probe)).length;
      expect(hits, probe).toBe(1);
    }
  });

  it('keeps pod groups attached to their species section', () => {
    const biggsText = result.chunks
      .filter((c) => c.species === 'biggs')
      .map((c) => c.text)
      .join('\n');
    expect(biggsText).toContain('Fri, Jul 3 - Port Townsend Bay (T49C)');
    const grayText = result.chunks
      .filter((c) => c.species === 'gray')
      .map((c) => c.text)
      .join('\n');
    expect(grayText).toContain('Sat, Jul 4 - Saratoga Passage (CRC2687)');
  });
});
