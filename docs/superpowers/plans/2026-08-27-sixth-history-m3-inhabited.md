# Sixth History Theme — Milestone 3 (The Inhabited House) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The house stops being a set of painted rooms and becomes a place somebody lives in — candles that actually flicker, an app that speaks in the Study's own voice, terminals and editors lit by the same candle, gilt icons instead of pixel ones, a shelf that fills as work is finished, task cards you can pick up off the baize, and the licensed faces on the cards.

**Spec:** `docs/superpowers/specs/2026-08-27-sixth-history-theme-design.md`
**Predecessors:** M1 (`…-m1-chrome.md`) shipped the tokens, fonts and primitives; M2 (`…-m2-study.md`) shipped the painted cross-section, its manifest and its cards.

**Tech Stack:** React 18 inline styles + `--cth-*` tokens, `pixi.js` (already a dependency), i18next (already wired), xterm + Monaco (already wired), node:test + `test/load-ts.cjs` / `test/render-hooks.cjs`.

## Baseline

Measured on `3d313d4d`, the ref this milestone starts from, before any change:

```
node --test test/*.test.cjs
# tests 998 · pass 962 · fail 35 · cancelled 1     (exit 1)
```

The 35 are the memory/hindsight backend suites, which need a server this
environment does not run; `test/proc-kill.test.cjs` is the cancelled file.
Every count below is reported as **N of M** against this baseline.

## Global Constraints

- Branch `theme/sixth-history`. Commit per task, plain messages, no pushing.
- **Light and dark must render byte-identically.** `test/occult-tokens.test.cjs`
  pins the base `:root` by hash and the dark block declaration-for-declaration.
  M3 is therefore designed to need **no new design token at all** — everything
  it draws is expressible in the families M1 already added. If a task finds it
  needs one, that is a signal the design is wrong, not that the pin should move.
- Every behaviour added here is **inert outside the occult theme**. The gate is
  always `useAppTheme() === 'occult'`, and the else-branch must be the code that
  runs today, unchanged.
- New-files-first. The existing files M3 is permitted to touch, and the whole
  of what it may do to each:

  | File | Edit |
  |---|---|
  | `i18n/index.ts` | register one locale, export the theme-follow hook |
  | `design/theme.ts` | add `terminalPaletteFor` beside `terminalThemeFor` |
  | `components/PtyTerminalView.tsx`, `components/TerminalView.tsx` | read the palette through the new selector |
  | `ide/monaco.ts` | define + select the occult editor theme |
  | `components/Icon.tsx` | choose the path table by theme |
  | `components/AddAgentModal.tsx` | swap one picker under occult |
  | `scene/study/StudyScene.tsx` | mount the ambiance layer, the shelf, the baize cards |
  | `scene/study/portraits.ts`, `…/assets/portraits/make-portrait-index.cjs` | name-aware assignment |

- Tests: `node --test test/<file>` per task; the whole suite at the gate.

## Two design decisions taken up front

Both were forced by what the code actually does, and both are recorded here
because a reviewer will otherwise read them as the task being dodged.

**1. The terminal has two "themes", and only one of them can be occult.**
`terminalThemeFor()` feeds two consumers that look alike and are not:

- `notifyThemeChangeAll()` writes **DEC mode 2031** to running programs —
  `CSI ? 997 ; 1 n` for dark, `; 2 n` for light. The protocol has two values.
  There is no third.
- `updateConfig({ terminalTheme })` persists a field `main/config.ts` types as
  `'light' | 'dark'` and `main/realtimeActions.ts` validates against exactly
  that pair, and spawned agents read it to theme *their own* TUI.

Neither can be told "occult" without lying to a program that will act on it.
So `terminalThemeFor()` keeps its signature and its meaning — *what an external
program should be told about the ground it is drawing on*, for which occult is
a dark terminal and always will be. The candlelight lands in a **new**
selector, `terminalPaletteFor()`, which answers a different question — *which
of our own xterm palettes to paint* — and is the only thing the renderer's own
terminals read. Extending one function to serve both would have put the string
`occult` into a config schema in the main process for no gain.

