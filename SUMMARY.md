# Sixth History — the inhabited house, polish round

Branch `agent/worker-medusa`, cut from `782c6657` (the merged Milestone 3 house).
Twelve commits. Eleven of them answer a specific complaint from the person who
sat in front of the running app; the twelfth is the test harness change one of
them needed.

    b2e3a917 fix(theme): the candlelit terminal was a second near-black, not a second colour
    80127e66 fix(study): the hearth read as a circle blinking on the fire
    91e8e597 fix(study): one three-room storey shrank every room in the house
    19ab1fea fix(study): the commissions on the card table could not be read
    e77295ba fix(study): an archived volume was one more painted spine
    67744e7c fix(study): a finished commission left no mark on the shelf
    8f821259 feat(study): the floor plan may stand an anchor inside another room
    abc8fbbc fix(study): a room apiece for the props cost the whole house a storey
    2d984f10 fix(study): the count of waiting letters was printed at two pixels
    42be2026 fix(summon): a face named the assistant after a file, in lower case
    332c86c3 test: the component host could not restage the world or hold a portal
    2cb8131c fix(study): the same assistant had two faces, one above the other

One theme runs through five of them and is worth stating once rather than five
times. **The house is laid out at its natural size and letterboxed into the
window as ONE scaled drawing.** On a 1280x720 floor that scale is around 0.21.
So any length written in CSS pixels inside the house — a font size from a token,
a padding, a 1px inset edge — is not the length it says: it arrives at a fifth of
it. Three separate complaints below ("cannot read the commissions", "cannot tell
if a book is darkened", "the letter count is unreadable") are the same defect
wearing three costumes, and the fix is always the same shape: size the thing as a
fraction of the panel it is painted on, so it is scaled by exactly the number
that scales everything else.

---

## The seven findings

### 1. "the terminal looks the same black as before"

`b2e3a917`. Not a wiring bug — the selector, the palette map and the effect that
writes `term.options.theme` were all live. The occult ground was cloned from
`--cth-paper-100`, a blue-violet `#262134`, which measures **1.11:1** against the
dark theme's `#1A1A1F`. That is not a subtle difference, it is no difference.

The theme's lightest surface is now a warm parchment `#312717` — one warm surface
in an otherwise ink-blue ramp, deliberately, because it is what the terminal and
the editor sit on and candlelight on parchment is what the theme depicts. 1.18:1
against the dark ground *with a full warm/cool hue flip*, 11.2:1 under body ink,
3.05:1 under border ink, so the theme's 3.0 floor for structural borders holds.
ANSI black moved one step down so a program painting a black cell dims the
parchment instead of punching a cold hole in it.

The test asserts the property that was broken — that the two grounds are far
enough apart to be *seen* as different — and reads the dark ground out of the
view that paints it, so a constant shared with the implementation cannot hide the
implementation moving.

### 2. "the hearth ambiance is sort of just a flashing circle on the fire?"

`80127e66`. It was one filled circle with a hard edge on a candle's brightness
curve, which swings 0.5 to 1.0. Doubling the brightness of a shape *with an edge*
is precisely what an eye reads as blinking.

Three changes, all in what the light **is** rather than how often it is redrawn:
glows got a falloff (`glowRings`, nested circles with a quadratic alpha ramp that
additive blending sums into a soft centre-weighted glow — the edge is what made
it read as applied rather than emitted); the hearth got its own curve
(`hearthFlicker`, a band a tenth as wide as a candle's, 0.80–1.00, never zero,
three superposed waves at unrelated frequencies so it never settles into a
countable loop — largest step between two frames at 60Hz is under 0.003); and it
throws further than the firebox, at 2.4 candles wide, with a hotter ember core so
the light has a visible source. A flame moves; a fire's whole light does not.

Asserted as arithmetic: the band it stays inside, the largest per-frame step, and
that no period under twenty seconds repeats it.

### 3. "the rooms are too small… maybe not have 3 in one row" and "cleaner wall borders/gutters between the rooms"

`91e8e597`. The bottom storey held three rooms, which made the building 4728 wide
by 3408 tall; every other storey held one or two and was centred inside that
width with dead floor either side (the top storey used a third of it). Because
the whole house is scaled by one number, **one three-room storey was shrinking
every room in the building.**

Two rooms per storey, five storeys, every storey spanning the house exactly:
3190 by 3468, and a room goes from a third of the house's width to a half — 21%
larger on a 900x800 floor.

The gutters were a CSS `gap`, which paints nothing: whatever was behind the house
showed between the rooms, so the cross-section had floors and no walls at all.
Every division is now a painted band from one `MASONRY` style at one thickness —
between storeys, between rooms, and around the outside — 18px so it reads at the
scale the house is drawn at, with a repeating course pattern, which is what stops
a flat bar reading as another gap. The outer wall is added into the natural size
the letterbox measures, so the fit and the element's own width cannot disagree
about whether the wall is inside the number.

### 4. "clicked commissions open but I can't really see what they are"

`19ab1fea`, and `2d984f10` for the same defect in the one place it was left.

The cards were dealt into the painted baize itself, 337 by 50 panel pixels, so
eight of them came out about **twenty by six screen pixels**; the number on each
was a fixed 12px token, delivered at three or four. The dealing area is now a
rectangle the cards can stand in (525 by 202 panel pixels, resting on the near
half of the table and rising into the panelling behind it — what a card standing
on a table looks like drawn straight on), a dealt card is 100 by 76, and the
number is a fraction of the card rather than a token.

The faces had to change with it: the number on a blocked card cleared 3.2:1 on
the coral and **no ink in this palette clears 4.5:1 on it** — a saturated mid-tone
leaves no room. Each card is now a deep paper ground with a parchment number at
8.5:1 or better, carrying its status colour at full strength as a bar down its
left edge, which reads faster at this size than a tinted rectangle did anyway.
The faces are exported so the test measures every pair's contrast against the
stylesheet rather than trusting that they look all right.

`2d984f10` is the petitions badge: `--cth-text-display-sm` is 8px, delivered at
**2.1**, with its 1px/5px padding at a quarter of a pixel. Now 45 panel pixels on
an 87-pixel plate, arriving at 11.7 on the same floor. The test asserts the size
is derived from the plate at all, and that what it comes to on a real window
clears eight pixels — sizing it from a token again fails both.

### 5. "I don't really know if the books are getting filled or darkened"

`e77295ba`, and `67744e7c` for a second defect found underneath it.

The design assumed the shelves were painted pale, so that darkening one volume
would make it stand out. They are not: `room-shelves.png` averages a luma of
**61 out of 255**, and the wall is fifty dark varied spines. Multiplying one by a
mid-tone accent moved its slot 55% for an assistant and 40% for a commission —
on that wall, not a mark, just another book. The volume was also 44 panel pixels
wide, delivered at about ten: the same width as the spines painted either side.

The tint moved to the deep end of the same two colour families (about 80% down —
a hole in the shelf rather than another book in it), the volume got wider and
taller than a painted spine, and the gilt spine edge — a 1px inset shadow the
scale erased entirely — became a proportional band standing **outside** the
darkening as a sibling. `mix-blend-mode` makes the patch its own blend group, so
gilt drawn inside it was being multiplied along with everything else, and
multiply cannot lighten: the one bright mark on the wall was coming out as
another shade of the dark it existed to stand against.

`67744e7c` is the second defect. `ArchivedThing['kind']` is
`'commission' | 'assistant'` and the tint table was keyed `assistant` and
`thing`, so a completed commission looked up `undefined` and got no background at
all — an unpainted rectangle with gilt floating on nothing. The compiler had
already caught this; the suite had not, **because the test read the tint table's
own keys back out of it and measured whatever it found**, which asks a table
whether it agrees with itself. It now takes the kinds from `archiveOf`, the
projection that actually shelves things, and asserts a tint exists for each
before measuring. Two lines of production code, and the test goes red on the old
ones.

### 6. "we should capitalize the first letter of the names"

`42be2026`. Summoning from the wall of painted faces put `leo` in the roster;
summoning from the pixel cast beside it put `Jim`. Same control, same field, two
conventions — and the lower-case one then appeared on the card, in the strip, and
in every message the assistant sent.

The pack is named for its files, which are lower case because files are, and the
picker handed that straight through. It is the right payload — naming the
assistant after the portrait is the entire mechanism by which it then wears it —
but a file name is not a name. `portraitLabel` capitalises the first letter, and
only the first, because every face in the pack is one word.

Matching deliberately did not change: `portraitNamed` already lower-cases what it
is given, so the capital cannot cost anybody a face, including assistants already
on the floor summoned in lower case. The test holds both spellings against the
same painting — the assertion that fails if the capital leaks into the lookup.

### 7. "the footer row portraits still show the old pictures"

`2cb8131c`, with `332c86c3` underneath it.

The card strip along the foot of the window was never part of the Study change
and kept drawing recolored pixel sprites, so a worker on the painted floor and
the same worker's card in the strip showed **two different people at once, one
above the other**.

The rule for which painted face an assistant wears is not duplicated here.
`portraitFor` owns it — named for a face wears it, anyone else is dealt one from
their id, the orchestrator's face reserved — and the floor already calls it. The
new `AgentFace` is the one place both surfaces ask, because two call sites each
picking a portrait is how they came apart to begin with. Light and dark fall
through to the sprite they drew before, at the scale they drew it. The card now
takes the agent's id: not displayed, but it is what a face is dealt from when the
name matches nothing in the pack, and without it every stranger in the strip
lands on the same portrait.

`332c86c3` is the harness change that made this testable at all, and it is two
limits that stop a component being *loaded*, not two awkward assertions. A module
that reads its state once as it is evaluated — the app theme, out of localStorage
— can only be observed in one state, because the component reaches it through its
own cached import; `loadTs.reset()` clears the graph so the next load rebuilds
it, which is what lets one file assert both the painted theme and the pixel one.
And requiring any component that portals failed outright, because the real
react-dom reads React's internals on load and the host seeds a hand-written React
that has none; a portal is a placement, not a transformation, so with no document
to place anything in its children are the answer.

---

## The refinement that arrived mid-round

Finding 3 was answered twice. Two rooms per storey (`91e8e597`) made every room
half the house's width instead of a third, but it also left the building five
storeys tall — and four of the ten rooms held nothing but one clickable prop: a
stack of letters, an open almanac, a baize table, a fire.

`8f821259` and `abc8fbbc` are that second answer, and they are deliberately two
commits: the mechanism, then the move.

A room may now declare `props` — an anchor kind plus the berth in *this* panel it
stands on. A prop berth is normalized and checked against its host's panel like
any other and joins the house-wide berth-id list, because a prop is a place in
the painting and two places sharing an id is the same silent collision it always
was. The singleton rule counts an anchor wherever it stands, as a room of that
kind or as a prop on somebody's wall, so the plan can gather its functions into
one room without losing or duplicating something the scene navigates from.
`anchorSeat` replaces `rooms.find(kind)`: a room-kind anchor seats at its first
berth, which is where its badge already went, so the two cases are one lookup.

Then the three function rooms whose props can share a wall moved into one
parlour, on the panel that was the card table. The commissions stay on the baize
the painting puts there, the petitions stack on the cabinet top against the far
wall, and closing time became the door out of the room — which is what closing
time is.

Two rooms fewer, so four storeys instead of five: **3190 by 2778, and 0.259
instead of 0.208 on a 1280x720 floor. Everything in the house is 24.8% bigger for
it.** A dealt commission goes from 20.7x15.9 screen pixels to 25.9x19.9 and its
number from 7.9 to 9.9; an archived spine goes from 13.7x27.9 to 17.1x34.8. The
reading rooms gain the same quarter, which was the point.

The parlour is itself a button, so a prop standing on it has to stop its click,
or pressing the door would also open the board behind the window it just closed;
the count badge stops taking the pointer for the same reason, or the middle of a
prop would be the one part you cannot press.

This is composed over an existing painting — the door and the cabinet are
furniture being *read* as controls rather than painted to be them. A panel
painted for three props would seat them better, and the plan already supports it.

---

## Verification

Every number below was measured in this checkout, with `node_modules` symlinked
from the base clone. The suite's real exit code is reported, not a summary line.

| ref | | tests | pass | fail | cancelled | skipped | exit |
|---|---|---|---|---|---|---|---|
| `782c6657` | the round's base | 1074 | 1037 | 35 | 1 | 1 | 1 |
| `42be2026` | before the last two commits | 1097 | 1059 | 36 | 1 | 1 | 1 |
| `2cb8131c` | this tip | 1102 | **1064** | 36 | 1 | 1 | 1 |

```
npm run typecheck    # node + web, 0 errors
npm run build        # exit 0
```

**The failure set at this tip is identical to `42be2026`, name for name** — the
two lists were diffed, not eyeballed. The five new passes are the five cases in
`test/agent-face.test.cjs`.

**The 35 failures on the round's base are not this round's, and they are not
"tests pass" either.** They are, by suite: 26 in the memory / hindsight backend
conformance suites, which need a server this shell has none of; 3 tilde-expansion
cases (`statAbs`, `ensureHarnessHome`); 3 `forgetAgent` cost-lifetime cases; one
hook-with-no-node-on-PATH case; and `test/proc-kill.test.cjs`, which is cancelled
rather than failed. They are unchanged, one for one, at all three refs.

### The last fix was mutated to prove its test bites

The earlier commits record their own red-first evidence in their messages; that
is their authors' claim, not a measurement repeated here. For `2cb8131c`, four
mutations were run against a green suite in this checkout, and each took down
exactly the cases it should and no others:

| mutation | red |
|---|---|
| never paint — ignore the theme | the three painted cases |
| paint under every theme | the light/dark case only |
| deal strangers by name instead of id | the stranger case only |
| the strip goes back to `SpritePortrait` directly | the wiring case only |

---

## One regression this round introduced, still open

`test/occult-art-sheets.test.cjs` — *"every painted panel the house names has a
sheet, and every sheet a panel"* — **passes on `782c6657` and fails from
`abc8fbbc` onwards.** It is the one failure in the 36 that is ours.

The consolidation folded the hearth and the writing desk into the parlour as
props, so `room-hearth.png` (1.1MB) and `room-writing-desk.png` (1.6MB) are no
longer painted by any room in `room.json`, while both PNGs and their prompt
sheets are still in the tree. The test asserts both directions of that
correspondence, and the reverse direction is now false.

That is a real finding, not a stale test: 2.7MB of paintings ship in every build
for rooms that no longer exist, and two prompt sheets describe panels the house
does not use. **The remedy is a decision rather than a repair** — either the two
panels and their sheets come out (they stay recoverable from history, and the
sheets record model, prompt and reference digest, so they can be regenerated), or
a later art pass repaints a purpose-built parlour panel and they are superseded
then. Nothing was deleted here, because deleting approved artwork on a green-test
errand is the wrong trade.

---

## What cannot be verified in this environment

Every one of the seven findings was reported from the running app, and six of the
seven are visual. Contrast ratios, panel luma, scale arithmetic and per-frame
step bounds are all asserted numerically in the suite, but **"is the fire still
blinking", "can you read the card now" and "does the strip show the same face as
the floor" need a GPU, a running Electron and an eye.** The before/after evidence
for those is a screenshot pair per finding, at one window size and one theme, and
it has to be captured by someone with the app in front of them.

The one exception is finding 7, which has a mechanical check: under the occult
theme, the face on an assistant's card in the footer strip and the face on the
same assistant in the room above it must be the same image.
