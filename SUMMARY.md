# Sixth History — visual polish round

Seven commits on top of `3d919c1f`, one per thing changed. Every one is a fix
somebody can see, and each carries the test that would have caught it.

## Verification

Measured on this branch, and on `3d919c1f` before anything was touched.

| | baseline `3d919c1f` | this branch |
|---|---|---|
| `node --test test/*.test.cjs` | **1105 of 1106**, 0 failures, 1 skipped, exit 0 | **1118 of 1119**, 0 failures, 1 skipped, exit 0 |
| `npm run typecheck` (node + web) | 0 errors | 0 errors |
| `npm run build` | succeeds | succeeds |

The one skip is pre-existing and unrelated. 13 tests are new.

**Not verified here:** none of this has been seen in a running Electron window
from this worktree — every claim below is from the shipped panels' own pixels
and from the layout arithmetic, not from a screenshot of the app. The
composites under `hive/evidence/c33b/` draw the computed geometry over the real
panels, which is the closest thing to a screenshot that can be produced without
a GPU. A pass on the running app is the thing that would settle it.

## The commits

### 1. `fix(study): the fire pooled at the foot of a door, because there was no hearth`

Closing Time is the `hearth` anchor and in the parlour it is a prop — a
rectangle of that room's painting. The rectangle was a painted **door**: the
parlour was generated from a prompt that explicitly removed the fireplace. The
panel is repainted with an arched stone fireplace where the door was, the plate
moves onto it, and the paint under the plate is now tested.

*Evidence:* `parlour-before.png` / `parlour-after.png` — the orange disc is the
hearth light, and in the before it is on floorboards beside a door.

### 2. `fix(study): the parlour's fire burned six inches to the left of its grate`

The light kept the coordinate it had when the thing beneath it was a door.
Moved onto the burning grate; the test samples a patch of painting around the
marked point, because a glow is a disc and a coordinate read by eye cannot be
held to one pixel.

### 3. `fix(study): every card floated above the desk it was standing at`

A berth's **bottom edge is the painted desk surface** — that is how every one
was read off its panel. But the card was drawn in the top 78% of the berth,
with the book filling the fifth underneath, so the card's foot never reached
that edge. The gap is proportional to the berth, which is why it is worst where
it is most visible: the god's study, one card alone in the largest berth in the
house. The card now runs the full height of the setting and the book moves to
its right, onto the same surface.

*Evidence:* `god-card-before.png` / `god-card-after.png` — yellow is the card,
blue the book.

### 4. `fix(study): a portrait card was cut landscape, so every face was trimmed`

The card's box was a share of a place setting, and a place setting is more than
twice as wide as it is tall, so the card came out ~1.2 wide for every 1 tall.
The portraits are painted 5:6 the other way, and `object-fit: cover` cropped a
horizontal band out of every face. That is the "squashed, elongated" look. The
card is now cut to the portraits' proportion, and the frame *inside* it is held
to the same ratio independently — the caption eats into the card's height, so a
frame told only to fill what is left is a third shape again.

The constant is tied to the art rather than typed: the test reads the shipped
portrait pack's PNG headers and requires the proportion to be the one over 90%
of the 48 faces are actually painted at.

### 5. `fix(study): the commissions were dealt in a grid hanging over the table`

Four across and two deep, filling a dealing area that reached most of the way up
the parlour wall — only the bottom row was anywhere near the table. They are
dealt as one spread hand now, standing on the felt, overlapping as cards do.
The baseline is a shallow arc because the table is an ellipse: a straight row of
feet crosses the near edge of an oval twice. The dealing area itself was a fifth
of a panel wider than the table it described, and is pulled in to the paint.

The test asks the painting where the table is, column by column, rather than
whether the pixel under a foot is green: the panel has white notes painted lying
*on* the felt.

### 6. `feat(study): the archive darkens the wall's own books instead of drawing new ones`

Aaron: *"the library books being archived don't even line up with the background
books… these overlay books are doing more harm than good."* The reason they
could not line up is structural — they were placed at the room's **light**
points, which mark the shelf lamps, so a mark landed near a shelf and never on a
spine.

Nothing is drawn now. Each mark is a window onto a second copy of the **same
panel**, laid at the panel's own size and slid back by exactly where the window
sits, then darkened. The alignment is arithmetic, not an eye — repaint the panel
and every mark moves with the paint under it. Where the marks go is read off the
painting too: **22 columns where the paint is a spine from the shelf above right
down to the ledge**, four to a row, clear of the ladder and the sleeping cat.
The wall's capacity is now that count.

A concluded commission is its own volume deepened and saturated; a departed
assistant is that volume drained to near grey.

*Evidence:* `shelves-before.png` / `shelves-after.png`.

### 7. `feat(study): four reading rooms, four paintings — the House stopped repeating`

Rooms three and four hung rooms one and two again. Two new panels — a teal
panelled room under an amber window, and a rose attic under sloping beams — both
repaints of the rooms they replace, so the storeys still look like one building.
Berths and candles are read off the new paint; the attic's desks are narrower
and stand higher than the rooms below. The manifest now holds the property that
was only ever an intention: no two rooms hang the same painting.

## Prompt sheets

The eighth scope item — sheets for the three new panels — is folded into the
commits that ship them rather than kept as a separate commit, because a sheet is
the record *of* a panel: `card-table.yaml` (both passes, second is the repaint
that produced the shipped PNG) in commit 1, `desk-c.yaml` and `desk-d.yaml` in
commit 7. Those two are the first sheets whose reference is a file that ships
here rather than a lost photograph, so they name the file as well as the digest,
and `tools/occult-art/README.md` says so.

## What a reviewer should look at hardest

- **The card's height is now the berth's height.** Any berth whose bottom edge
  was authored a little low will now show it, where before the 78% inset hid it.
  All nine berths were re-probed against their paintings and pass.
- **`ARCHIVE_MAX` is now derived** from the number of painted volumes mapped
  (22, down from a hand-chosen 24). The bound's behaviour is unchanged; only its
  source is.
- **The 22 shelf rectangles are data read off one PNG.** If `room-shelves.png`
  is ever repainted they are all wrong, and the test that holds them to painted
  spines is what will say so.