**2. The archive shelf can be bounded by count honestly, and by age only where
there is an age.** `HiveTask` carries `createdAt` and no completion timestamp;
`Agent` carries no archival timestamp at all. So the age window is applied to
what has a date (a finished commission, dated by `createdAt` — the nearest
honest proxy, and named as one in the code), while an archived assistant is
ordered by its position in `archivedAgents`, which is append-order and so is a
real ordering even without a clock. Both are bounded by the count cap
regardless. Parked in SUMMARY.md as a question for Aaron: a `completedAt` on
the task ledger would make the window exact, and is a hive-side change.

---

### Task 1: `en-SH` — the house speaks

**Files:**
- Create: `src/renderer/src/i18n/locales/en-SH.json`, `src/renderer/src/i18n/useThemeVoice.ts`
- Modify: `src/renderer/src/i18n/index.ts`, `src/renderer/src/App.tsx` (one hook call)
- Test: `test/i18n-sixth-history-voice.test.cjs`

**What it is:** a **partial** locale. `en.json` has 1198 keys and the Study does
not re-voice 1198 things — it re-voices the nouns in the spec's glossary and
the sentences those nouns appear in. Every other key falls through to `en` by
i18next's own `fallbackLng`, which is the mechanism the spec asked for
("complete coverage with fallback-to-English for any key upstream adds later")
and the reason a key upstream adds tomorrow costs this locale nothing.

**Glossary (from the spec), and the rule:** flavour lives in nouns, never in
what a control *does*. `Save` stays `Save`.

| App | The house |
|---|---|
| agent / agents | assistant / assistants |
| hive / team | the House |
| spawn / hire / add agent | summon |
| task / tasks | commission / commissions |
| tokens / cost | essence |
| Ask Me | Petitions |
| Closing Time | the Hour of Rest |
| kanban columns | Intended / Underway / Impeded / Concluded |
| archive | the shelves |
| terminal | the speaking-glass |

**Interfaces:**
```ts
// i18n/index.ts
export const THEME_VOICE = 'en-SH';
// i18n/useThemeVoice.ts
export function voiceFor(theme: string, current: string): string | null
export function useThemeVoice(): void   // App-level; drives i18n from the theme
```

`voiceFor` is the whole rule and it is pure, so it is the thing the test pins:

- occult + `'en'` → `'en-SH'` (the house takes its own voice)
- non-occult + `'en-SH'` → `'en'` (leaving the house gives it back)
- occult + `'zh-CN'` / `'ar'` → `null` — **never** override a language somebody
  chose. The voice is a register of English, not a translation, and silently
  replacing Arabic with English because a theme changed would be a bug that
  looks like data loss.
- anything already correct → `null` (no redundant `changeLanguage`)

The switch is deliberately **not persisted**: it is derived from the theme, so
an explicit pick in Settings is still what survives a restart.

- [ ] **Step 1: Write the failing test.** Assert `voiceFor` for all four rows
  above; assert `en-SH.json` parses and every key it declares also exists in
  `en.json` (a key the base does not have is a key nothing will ever read);
  assert the glossary actually landed — e.g. the value at the key `en.json`
  uses for the kanban's `done` column reads `Concluded` in `en-SH`; assert
  `en-SH` is registered in `resources` and `supportedLngs` in `index.ts`.
- [ ] **Step 2: Run — FAIL** (locale absent).
- [ ] **Step 3: Implement.** Write `en-SH.json` covering the glossary's reach;
  register it; `useThemeVoice()` subscribes to `useAppTheme()` and calls
  `i18n.changeLanguage(voiceFor(...))` when it returns non-null; call it once
  in `App.tsx`.
