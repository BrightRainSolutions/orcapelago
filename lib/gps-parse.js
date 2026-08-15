// Parse embedded GPS coordinates from report text (spec §5).
// Real formats observed in the fixture newsletter:
//   [approx. 48.672988, -123.047781]        bracketed decimal pair
//   48.79950, -123.39258                    bare decimal pair
//   (48.6099260, -123.2124230)              parenthesized pair
//   [47.812031 N, 122.419909 W]             decimal + hemisphere letters
//   47.16750° N, 122.90850° W               decimal degrees + hemisphere
//   48.04269N 122.40669                     hemisphere on lat only (spec §5)
//   47°22'15.1"N 122°25'20.7"W              DMS
//   N 48d00.258’, W 122d17.825’             degrees + decimal minutes
// Sanity-bounded to the broad Salish Sea region so stray number pairs
// (times, counts) never parse as coordinates.

const LAT_MIN = 45, LAT_MAX = 52, LNG_MIN = -130, LNG_MAX = -120;

function finish(lat, lng, latHemi, lngHemi) {
  if (latHemi === 'S') lat = -lat;
  if (lngHemi === 'W') lng = -Math.abs(lng);
  // No hemisphere given but magnitude fits a west longitude → assume W.
  if (!lngHemi && lng > 0 && lng >= -LNG_MAX && lng <= -LNG_MIN) lng = -lng;
  if (lat < LAT_MIN || lat > LAT_MAX || lng < LNG_MIN || lng > LNG_MAX) return null;
  return { lat, lng };
}

// DMS: 47°22'15.1"N 122°25'20.7"W
const DMS_RE = /(\d{1,2})[°º]\s*(\d{1,2})['’′]\s*([\d.]+)["”″]?\s*([NS])[,;\s]+(\d{1,3})[°º]\s*(\d{1,2})['’′]\s*([\d.]+)["”″]?\s*([EW])/i;

// Degrees + decimal minutes: N 48d00.258' , W 122d17.825'
const DDM_RE = /([NS])\s*(\d{1,3})d(\d{1,2}(?:\.\d+)?)['’′]?[,;\s]+([EW])\s*(\d{1,3})d(\d{1,2}(?:\.\d+)?)['’′]?/i;

// Decimal degrees with hemisphere letter(s): 47.812031 N, 122.419909 W
// (longitude hemisphere optional: "48.04269N 122.40669")
const DEC_HEMI_RE = /(\d{1,2}\.\d+)\s*[°º]?\s*([NS])[,;\s]+(\d{1,3}\.\d+)\s*[°º]?\s*([EW])?/i;

// Plain decimal pair; ≥3 decimals required so "3.5, 2.1"-style prose and
// times never match: 48.522500,-122.690800
const DEC_PAIR_RE = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;

/**
 * @param {string} text
 * @returns {{ lat: number, lng: number } | null}
 */
export function parseGps(text) {
  if (!text) return null;

  let m = text.match(DMS_RE);
  if (m) {
    const lat = +m[1] + +m[2] / 60 + +m[3] / 3600;
    const lng = +m[5] + +m[6] / 60 + +m[7] / 3600;
    return finish(lat, lng, m[4].toUpperCase(), m[8].toUpperCase());
  }

  m = text.match(DDM_RE);
  if (m) {
    const lat = +m[2] + +m[3] / 60;
    const lng = +m[5] + +m[6] / 60;
    return finish(lat, lng, m[1].toUpperCase(), m[4].toUpperCase());
  }

  m = text.match(DEC_HEMI_RE);
  if (m) {
    return finish(+m[1], +m[3], m[2].toUpperCase(), m[4]?.toUpperCase() ?? null);
  }

  m = text.match(DEC_PAIR_RE);
  if (m) {
    return finish(+m[1], +m[2], null, null);
  }

  return null;
}
