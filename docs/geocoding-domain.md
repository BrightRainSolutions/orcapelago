# Placing a Salish Sea sighting — domain rules

Sent with every geocoding call. These are rules of judgment, not a term list:
how to read what a whale watcher wrote and turn it into a coordinate.

Every rule below exists because it was violated in production. The examples
are real reports and real failures.

## 1. The animal is in the water. Always.

A whale cannot be on land. If a coordinate falls on shore, in a town, on a
road, or inland, it is wrong regardless of how well it matches the words.

This is the most-violated rule in the system: roughly a third of estimated
positions have landed outside marine water. When a description points at
something on land, do not place the point on it — place it in the water
that thing looks out over.

Freshwater is a real exception, not an error: whales do enter the Lake
Washington Ship Canal and the Ballard Locks. Place those where the report
says, in the canal.

## 2. A named place on land is usually a VANTAGE POINT

Whale watchers name where *they* are standing at least as often as they
describe where the animal is. Parks, decks, patios, restaurants, marinas,
ferry terminals, lighthouses, campgrounds, beaches and homes are places
people stand.

- "Ballard Elks patio" → the whale was in the water off the Elks club, not
  on the patio.
- "Mukilteo Lighthouse Park" → offshore of the park.
- "Seabeck pizza/marina" → in Hood Canal off Seabeck.
- "viewed from Tolmie" → offshore of Tolmie State Park.

Place the point a short distance offshore — typically 100–800 m, matching
any distance the report gives ("a few hundred feet off", "about a mile out").
When no distance is given, assume the animals were close enough to identify:
a few hundred metres.

Only when the description is explicitly a water feature ("mid-channel",
"off X", "N of X") does the named place describe the animal's own position.

## 3. "Mid-channel" means the axis, not the centre of the feature

A passage is long and narrow. Its midpoint is not the answer.

- "Saratoga Passage, mid channel, moving toward Langley" — the whales are on
  the passage's centre line **near Langley**, not at the geometric centre of
  Saratoga Passage. That report was placed 16 km from Langley, on Whidbey
  Island.
- "Hood Canal, spread across channel almost to the bridge" — near the Hood
  Canal Bridge, on the canal's axis.
- "mid channel between Indian Beach & Onamac Point" — midway on the line
  joining those two points, which is water.

When a passage is named *and* a nearby place is named, the nearby place sets
the position along the passage; the passage sets the cross-channel position.

## 4. Local vernacular

Terms that appear constantly and mean something specific here:

- **"the bridge"** — the Hood Canal Bridge (SR 104), unless the report is in
  Seattle waters, where it may be the Ballard or Fremont bridges.
- **"mile marker N", "mm N", "Mile N North Shore"** — highway mile markers on
  North Shore Road along the north side of Hood Canal, near Belfair. The
  whales are in the canal, offshore of that marker — not on the road. These
  have been placed up to 5 km inland.
- **"the Ram", "Rams Restaurant"** — the Ram Restaurant & Brewery at Point
  Ruston, Tacoma; the water is Commencement Bay.
- **"the locks"** — the Ballard (Hiram M. Chittenden) Locks.
- **"up island" / "down island"** — along Whidbey or San Juan Island, north
  and south respectively.
- **"the west side"** — with no other context, the west shore of San Juan
  Island along Haro Strait, the classic Southern Resident route.
- **Ferry lanes / "the ferry route"** — the crossing line between the two
  named terminals.

## 5. Reporting conventions

- Distances are **statute miles and yards**, not nautical, unless the report
  is clearly from a vessel.
- Compass abbreviations have already been expanded in brackets by
  preprocessing: "NB [northbound]", "N [north]".
- Times are local Pacific and describe when the animals were seen, not when
  the report was written.
- A report may name several places as the animals travel ("passed X heading
  toward Y"). The position is where they *were*, which is nearer X.

## 6. Anchors are authoritative; your memory is not

When a landmark list is supplied, a name in it beats your own recollection of
where that place is. Compute the described offset from the supplied
coordinate. Two near-identical phrasings once produced coordinates 64 km
apart because the position was recalled rather than computed.

Anchors marked "verified place" are human-checked and outrank federal
entries with similar names.

## 7. Saying "none" is a valid answer

"low" confidence with a plausible coordinate is more useful than a confident
guess, and `none` is better than either when the text genuinely does not
locate anything ("the webcam", "on the water", "out front").

A wrong coordinate is worse than no coordinate: it puts a whale somewhere it
never was, and nothing downstream can tell the difference.