- [ ] **Step 4: Run — PASS.** **Break it to prove it:** change one `en-SH`
  value back to its English wording → the glossary assertion must go red.
  `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `feat(i18n): the house speaks in its own register under the occult theme`

### Task 2: The candlelit terminal and editor

**Files:**
- Create: `src/renderer/src/design/occult/occultTerminal.ts`
- Modify: `src/renderer/src/design/theme.ts`, `components/PtyTerminalView.tsx`, `components/TerminalView.tsx`, `ide/monaco.ts`
- Test: `test/occult-terminal.test.cjs`

**Interfaces:**
```ts
// design/theme.ts
export type TerminalPalette = 'light' | 'dark' | 'occult';
export function terminalPaletteFor(t: AppTheme): TerminalPalette;   // identity
// design/occult/occultTerminal.ts
export const occultTerminalTheme: XtermTheme;   // 16 ANSI + ground/cursor/selection
export const OCCULT_MONACO_THEME = 'cth-occult';
export const occultMonacoTheme: MonacoThemeData;
```

The palette is warm parchment ink on the occult `--cth-paper-100` ground
(`#262134`), so a terminal sits on the same surface as the panel holding it —
the exact drift the dark palette's own comment warns about. Sixteen ANSI slots
in candlelight: golds and ambers where dark used cool blues, Grail crimson for
red, a muted teal for cyan, parchment for white. Values are re-stated literals
with the token they mirror named in a comment, because xterm cannot read CSS
custom properties — same discipline, same reason, as the two palettes above it.

- [ ] **Step 1: Failing test.** `terminalPaletteFor('occult') === 'occult'`
  while `terminalThemeFor('occult') === 'dark'` **still holds** (the DEC-2031
  contract — this assertion is the guard on decision 1 above, and it is why the
  test names the mode). Assert the occult palette declares all 16 ANSI names
  plus `background`/`foreground`/`cursor`/`selectionBackground`, that its
  background equals the occult `--cth-paper-100` value read out of
  `occult-tokens.css` (so the two cannot drift silently), and that
  `PtyTerminalView`'s `THEMES` map has an `occult` entry. Assert `monaco.ts`
  defines `cth-occult` and selects it for the occult theme.
- [ ] **Step 2: FAIL.** **Step 3:** Implement. **Step 4:** PASS; **break it to
  prove it** — change the occult `--cth-paper-100` hex in the CSS and the
  drift assertion must go red. **Step 5:** Commit
  `feat(theme): a candlelit palette for the terminal and the editor`.

### Task 3: The deco icon set

**Files:**
- Create: `src/renderer/src/components/decoIcons.ts`
- Modify: `src/renderer/src/components/Icon.tsx`
- Test: `test/deco-icons.test.cjs`

`Icon.tsx` holds 24 names on a 16×16 integer pixel grid with
`shapeRendering="crispEdges"`. The deco set is the same 24 names redrawn as
gilt line-work on the same 16×16 viewBox — but *not* crisp-edged, because the
whole point of the redraw is the curve. `Icon` therefore picks both the table
and the rendering hint by theme, and its public contract (`name`, `size`,
`style`, `currentColor` ink) does not move: every one of the ~200 call sites
stays exactly as written.

- [ ] **Step 1: Failing test.** Assert `DECO_PATHS` covers **every** `IconName`
  — derived from `Icon.tsx`'s own union, parsed out of the source, so a name
  added upstream fails here rather than rendering as a blank square. Assert
  every `d` is non-empty and parses as a path (a leading `M`, only legal
  command letters); assert no deco path is byte-identical to its pixel
  counterpart (a "redraw" that copied the original is the defect this whole
  task exists to avoid); assert `Icon.tsx` reads the theme and drops
  `crispEdges` under occult.
- [ ] **Step 2: FAIL.** **Step 3:** Implement — 24 paths, gilt deco idiom:
  swept curves, tapered terminals, a mirrored axis where the glyph allows it.
  **Step 4:** PASS + typecheck. **Step 5:** Commit
  `feat(icons): a gilt deco redraw of the icon set for the occult theme`.

### Task 4: The ambiance layer

**Files:**
- Create: `src/renderer/src/scene/study/AmbianceLayer.tsx`, `src/renderer/src/scene/study/ambiance.ts`
- Modify: `src/renderer/src/scene/study/StudyScene.tsx` (mount it in the slot M2 reserved)
- Test: `test/study-ambiance.test.cjs`

