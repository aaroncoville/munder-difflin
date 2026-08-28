# Fix round 1 — the stacked-berth regression

One finding, one commit: `5bdc10f9 fix(study): a card sharing a desk stood a
hand's width below it`.

## The defect

`deskLayout` was changed earlier in this branch so the card runs the full
height of its berth, because a berth's bottom edge is the painted desk surface
— that is how every berth in the manifest was read off its painting. But
`stackedBerth`, which deals each extra occupant of a shared desk back from the
one below, only ever **moved** the berth:

```
left: desk.left + desk.width * 0.14 * stackIndex,
top:  desk.top  + desk.height * 0.1 * stackIndex
```

with `...desk` carrying the original width and height through. A full-height
card in a berth pushed down by a tenth of its height therefore has its foot a
tenth of a berth **below** the desk, and each further step compounds it. Run
through the real manifest, every one of the eight reading rooms put a stack
index 1 card foot roughly 29–31 panel pixels below its painted surface.

It is reachable the moment the house holds more assistants than it has reading
desks: `projectScene` round-robins, so the ninth assistant goes back to the
first berth with stack index 1.

The existing `study-desk-layout` test could not see it. That test lays every
berth out straight from the manifest, and a berth straight from the manifest is
stack index 0 — the one case that was never broken.

## The fix

`stackedBerth` now shrinks the berth by exactly what it deals it back, so the
**bottom and right edges never move**:

```
const back = desk.width  * STACK_OFFSET.x * depth;
const down = desk.height * STACK_OFFSET.y * depth;
{ left: +back, top: +down, width: -back, height: -down }
```

The pile still reads as a pile — each card is offset down and to the right of
the one below, leaving a clickable band of it showing — but it leans back
*into* the room rather than sinking through the desk, getting shorter and
narrower with depth instead of longer.

The recession is also bounded now (`STACK_DEEPEST = 4`). Each step eats a fixed
share of the setting, so unbounded steps run out: at seven the width is gone
and at ten the height, and a berth dealt past either is inside out — a card
with a negative height has its foot above its head. Those depths are reachable
(eight desks, ~56 assistants for the width case), so past the bound the pile
stops receding and the deepest occupants share a place. A worse drawing than a
deeper pile; not a card through the floor.

## The test

`test/study-stacked-desk.test.cjs`, walking the path the running scene walks:
`projectScene` → `stackedBerth` → `deskLayout`.

It seats a roster nine times the number of reading desks, so every berth in the
house — the eight reading berths and the god's — is filled at stack indices 0
through 8, then for each place:

- probes the **shipped panel's own pixels** under the card's foot and requires
  at least 70% of them to read as desk wood (the same probe and threshold the
  stack-index-0 test uses);
- requires the card to stay inside the room's natural bounds, top, left, right
  and bottom;
- requires the volume beside the card to stay inside the room;
- requires the dealt-back berth's bottom edge to equal the original berth's,
  i.e. that dealing back did not move the desk surface itself.

The depths are the test's own literal (`TIMES_OVER = 9`), deliberately not read
from `STACK_DEEPEST` — a test that took its depth from the module under test
would agree with whatever that module happened to do.

### RED first, against the code as it stood

```
not ok 1 - a card dealt onto a shared desk still stands on the desk
  desk-2/berth-3#1: 43% of the paint under the card's foot is a desk
not ok 2 - a card dealt onto a shared desk stays inside its room
  desk-1/berth-1#1: dealing back moved the desk surface itself
```

### Then broken three ways to prove it can fail

Each mutation applied alone to the fixed code, and reverted after:

| Mutation | Result |
|---|---|
| berth moves down but keeps its height (the reported regression) | RED — `desk-2/berth-3#1: 29% ... is a desk`, and `dealing back moved the desk surface itself` |
| berth moves right but keeps its width | RED — `desk-2/berth-3#3: 57% ... is a desk`, and `desk-1/berth-2#4: the volume beside the card is off the end of the room` |
| recession never stops (no depth bound) | RED — `desk-2/berth-3#5: 46% ... is a desk` |

## Verification

Run from this worktree, outside the sandbox, exit codes captured.

| | result |
|---|---|
| `node --test test/*.test.cjs` | **1120 of 1121**, 0 failures, 1 skipped, exit 0 |
| `npm run typecheck` (node + web) | 0 errors, exit 0 |
| `npm run build` | succeeds, exit 0 |

The one skip is pre-existing and unrelated. The branch was at 1118 of 1119
before this round; the 2 new tests are this file.

**Not verified here:** as with the rest of this branch, none of it has been
seen in a running Electron window from this worktree. The claim that the card
foot lands on the desk is measured from the shipped panels' pixels and the
layout arithmetic, not from a screenshot. A pass on the running app with more
assistants than reading desks is the thing that would settle it.

## Files touched

- `src/renderer/src/scene/study/StudyScene.tsx` — `stackedBerth`, plus the new
  `STACK_DEEPEST`
- `src/renderer/src/scene/study/useSceneState.ts` — one seating comment that
  said a deep pile "walks off the edge of its own panel", which is no longer
  what happens
- `test/study-stacked-desk.test.cjs` — new
