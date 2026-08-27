# Sixth History theme, Milestone 1 (occult chrome) — implementation summary

Plan: `docs/superpowers/plans/2026-08-27-sixth-history-m1-chrome.md`
Spec: `docs/superpowers/specs/2026-08-27-sixth-history-theme-design.md`

## Verification

Measured on `361bfddd`, the commit this branch was cut from, before any change:

| | baseline | branch HEAD |
|---|---|---|
| `npm run test:focused` | 885 of 885 | **907 of 907** |
| `npm run typecheck` | 0 errors | **0 errors** |
| `npm run build` | — | **succeeds** |

No pre-existing failures. 22 tests added across four files. The production
bundle carries the change: `out/renderer/assets/index-*.css` contains the
occult block and the fingerprinted `cormorant-sc-latin-400-*.woff2`.

Evidence: `evidence/` — before/after light and dark (byte-identical PNGs), the
occult theme, and `evidence/README.md` explaining how they were produced and
what they do not cover.

## Per-task status

| # | Task | Status | Commit |
|---|---|---|---|
| 1 | `occult` theme id | done | `40df59b9` |
| 2 | Consumers handle the third value | done | `40df59b9` |
| 3 | Occult token block + new families | done | `46c6e2e5` |
| 4 | Display face | done | `a50ffa3a` |
| 5 | Primitives learn radius | done | `266ed390` |
| 6 | ReleaseDrop joins the token system | done, changed approach | `afbad0f3` |
| 7 | Occult cursor + selection ground | done | `f313578a` |
| 8 | Licence attribution + logo | done, real logo obtained | `e12b9d85` |
| 9 | Milestone gate | partial — screenshots limited, see below | — |

## Deviations, and why

**Tasks 1 and 2 share one commit.** Widening `AppTheme` breaks its three
consumers at compile time, so splitting them would have left a commit that
does not typecheck. The plan anticipated this and offered the merge as its own
escape hatch. Both tasks' tests and implementation are present.

**Task 6 does not reuse existing tokens.** The plan asked for
`PAPER → var(--cth-paper-100)`, `INK → var(--cth-ink-900)` and so on. Those two
tokens swap between light and dark, and the release drop's title bar paints
`INK` behind `PAPER` text — so that mapping inverts the drop in dark mode,
which the plan's own Global Constraints forbid ("light/dark render
byte-identically"). Constraint wins. Instead the six literals moved into a new
`--cth-drop-*` family whose base values are exactly the landing-site hexes, so
light and dark resolve to what they resolved to before, and the occult block
overrides them.