The slot already exists, already sized to the panel's letterboxed view box, and
is already `pointer-events: none` by contract. M3 fills it.

**Interfaces:**
```ts
// ambiance.ts — all the arithmetic, none of the pixi
export const MOTE_CAP = 24;          // per room
export const GLOW_CAP = 12;          // per room
export interface Mote { x: number; y: number; vx: number; vy: number; r: number }
export function seedMotes(seed: number, count: number, view: {w:number;h:number}): Mote[]
export function driftMotes(motes: Mote[], dtMs: number, view: {w:number;h:number}): void
export function flicker(t: number, i: number): number    // 0.55..1, per light point
export function ambianceEnabled(reducedMotion: boolean, visible: boolean): boolean
// AmbianceLayer.tsx
export function AmbianceLayer(props: { room: Room; view: ViewBox }): JSX.Element | null
```

`ambiance.ts` is where the test lives, because it is pure: seeding is
deterministic from a seed (a room whose motes reshuffle every render is a
strobe), drift wraps at the edges rather than leaking motes off-panel, and the
caps are constants the test reads rather than restates. `AmbianceLayer` is the
pixi shell: a `Application` on a canvas sized to `view`, glow sprites at the
room's `lightPoints` (which `room.json` has carried since M2, unused until
now), motes above them, a ticker that stops on `document.hidden` and never
starts under `prefers-reduced-motion`.

- [ ] **Step 1: Failing test.** Same seed → identical motes; different seeds →
  different; `driftMotes` keeps every mote inside `view` across 1000 steps;
  `flicker` stays inside its band and is not constant; `ambianceEnabled` is
  false under reduced motion **and** false when hidden; `MOTE_CAP` is respected
  by `seedMotes` when asked for more. Assert `StudyScene` mounts the layer
  inside `data-study-slot="ambiance"` and that the slot still declares
  `pointerEvents: 'none'` (the input contract — if this ever goes, every click
  in the Study goes with it).
- [ ] **Step 2: FAIL.** **Step 3:** Implement. Pixi is imported **lazily**
  inside the layer so the office floor never pays for it. **Step 4:** PASS;
  **break it to prove it** — remove the reduced-motion guard and the gate
  assertion must go red. **Step 5:** Commit
  `feat(study): candlelight, dust and hearth-smoke over the painted rooms`.

### Task 5: The shelf archive

**Files:**
- Create: `src/renderer/src/scene/study/shelfArchive.ts`, `src/renderer/src/scene/study/ShelfArchive.tsx`
- Modify: `src/renderer/src/scene/study/useSceneState.ts` (project the archive), `src/renderer/src/scene/study/StudyScene.tsx` (draw it in the shelves room)
- Test: `test/study-shelf-archive.test.cjs`

Aaron's design: the shelves room is a painting of light books, so an archived
item **darkens and saturates** a book-shaped region of it. Darkening is the
emphasis because the books are light — the inverse of the usual "light it up",
and the reason the code says `darken` and not `highlight`.

**Interfaces:**
```ts
export const ARCHIVE_MAX = 24;        // books the shelf wall can hold
export const ARCHIVE_WINDOW_DAYS = 14;
export interface ArchivedThing { id: string; label: string;
  kind: 'commission' | 'assistant'; at: number | null }
export function shelfBooks(things: readonly ArchivedThing[], now: number,
  max?: number, windowDays?: number): ArchivedThing[]
export function bookSlot(index: number, view: ViewBox): Box
```

`shelfBooks` is the bound, and it is the whole of the bound: drop anything
dated outside the window, keep the newest `max`, **oldest falls off first**,
undated entries (archived assistants) keep their list order and are only ever
cut by the cap. Both numbers are exported constants with the reasoning above
them, per the dispatch.

`bookSlot` lays a book onto the shelf wall using the shelves room's own
`lightPoints` — ten of them, already in `room.json`, already sitting on the
painted shelf rows — so a book lands *on a shelf in the painting* rather than
at a coordinate somebody guessed. Past the tenth it walks along the row.

Archived **assistants do** appear here, per the dispatch.

- [ ] **Step 1: Failing test.** More than `ARCHIVE_MAX` in → exactly
  `ARCHIVE_MAX` out, and the ones that survive are the newest (assert the
  *oldest* is the one missing — asserting the length alone would pass on a
  bound that dropped the wrong end); an entry older than the window is dropped
  while an undated one at the same position is not; `bookSlot` boxes stay
  inside `view` and no two of the first ten overlap. Then a scene test: seed
  the store with an archived agent and a done task, mount, assert two
  `data-shelf-book` elements in the shelves room, each carrying its label as a
  `title`.
- [ ] **Step 2: FAIL.** **Step 3:** Implement. The book is a darkening overlay
  — `mixBlendMode: 'multiply'` over the panel in a warm ink, plus a saturating
  pass — with a hairline gilt edge, all from existing tokens. **Step 4:**
  PASS. **Break it to prove it:** raise `ARCHIVE_MAX` past the seeded count in
  the implementation only and the bound assertion must go red. **Step 5:**
  Commit `feat(study): finished work darkens a book on the shelf wall`.
- [ ] **Step 6 (budget permitting):** the book-flies-to-shelf animation. If the
  budget is gone when the rest of M3 is done, park it in SUMMARY.md with what
  remains — the dispatch permits exactly that, and a half-built animation is
  worse than an honest note.

### Task 6: Task cards you can pick up off the baize

**Files:**
- Create: `src/renderer/src/scene/study/BaizeCards.tsx`
- Modify: `src/renderer/src/scene/study/useSceneState.ts` (carry the tasks through), `src/renderer/src/scene/study/StudyScene.tsx`
- Test: `test/study-baize-cards.test.cjs`

Today the card-table room paints four column counts and the whole *room* opens
Tasks. M3 deals the actual commissions onto the baize as small numbered cards,
and clicking one opens **that** commission — `openTaskDetail(id)`, the same
app-wide overlay a kanban card opens, which is what "the same surface the
kanban uses" means and is why no new surface is built here.

This matches the interaction the agent cards already have: the card is the
control, it carries `role="button"`, and it answers Enter and Space. The room
underneath keeps its own click (open Tasks) — so the card's handler must
`stopPropagation`, or picking up a card would open the board behind it too.

**Interfaces:**
```ts
export const BAIZE_MAX = 8;    // cards the table can be dealt without stacking illegibly
export function dealBaize(tasks: readonly HiveTask[], baize: Box):
  { task: HiveTask; box: Box; n: number }[]
export function BaizeCards(props: { tasks: readonly HiveTask[]; baize: Box;
  onOpen: (id: string) => void }): JSX.Element
```

Dealing order is the kanban's: impeded first, then underway, then intended —
what a person crossing the room needs to see is what is stuck. `n` is the
commission's own number off its id (`T-7` → 7), falling back to its position,
so the card on the table and the card on the board are recognisably the same
card.

- [ ] **Step 1: Failing test.** `dealBaize` never returns more than
  `BAIZE_MAX`; every box lands inside `baize`; blocked tasks come first; `n`
  reads the id's number and falls back when the id has none. Then a scene
  test: seed three tasks, mount, assert three `role="button"` cards inside the
  card-table room, and that invoking one's `onClick` calls `openTaskDetail`
  with **that** task's id — and that the same event does **not** also fire the
  room's navigation (the stopPropagation contract; assert the room handler was
  not called, not merely that the detail opened).
- [ ] **Step 2: FAIL.** **Step 3:** Implement. **Step 4:** PASS. **Break it to
  prove it:** drop the `stopPropagation` and the room-handler assertion must go
  red. **Step 5:** Commit
  `feat(study): the commissions on the card table open the card they name`.

### Task 7: The portrait pack