That block also keeps the drop's mat **light**: the page inside the drop is a
sandboxed iframe with `default-src 'none'` that hardcodes its own cream ground
and cannot read a custom property (`src/shared/releaseDrop.ts`, outside this
milestone's allowed file set). Darkening the mat would open a visible seam
around a page that cannot follow it.

Two of the three title-bar dots were also repeating their constant's hex
literally instead of using it; tokenising fixed that.

**`src/renderer/src/assets/fonts/LICENSE.txt` was modified**, which the plan's
file list does not name. Adding two OFL-licensed font files without adding them
to the notice that ships beside them is a licence breach. A test now pins it.

**`test/load-ts.cjs` gained two affordances**, both needed to test real code
rather than a copy of it: `loadTs.fresh()` (theme.ts reads localStorage at
module load, so a case that wants a different starting theme needs its own
instance), and asset-import handling (Vite hands a component a URL string;
feeding the PNG's bytes to the TypeScript transpiler produced garbage).

**A test that could not fail, caught and fixed.** The first version of the
credit test asserted `JSON.stringify(tree)` *contained* the logo path. It went
green while the component was actually receiving a module object and would have
rendered `src="[object Object]"` — visible only in the screenshot. The
assertion now reads the `img` element's `src` and asserts it is a string; the
fix was reverted once to confirm the tightened assertion goes red.

## Open questions for review

1. **Cormorant SC is the plan's checkpoint.** Task 4 asks Aaron to pick between
   Cormorant, Playfair Display and Poiret One. `after-occult.png` is the
   Cormorant specimen. Swapping is this task re-run with a different family —
   two font files, one token line, one test line.

2. **The theme button's tooltip is now wrong in one state.** `App.tsx` reads
   `appThemeNow === 'dark' ? 'Light theme' : 'Dark theme'` and
   `FullscreenTerminal.tsx` reads the i18n equivalent; under occult both
   announce "Dark theme" when the next theme is light. Fixing it properly needs
   an i18n key, and the locale files are outside this milestone's allowed file
   set — left alone deliberately rather than half-fixed in one of the two
   places.

3. **Milestone 1 non-goals confirmed untouched**, matching the dark theme's own
   precedent: Monaco stays `cth-light`, xterm gets the dark ANSI palette under
   occult (via the new `terminalThemeFor`), the pre-React splash and
   BrowserWindow background stay cream, the 22-icon set is unredrawn, and the
   pixel office floor is untouched.

## Where the work is

Committed on `agent/worker-c31-occult-chrome`, seven commits on top of
`361bfddd`. **Not** on `theme/sixth-history`: that branch is checked out in the
main working copy at `/Users/aaroncoville/code/munder-difflin`, which is the
tree the live app is running from, so this worktree could not take it. The
branches were at the same commit when this started, so
`git branch -f theme/sixth-history agent/worker-c31-occult-chrome` is a
fast-forward. Nothing was pushed.

## What Task 9 could not do

App-level screenshots (floor, Tasks, Settings, terminal, in each theme) were
not captured. A build of this app was running the live agent hive throughout;
Electron holds a single-instance lock and a second instance would have shared
that instance's state. `evidence/README.md` records what would settle it.

## Rework after review

Two findings from review, both fixed on this branch.

**The theme control still presented a binary.** `App.tsx` and
`FullscreenTerminal.tsx` each tested `theme === 'dark'` and picked between a
sun and a moon, which was correct while there were two themes and wrong the
moment there were three: in occult both showed a moon and said "Dark theme"
while a click went to light, and in dark both said "Light theme" while a click
went to occult. `App.tsx`'s aria-label was the fixed string "Toggle dark mode".

This was open question 2 above, left half-fixed deliberately because the locale
files were outside the milestone's file set; the rework widened that set.
`themeControlFace()` in `design/theme.ts` now maps each theme to the icon,
English wording and translation key for the stop a click moves to, and both
controls render it — occult gets `✦`, in the same text-glyph idiom as the
existing `☀` and `☾`. The fullscreen mirror's aria-label carries the same
specific wording as its tooltip rather than a generic one.
`fullscreenTerminal.occultTheme` was added to en, zh-CN and ar;
`fullscreenTerminal.toggleTheme` held only the wrong generic string and was
removed.

Five tests in `test/app-theme.test.cjs` pin all three states. The destination
each face claims is checked against what the **real** `toggleAppTheme()` does
from that state, not against a copy of the cycle, so the mapping cannot drift
away from the ring; the wording must name its destination and no other theme;
`en.json` and the untranslated title bar's string must agree; and neither call
site may hold a theme glyph or a single-theme branch of its own. Confirmed red
by reintroducing the original bug (dark announcing "light") and, separately,
by putting the old ternary back in `App.tsx`.

**The token test could not see the change it existed to catch.** It read the
stylesheets raw, so a comment could satisfy an assertion about what the CSS
declares — including `global.css`'s `@import`, which could have been commented
out with the "the import is present" test still green and the occult theme
silently unloaded. And the light/dark byte-identical contract was checked by
matching six hexes anywhere in the file, which sees a token deleted but not a
value that moved. Comments are now stripped before any capture; the dark block
is pinned as an exact normalized snapshot (one declaration per line, so a
failure reads as a diff) and the base `:root` as a sha256 plus a declaration
count. Confirmed red by mutating a dark hex, a base value, and the `@import`
in turn.

| | branch HEAD | after rework |
|---|---|---|
| `npm run test:focused` | 907 of 907 | **913 of 913** |
| `npm run typecheck` | 0 errors | **0 errors** |

Screenshots of the three button states were not captured, for the same reason
Task 9's were not: a build of this app was running throughout and Electron
holds a single-instance lock. `evidence/README.md` records what would settle
it — the three states are one screenshot each of the title bar, in light, dark
and occult.

---

# Sixth History — Milestone 2 (The Study): implementation summary

Branch `agent/worker-c32-study-scene`, cut from `theme/sixth-history` at `4a4ff38f`.
Eight commits, one per task. Nothing pushed.

## Gate

| Check | Baseline (`4a4ff38f`, before any change) | After |
|---|---|---|
| `npm run test:focused` | **913 of 913** pass, 0 fail | **973 of 973** pass, 0 fail |
| `npm run typecheck` | 0 errors | 0 errors |
| `npm run build` | succeeds | succeeds |

All three run unsandboxed. The 60 new tests are the seven `test/study-*.test.cjs`
files. No pre-existing failures on either side, so nothing is being carried.

`npm run dev` was not run: launching the Electron app needs the single-instance
lock and a real GPU, and judging a painted scene needs eyes. **App-level visual
QA is Aaron's.** What to look at is listed under *Manual QA* below.

## Per-task status

| # | Task | Status | Commit |
|---|---|---|---|
| 1 | Room manifest — schema, loader, validation | done | `16badd19` |
| 2 | Placeholder backdrop + scene shell | done | `7a96e3b3` |
| 3 | AgentCard | done | `b33d82fa` |
| 4 | DeskBook + SpeechScroll | done | `d0372721` |
| 5 | Portrait mapping | done | `0666efae` |
| 6 | Store projection | done | `91b95e3e` |
| 7 | FloorHost — the one integration point | done | `4d9a6c9c` |
| 8 | Scene assembly | done | `28ac457c` |
| 9 | Milestone gate | done | — (this file) |

Every task was written test-first: failing test, RED confirmed, implement, GREEN.
Each finished task was then **mutation-tested** — the implementation was broken in
several specific ways and the suite re-run to confirm it went red. Five mutations
survived the first pass and each exposed a genuine hole that was closed before the
task was committed:

- `AgentCard` glide asserted only that *some* motion token appeared, so deleting
  the vertical half of the transition went unnoticed.
- `DeskBook` never checked that a **sealed** book is a *closed* book, so drawing
  it with its pages open passed.
- The token-literal audit ran only on the open book, so the ribbon — which only
  exists on a sealed one — could carry a hard-coded colour.
- Seating asserted only "one berth per desk", which a wrapping overflow also
  satisfies while seating newcomers on top of the people at the front.
- Nothing proved the scene consults the portrait mapping at all, because the
  shipped pack is empty and an uncalled mapping is invisible until art lands.

## Deviations from the plan

1. **`ATTRIBUTION-SIXTH-HISTORY.md` was modified** (a second existing file
   besides `App.tsx`). The dispatch said App.tsx only; plan Task 5 explicitly
   requires extending the attribution, and it is a licence obligation — the
   portrait directory is a place anyone can drop a file into, so the rule
   governing it has to be written where the rule lives. 16 added lines, no
   existing line changed.

2. **Portrait discovery uses a generated index, not `import.meta.glob`.** The
   plan offered either. `import.meta` is a syntax error under the CommonJS
   transpile `test/load-ts.cjs` performs, so a glob would have made
   `portraits.ts` — and everything importing it, i.e. the whole scene —
   untestable in this harness. The index is generated by
   `assets/portraits/make-portrait-index.cjs`, and a test holds it against the
   directory so a stale index fails the suite rather than silently dropping the
   new portraits.

3. **`FloorHost` reaches `OfficeFloor` through `React.lazy`.** The plan said
   "re-exported lazily" and this follows it literally, for two reasons that both
   turned out to matter. Pixi and the tileset atlases are the largest thing the
   renderer loads and the occult theme draws none of it — the office now builds
   as its own 663 kB chunk instead of sitting in the main bundle. And
   `OfficeFloor` cannot be loaded outside Vite at all (it carries `?url` asset
   imports), so a static import would have left the switch checkable only by
   grepping the source.

4. **Anchor labels are English literals**, not i18n keys — `ANCHOR_LABEL` in
   `StudyScene.tsx`. They are the Study's vocabulary ("Petitions", not "Ask
   Me"), and putting that wording into the shared catalog before the `en-SH`
   locale exists would show occult phrasing under light and dark too. The plan's
   own acceptance test names these strings literally. One table to key up in M3.

5. **The shelves anchor is not clickable.** The spec gives it the done archive
   and one scripted animation (book flies desk → shelf), and that animation is
   M3. It renders as a labelled region with no button semantics rather than
   offering a screen reader a control that does nothing.

6. **The placeholder backdrop ships with its generator**
   (`assets/make-placeholder-backdrop.cjs`, ~90 lines, no dependencies). It
   paints the room ground with a faint block under every rectangle `room.json`
   declares, so a berth authored at a wrong coordinate is visible *in the image*
   rather than only as a card hovering over nothing. Nothing imports the script,
   so it is not bundled. The art track replaces the PNG; the generator can then
   be deleted or kept as a layout debug view.

## Store selectors — what actually exists

The dispatch asked for the real fields to be discovered rather than assumed.

- **Roster**: `useStore((s) => s.agents)`, the same list `OfficeFloor.tsx` reads
  (`scene/office/OfficeFloor.tsx:787`, `:1575`, and elsewhere). `archivedAgents`
  is a separate list and stays off the floor, exactly as the office does it.
- **Navigation**: `select(id)` and `requestCommandCenterTab(tab)` — the same two
  the office props fire (`OfficeFloor.tsx:315`, `:1041`, `:1147-1150`,
  `:1403`). The hearth calls `window.close()`, as the office clock does
  (`:1129`).
- **Speech has a store source after all.** The dispatch offered "per-agent speech
  feed" as an example of something with no source; there is one. The office
  bubbles show `agent.action`, falling back to the first few words of
  `agent.lastPrompt` (`OfficeFloor.tsx:150-166`), and `SpeechScroll` renders
  exactly that. Nothing returns an empty value as a placeholder.
- **Tasks and asks are NOT in the renderer store.** They are not in `OfficeFloor`
  either — the office floor never reads them. The kanban gets them from
  `window.cth.hiveTasks()` on a 5s poll, normalized by `parseTasks()` from
  `components/TasksKanban.tsx`. `useSceneState` makes the same call and reuses
  the same `parseTasks` / `waitsOnHuman` helpers, so the Study and the kanban can
  never disagree about what a card's status or an open question is. This is an
  existing bridge call, not new IPC, and no store field was added. A missing
  bridge (`window.cth` absent) yields an empty ledger and a standing room, which
  is covered by a test.

So every field on `SceneAgent` is fed from something real; none is stubbed out.

## Things worth knowing

- **Eight desk berths.** A ninth assistant shares the last desk rather than the
  scene inventing furniture the painting does not have. Deliberate, and tested.
- **Seating follows roster order**, which the user can already rearrange in the
  agent strip — so the room and the roster agree, and summoning someone new
  never reshuffles the people already sitting down.
- **Ten store statuses collapse to four** on the card. `waiting` joins `blocked`
  (both mean nothing is advancing); `ghost` draws as archived, i.e. faded, which
  is what the office floor does with it too.
- **The ambiance slot is mounted and empty**, carrying `pointer-events: none`
  from the start so the M3 layer cannot intercept a click when it arrives.
- `test/study-scene.test.cjs` walks *through* the scene's presentational
  wrappers, because `render-hooks.cjs` mounts one component and does not recurse
  — without that every assertion about the card layer would pass vacuously on an
  empty room. The wrappers it expands use no hooks, which is what makes it safe.

## Open questions

1. **Berth coordinates are placeholder.** They were authored against the
   generated backdrop at 1344×768 and are laid out to be legible, not to be
   pretty. The art track revises the numbers; the shape is the contract. Nothing
   in code needs to change when it does.
2. **Should archived assistants appear on the shelves?** Right now they leave the
   room entirely, matching the office floor. The spec gives the shelves to the
   done *archive* (completed books), which is a different thing — worth a
   decision before M3 builds the fly-to-shelf animation.
3. **`ANCHOR_LABEL` needs keying up in M3** along with the rest of the `en-SH`
   work. Left as one table on purpose.
4. **Contain-fit leaves letterbox bars** at aspects far from 16:9 (the app window
   is resizable). They paint `--cth-cream-300`. If that reads badly at extreme
   sizes the alternative is a cover-fit that crops the painting — which would
   move berths off screen, so it would need the manifest to declare a safe area.

## Manual QA (Aaron)

Switch the theme ring to occult (title-bar control, third stop) with the app
running and at least two assistants on the roster, then check:

1. The painted room replaces the pixel floor; switching back to light or dark
   brings the office back unchanged.
2. Cards sit on the faint desk blocks in the backdrop, and the god's card is the
   larger one, front-centre.
3. Clicking a card selects that assistant. Clicking the card table opens Tasks,
   the almanac opens Triggers, the writing desk opens Ask Me *and* selects the
   god, the hearth asks to close the app.
4. With a card in `doing`, its assistant has an open book; block it with a
   question and the book seals and the writing desk shows a count.
5. Resize the window: cards and props stay on their desks at every aspect.

---

# Sixth History — Milestone 2, the Hush House refactor

The scene design changed mid-build: the Study is no longer one painting with
things placed on top of it. It is a **cross-section of a house** — flat and
straight on, no perspective — where each room is its own panel, panels sit side
by side to make a storey, and the storeys stack from the top of the building
down with a band of masonry between them. A house taller than the window
scrolls.

One commit, `refactor(study): rooms replace the single backdrop`, on top of the
eight task commits.

## Gate

| Check | Baseline (`4a4ff38f`, before any of M2) | Before the refactor | After |
|---|---|---|---|
| `npm run test:focused` | **913 of 913** | **973 of 973** | **983 of 983** pass, 0 fail |
| `npm run typecheck` | 0 errors | 0 errors | 0 errors |
| `npm run build` | succeeds | succeeds | succeeds |

All three run unsandboxed. No pre-existing failures on any of the three refs,
so nothing is being carried. The production bundle carries the change:
`out/renderer/assets/index-*.js` contains `data-study-room` and all seven panel
filenames (the flat placeholders are small enough that Vite inlines them as
data URIs rather than emitting separate asset files).

The refactor was written test-first like the tasks before it: the manifest
tests were rewritten against the new shape and confirmed **RED, 12 of 12**
before `roomManifest.ts` was touched; the scene tests likewise. Each finished
piece was then **mutation-tested** — eight mutations, each confirmed to take the
suite red and each reverted to green:

| Mutation | Caught by |
|---|---|
| storeys sorted bottom-up | rooms are stacked in reading order |
| the masonry bands dropped | …with masonry between the storeys |
| `overflow-y: hidden` | the house scrolls vertically |
| every room draws every seated assistant | a card is a child of its own room's panel |
| the panel's view box doubled | the first worker sits at the first desk |
| a room image with no import behind it | every panel … is on disk … and imported |
| the archive given a click handler | the archive is a room you can read but not press |
| berth ids checked per room instead of per house | two rooms claiming the same berth id are rejected |

## What the model is now

`assets/room.json` is `rooms[]` plus a house-level `bandThickness`. Each room is

```
{ id, kind, image, natural: { w, h }, row, col, berths: Berth[], lightPoints[] }
```

and every berth is normalized **within that room's panel**, not against a shared
canvas. `kind` is what the room is for: eight `desk` rooms, one `godStudy`, and
one room for each of the five props — `cardTable`, `writingDesk`, `almanac`,
`hearth`, `shelves`. The shipped house is five storeys, read top to bottom:

| Storey | Rooms |
|---|---|
| 0 | the archive, full width |
| 1 | the card table, the almanac |
| 2 | reading rooms 1–4 |
| 3 | reading rooms 5–8 |
| 4 | the god's study, the writing desk, the hearth |

`validateRoomManifest` keeps every check it had and gains the ones the new shape
makes possible: berth ids unique across the **whole house** (two rooms sharing
one would draw the same assistant twice and make seating depend on iteration
order), each berth checked against its own panel, the singleton kinds actually
singular, the god's study actually holding a seat, and no two rooms standing on
the same row and column. `deskRooms`, `deskBerths`, `godBerth`, `roomOfKind` and
`houseRows` are the accessors everything else reads the house through.

## What changed in the scene, and what did not

**Unchanged, as required:** `AgentCard`, `DeskBook`, `SpeechScroll`,
`portraits.ts`, `FloorHost.tsx`, and `App.tsx`. `berthToBox` and `containFit`
keep their names, signatures and behaviour — they now run per panel instead of
once over a backdrop.

**`useSceneState` changed in one place only:** seating asks the manifest for
`deskBerths(studyRoom)` and `godBerth(studyRoom)` instead of reading two fields
off it. The rule is the same rule — roster order, the god in his own seat, the
overflow sharing the last desk — but the berths now come from the reading rooms
in the order the house is built, so adding a storey of desks extends the seating
with no code change.

**The props are rooms now.** There is no `AnchorZone` and no invisible rectangle
over a painting: the room panel itself carries the label, the button semantics
and the click, so clicking the card table's room *is* clicking the card table.
Nothing can drift out of step with the art, because there is nothing to keep in
step. The archive still renders without button semantics, for the same reason as
before — the animation that would justify a control is M3.

**The scene takes exactly one measurement:** the width of the scroll host. Every
storey height and every panel box is arithmetic from that one number
(`storeyHeight` solves for the height at which a storey's rooms exactly fill the
width, capped at their natural height so a wide window cannot inflate the
building). That keeps the room components hook-free, which is what lets a test
walk through them, and makes the whole layout a pure function of the manifest.

**Each panel still letterboxes its own image.** With the shipped placeholders
the fit is exact, because every room in a storey shares a natural height. It
stops being exact the moment real art arrives at a slightly different aspect,
and then a panel is centred rather than stretched — which is the whole reason
the math stayed.

**Every room reserves its own ambiance slot**, `pointer-events: none` from the
start, rather than one slot over the whole scene. M3's hearth glow belongs to
the hearth's room; `lightPoints` moved from the house onto the rooms to match.

## Superseded above

These lines in the Milestone 2 section above are no longer true:

- **Task 1 and Task 2 as described** — there is no single backdrop, no
  `deskBerths`/`godBerth`/`anchors` on the manifest, and no
  `backdrop-placeholder.png`. `make-placeholder-backdrop.cjs` is replaced by
  `make-room-panels.cjs`, which paints one flat panel per room image at the
  natural size the manifest declares, with a faint block under every berth and a
  disc at every light point. Rooms sharing a file (the eight reading rooms do)
  are drawn once, and a second room disagreeing about that file's natural size
  is reported rather than silently redrawn.
- **Deviation 6** (the placeholder backdrop ships with its generator) still
  holds in spirit, for the new generator.
- **Open question 4** (contain-fit letterbox bars at extreme aspects) is
  answered by the new layout: the house fills the width and scrolls vertically,
  so there are no bars at the scene level. The per-panel bars remain, but they
  are a panel's worth of cream rather than the whole window's.
- **Open question 1** (placeholder berth coordinates) still stands, restated:
  the berths are now authored against small flat panels rather than one 1344×768
  image. The numbers are placeholder; the shape is the contract.

Everything else in the Milestone 2 section — the store selectors, the status
collapse, the seating rules, the portrait index, `FloorHost`'s lazy office
chunk, the anchor labels being English literals — is unaffected.

## Manual QA (Aaron)

As before, plus:

6. The house reads as a cross-section: the archive along the top, the card table
   and almanac beneath it, two storeys of reading rooms, and the god's study,
   the writing desk and the hearth along the bottom, with mortar between the
   storeys.
7. Make the window short: the lower storeys are reachable by scrolling, and the
   house never scrolls sideways.
8. Make the window very wide: the storeys stop growing at their natural height
   and centre, rather than the building growing without limit.