**Files:**
- Add: 47 portraits + `fascination.png` into `src/renderer/src/scene/study/assets/portraits/`
- Modify: `…/assets/portraits/make-portrait-index.cjs` (emit names beside files), `src/renderer/src/scene/study/portraits.ts`, `src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md`
- Create: `src/renderer/src/components/PortraitPicker.tsx`
- Modify: `src/renderer/src/components/AddAgentModal.tsx`
- Test: `test/study-portraits.test.cjs` (extend), `test/portrait-picker.test.cjs`

**What goes in.** The pack mirror holds 92 files. Only the **people** go: the
`cult*`, `way*` and aspect/element cards are iconography, not faces, and a
worker wearing the Moth aspect card is not a portrait of anybody.
`hive/config/worker-name-pool.txt` already carries that split as a checked-in
list of 47 names — it is the source of truth for which files are copied, and
copying from it rather than re-deriving the exclusion by hand is what keeps the
Study's faces and the spawner's name pool the same set. `fascination.png` goes
in too, reserved for the god. The three "conflicted copy" duplicates and
`work 100x100.png` are left behind.

**Names become part of the index.** `PORTRAIT_FILES` is a list of *bundled
URLs* — the filename is gone by the time the app sees it, so an assistant named
`leo` cannot presently find `leo.png`. `make-portrait-index.cjs` gains a
parallel `PORTRAIT_NAMES` (basenames, no extension, same order), and
`portraitFor` becomes: **name match first, hash second.** That is the whole
point of the name pool — a worker is spawned with the name of the face it will
wear — and the hash stays underneath it so an assistant named something else
still gets a face.

**Attribution is a licence obligation, not bookkeeping.** Every file lands in
`ATTRIBUTION-SIXTH-HISTORY.md`, and a test holds the document against the
directory so a portrait added without recording it fails the suite.

**The picker.** Under occult, the add-agent screen's Character row (pixel
office sprites) becomes a portrait grid. Choosing one sets the agent's name to
the portrait's filename — the same thing clicking a character tile already does
with `displayName`, so it is the established pattern and not a new one. The
accent colour default is **not** touched: it stays `'sky'`, the screen's
existing default, per the dispatch.

- [ ] **Step 1: Failing tests.** (a) `PORTRAIT_NAMES` is the same length as
  `PORTRAIT_FILES` and the index matches the directory (extend the existing
  check); (b) every name in `worker-name-pool.txt` has a portrait, and no
  `cult*`/`way*`/aspect file was copied in — assert against the pool file, so
  the two cannot drift; (c) `portraitFor({name:'leo'})` returns the `leo`
  entry, and returns it *whatever the id is* — assert with two different ids,
  because a name rule that a hash could satisfy by luck is not a name rule;
  (d) an unknown name still gets a face, deterministically; (e) every portrait
  file is recorded in the attribution document; (f) `PortraitPicker` renders
  one button per portrait and choosing one calls back with the portrait's
  **name**, and `AddAgentModal` mounts it only under occult.
- [ ] **Step 2: FAIL.** **Step 3:** Copy the files, regenerate the index,
  implement the rest. **Step 4:** PASS. **Break it to prove it:** delete one
  line from the attribution document and (e) must go red; make `portraitFor`
  ignore the name and (c) must go red. **Step 5:** Commit as three —
  `chore(study): the licensed portraits and their attribution`,
  `feat(study): an assistant named for a portrait wears it`,
  `feat(study): choosing a face names the assistant it belongs to`.

### Task 8: Milestone gate

- [ ] `node --test test/*.test.cjs` — **962 + new of 998 + new**, with the same
  35 pre-existing failures and no others. Report as N of M against the
  baseline above; a green claim that a reviewer cannot reproduce is worse than
  a red one.
- [ ] `npm run typecheck` clean; `npm run build` succeeds.
- [ ] Read the whole diff (`git diff <cut>...HEAD`) before calling it done —
  no debug logging, no reformatted files, no drive-by edits.
- [ ] SUMMARY.md at the worktree root: per-task status, the commits, the
  evidence, the deviations, and the parked questions (the `completedAt`
  question from decision 2; the flying-book animation if it did not fit).
- [ ] Do not push. God integrates. Visual QA is Aaron's — the app is
  single-instance and this environment has no display for it.
