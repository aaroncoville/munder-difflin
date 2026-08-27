# Sixth History Theme — Milestone 2 (The Study) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under the occult theme, replace the pixel office floor with the painted Study — a manifest-driven DOM scene where agents are gliding portrait-cards at reading desks and tasks are books.

**Architecture:** `StudyScene` renders three layers: a backdrop `<img>`, a reserved (empty, M3) ambiance slot, and an absolutely-positioned DOM card layer. Every position comes from `room.json` (normalized 0..1 coordinates), so the painted backdrop can be swapped or recomposed without code changes. The scene is a pure projection of the existing Zustand store — no new state, no new IPC. Art arrives on a separate track (god runs the Flux loop with Aaron); this plan builds against a checked-in placeholder backdrop with the same berth layout contract.

**Tech Stack:** React 18 inline styles + `--cth-*` tokens, existing Zustand store, node:test + `test/load-ts.cjs`/`test/render-hooks.cjs`.

**Spec:** `docs/superpowers/specs/2026-08-27-sixth-history-theme-design.md`

## Global Constraints

- Branch `theme/sixth-history`. Never push. Commit per task, plain messages, no AI-attribution artifacts.
- **Only existing file modified:** `src/renderer/src/App.tsx` (the floor mount becomes a theme conditional — Task 7). Everything else is new files under `src/renderer/src/scene/study/`.
- Light/dark themes and the pixel office floor must behave exactly as today when the theme is not `occult` — the conditional is the only integration point, and it defaults to `OfficeFloor`.
- M2 non-goals (M3): the Pixi ambiance layer (slot reserved, nothing mounted), the `en-SH` locale, book-flies-to-shelf animation, licensed-portrait *download tooling* (Task 5 ships a local mapping consuming whatever files exist plus generated fallbacks).
- Coordinates: every berth/zone is `{ x, y, w?, h? }` in fractions of the backdrop's natural size; the scene scales them to the rendered box (letterboxed contain-fit).
- Tests: `node --test test/<file>`; full `npm run test:focused` unsandboxed at the gate.

---

### Task 1: Room manifest — schema, loader, validation

**Files:**
- Create: `src/renderer/src/scene/study/roomManifest.ts`, `src/renderer/src/scene/study/assets/room.json`
- Test: `test/study-manifest.test.cjs`

**Interfaces:**
- Produces:
  ```ts
  export interface Berth { id: string; x: number; y: number; w: number; h: number }
  export interface RoomManifest {
    backdrop: string;                      // module path of the backdrop image
    deskBerths: Berth[];                   // one agent each, order = seating priority
    godBerth: Berth;
    anchors: { cardTable: Berth; writingDesk: Berth; almanac: Berth; hearth: Berth; shelves: Berth };
    lightPoints: { x: number; y: number }[];  // M3 ambiance hook, may be empty
  }
  export function loadRoomManifest(): RoomManifest   // parses + validates room.json, throws on invalid
  ```

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

test('the shipped room manifest is valid and complete', () => {
  const { loadRoomManifest } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const room = loadRoomManifest();
  assert.ok(room.deskBerths.length >= 6, 'at least six desks');
  const ids = new Set(room.deskBerths.map((b) => b.id));
  assert.equal(ids.size, room.deskBerths.length, 'berth ids unique');
  for (const b of [...room.deskBerths, room.godBerth, ...Object.values(room.anchors)]) {
    for (const k of ['x', 'y', 'w', 'h']) {
      assert.ok(b[k] >= 0 && b[k] <= 1, `${b.id ?? 'anchor'}.${k} normalized`);
    }
    assert.ok(b.x + b.w <= 1 && b.y + b.h <= 1, 'berth stays inside the backdrop');
  }
});

test('a manifest missing an anchor is rejected', () => {
  const { validateRoomManifest } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  assert.throws(() => validateRoomManifest({ backdrop: 'x', deskBerths: [], godBerth: null, anchors: {} }),
    /godBerth|anchors/);
});
```

- [ ] **Step 2: Run — FAIL** (module absent).
- [ ] **Step 3: Implement.** `roomManifest.ts` exports the interfaces, `validateRoomManifest(raw): RoomManifest` (explicit checks, descriptive throws — no schema library; the repo has none), and `loadRoomManifest()` = `validateRoomManifest(require('./assets/room.json'))` via a static `import roomJson from './assets/room.json'`. Author `room.json` with 8 desk berths in two loose rows (e.g. desks at y 0.55 and 0.75, w 0.10, h 0.14), god berth front-center (w 0.13), anchors: cardTable center 0.42/0.62, writingDesk right 0.80/0.58, almanac left 0.08/0.50, hearth right edge 0.90/0.70, shelves top band 0.05..0.95 × 0.10/0.25, four lightPoints. These are the placeholder-backdrop coordinates; the art track revises the values, never the shape.
- [ ] **Step 4: Run — PASS.** `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/renderer/src/scene/study test/study-manifest.test.cjs && git commit -m "feat(study): room manifest schema and shipped layout"`

### Task 2: Placeholder backdrop + scene shell

**Files:**
- Create: `src/renderer/src/scene/study/StudyScene.tsx`, `src/renderer/src/scene/study/assets/backdrop-placeholder.png`
- Test: `test/study-scene.test.cjs`

**Interfaces:**
- Consumes: `loadRoomManifest()` (Task 1).
- Produces: `StudyScene(): JSX.Element` — fills its container; renders (bottom→top) backdrop `<img>`, an empty `<div data-study-slot="ambiance">`, and `<div data-study-layer="cards">` containing one positioned child per occupied berth (Tasks 3–6 fill it). Also exports `berthToBox(berth, view): {left,top,width,height}` where `view = {x,y,w,h}` is the contain-fitted backdrop box in px.

- [ ] **Step 1: Failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

test('berthToBox letterboxes correctly', () => {
  const { berthToBox } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');
  // 2:1 backdrop contain-fit inside a 1000x1000 container -> view 1000x500 at y=250
  const view = { x: 0, y: 250, w: 1000, h: 500 };
  assert.deepEqual(berthToBox({ id: 'd', x: 0.5, y: 0.5, w: 0.1, h: 0.2 }, view),
    { left: 500, top: 500, width: 100, height: 100 });
});

test('the scene stacks backdrop, ambiance slot, card layer in order', () => {
  global.window = { localStorage: { getItem: () => 'occult', setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
  const { StudyScene } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');
  const inst = mount(StudyScene, {});
  const layers = JSON.stringify(inst.tree);
  const iBackdrop = layers.indexOf('backdrop');
  const iAmbiance = layers.indexOf('data-study-slot');
  const iCards = layers.indexOf('data-study-layer');
  assert.ok(iBackdrop >= 0 && iBackdrop < iAmbiance && iAmbiance < iCards, 'layer order');
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Generate the placeholder backdrop procedurally (a 1344×768 PNG: flat `#171322` fill with faint rectangles at each berth — a 20-line node script using no new deps, e.g. write raw pixels via `zlib`+ manual PNG chunks OR simply commit a solid-color PNG exported from an existing tool; the image only needs to exist and have the right aspect). `StudyScene` measures its container with a `ResizeObserver` (guard `typeof ResizeObserver === 'undefined'` for tests → fall back to a 1344×768 view), computes the contain-fit view box, renders the three layers; card layer children are placed via `berthToBox`. The store wiring lands in Task 6 — until then the card layer renders desks empty.
- [ ] **Step 4: Run — PASS**; typecheck clean.
- [ ] **Step 5: Commit** — `feat(study): scene shell with manifest-driven layout`

### Task 3: AgentCard

**Files:**
- Create: `src/renderer/src/scene/study/AgentCard.tsx`
- Test: `test/study-agent-card.test.cjs`

**Interfaces:**
- Consumes: nothing from the scene — pure presentational.
- Produces:
  ```ts
  export interface AgentCardProps {
    name: string;
    role?: string;
    status: 'idle' | 'working' | 'blocked' | 'archived';
    portraitSrc?: string;          // absent -> monogram fallback
    box: { left: number; top: number; width: number; height: number };
    onClick?: () => void;
  }
  export function AgentCard(props: AgentCardProps): JSX.Element
  ```

- [ ] **Step 1: Failing test** — mount with each status; assert: root has `position:'absolute'`, `left/top/width` from `box`, a `transition` containing `var(--cth-dur-slow)`; portrait `<img>` when `portraitSrc` given, else a monogram div carrying the first letter of `name`; a status element whose `title` names the status; `role="button"` and the `onClick` wired when provided.

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');
const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');
const find = (n, pred) => { if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) { const h = find(k, pred); if (h) return h; }
  return undefined; };

test('the card sits at its box and glides via the motion token', () => {
  const inst = mount(AgentCard, { name: 'Pam', status: 'working',
    box: { left: 10, top: 20, width: 80, height: 110 } });
  const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
  assert.ok(root, 'absolutely positioned root');
  assert.equal(root.props.style.left, 10);
  assert.match(String(root.props.style.transition), /var\(--cth-dur-slow\)/);
});

test('no portrait means a monogram, never a broken image', () => {
  const inst = mount(AgentCard, { name: 'Pam', status: 'idle',
    box: { left: 0, top: 0, width: 80, height: 110 } });
  assert.equal(find(inst.tree, (n) => n.type === 'img'), undefined);
  assert.ok(find(inst.tree, (n) => n.props?.children === 'P'), 'monogram letter');
});
```

- [ ] **Step 2: FAIL.** **Step 3:** Implement — gilt-framed card: outer div (absolute, `background: var(--cth-paper-100)`, `boxShadow: var(--cth-panel-border-dialog)`, `borderRadius: var(--cth-radius-panel)`, `transition: left var(--cth-dur-slow) var(--cth-ease-glide), top var(--cth-dur-slow) var(--cth-ease-glide)`), portrait area (img `object-fit: cover` or monogram in `--cth-font-display`), name plaque (`--cth-font-display`, `--cth-text-display-sm`), status dot (`--cth-status-*` token by status, `title={status}`). **Step 4:** PASS + typecheck. **Step 5:** Commit `feat(study): agent portrait card`.

### Task 4: DeskBook + SpeechScroll

**Files:**
- Create: `src/renderer/src/scene/study/DeskBook.tsx`, `src/renderer/src/scene/study/SpeechScroll.tsx`
- Test: `test/study-desk-props.test.cjs`

**Interfaces:**
- Produces:
  ```ts
  export function DeskBook(props: { state: 'closed' | 'open' | 'sealed'; title?: string;
    box: { left: number; top: number; width: number; height: number } }): JSX.Element
  export function SpeechScroll(props: { text: string;
    box: { left: number; top: number; width: number } }): JSX.Element | null   // null when text empty
  ```

- [ ] **Step 1: Failing test** — DeskBook renders a distinct glyph/shape per state (closed 📕-like solid spine block, open two-page block, sealed adds a ribbon element) with `title` as tooltip; SpeechScroll returns null for `''`, renders text in a parchment box (`background: var(--cth-cream-50)`, `--cth-font-ui`) capped with `overflow: 'hidden'` and `maxHeight`.

```js
test('a sealed book shows its ribbon', () => {
  const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
  const inst = mount(DeskBook, { state: 'sealed', box: { left: 0, top: 0, width: 40, height: 30 } });
  assert.ok(find(inst.tree, (n) => n.props?.['data-book-ribbon'] !== undefined));
});
test('an empty speech scroll renders nothing', () => {
  const { SpeechScroll } = loadTs('src/renderer/src/scene/study/SpeechScroll.tsx');
  assert.equal(mount(SpeechScroll, { text: '', box: { left: 0, top: 0, width: 100 } }).tree, null);
});
```

- [ ] **Steps 2–5:** FAIL → implement (pure CSS shapes from tokens, no images) → PASS → commit `feat(study): desk books and speech scrolls`.

### Task 5: Portrait mapping

**Files:**
- Create: `src/renderer/src/scene/study/portraits.ts`, `src/renderer/src/scene/study/assets/portraits/` (directory, may start empty), extend `src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md`
- Test: `test/study-portraits.test.cjs`

**Interfaces:**
- Produces: `portraitFor(agent: { id: string; name: string; role?: string }): string | undefined` — deterministic assignment from whatever files `assets/portraits/` holds (via `import.meta.glob` eagerly, or a generated index module `portraits.index.ts` listing files — pick whichever the build supports; the repo uses Vite, `import.meta.glob('./assets/portraits/*.png', { eager: true })` works). Same agent id always maps to the same portrait (hash id → index); `undefined` when the directory is empty (AgentCard falls back to monogram).

- [ ] **Step 1: Failing test** — with a stubbed file list, same id → same file across calls; different ids spread across files; empty list → undefined. Export a pure `assignPortrait(id: string, files: string[]): string | undefined` so the test needs no Vite glob: `assert.equal(assignPortrait('a', ['x.png','y.png']), assignPortrait('a', ['x.png','y.png']))`.
- [ ] **Steps 2–5:** FAIL → implement (fnv-1a hash of id mod files.length; `portraitFor` feeds the glob result into `assignPortrait`) → PASS → commit `feat(study): deterministic portrait assignment`. Note in ATTRIBUTION-SIXTH-HISTORY.md: portrait files placed here must come from the curated pack or the god's generated set — recorded per file as they land (art track).

### Task 6: Store projection

**Files:**
- Create: `src/renderer/src/scene/study/useSceneState.ts`
- Test: `test/study-scene-state.test.cjs`

**Interfaces:**
- Consumes: the existing Zustand store (`@/store/store`) — the SAME selectors `OfficeFloor.tsx` reads for its cast/task/ask data (find them at `scene/office/OfficeFloor.tsx` ~line 183 and follow; do not add store fields).
- Produces:
  ```ts
  export interface SceneAgent { id: string; name: string; role?: string;
    status: 'idle' | 'working' | 'blocked' | 'archived'; berthId: string;
    bookState?: 'closed' | 'open' | 'sealed'; bookTitle?: string; speech: string }
  export interface SceneState { agents: SceneAgent[]; openAskCount: number;
    kanbanCounts: { todo: number; doing: number; blocked: number; done: number } }
  export function useSceneState(): SceneState
  ```
  Berth assignment: agents sorted by spawn order take `deskBerths` in manifest order; the god agent takes `godBerth`; overflow agents (more agents than desks) share the last berth with a small offset — never crash.

- [ ] **Step 1: Failing test** — drive the real store's setters (as `test/hive-task-mutation.test.cjs` does for main-process state; here use the renderer store: `useStore.getState()` setters seeded via the store module loaded through load-ts with a stubbed `window.cth` bridge), then call the hook via a mounted probe component and assert: god agent on godBerth; two workers on the first two desk berths in stable order; an agent with a doing-status task shows `bookState: 'open'`; blocked task with open ask → `'sealed'`; kanban counts match seeded tasks.
- [ ] **Steps 2–5:** FAIL → implement with `useStore` selectors + `useMemo` → PASS → commit `feat(study): scene state projection`.

### Task 7: FloorHost — the one integration point

**Files:**
- Create: `src/renderer/src/scene/study/FloorHost.tsx`
- Modify: `src/renderer/src/App.tsx` (replace the direct `<OfficeFloor …/>` mount with `<FloorHost …/>` passing identical props through)
- Test: `test/study-floor-host.test.cjs`

**Interfaces:**
- Consumes: `useAppTheme()` (M1), `StudyScene` (Task 2), `OfficeFloor` (existing — re-exported lazily).
- Produces: `FloorHost(props: OfficeFloorProps): JSX.Element` — `useAppTheme() === 'occult'` → `StudyScene`, else `OfficeFloor` with props passed through untouched.

- [ ] **Step 1: Failing test** — with localStorage seeded `'light'` the host renders OfficeFloor (assert by a marker: lazy import mocked via seeding the module path in require cache with a sentinel component, house trick from `render-hooks.cjs`); seeded `'occult'` → StudyScene marker. Assert App.tsx no longer contains `<OfficeFloor` (source scan, comment-stripped).
- [ ] **Steps 2–5:** FAIL → implement → PASS (typecheck + full component sweep) → commit `feat(study): FloorHost switches the floor by theme`.

### Task 8: Scene assembly — cards, books, scrolls, anchors live

**Files:**
- Modify: `src/renderer/src/scene/study/StudyScene.tsx` (from its own Task 2 skeleton)
- Test: extend `test/study-scene.test.cjs`

**Interfaces:**
- Consumes: everything above. Anchor click handlers: reuse the exact navigation actions the office theme's anchors fire — find them in `OfficeFloor.tsx` (calendar→Triggers, boards→Tasks, clock→Closing Time per `themeRegistry.ts` anchors) and call the same store/router functions; writingDesk opens the Ask Me surface the same way.

- [ ] **Step 1: Failing test** — seed the store with god + 2 agents (one working with speech text, one blocked); mount StudyScene; assert: 3 AgentCards at their berthToBox positions; the working agent has an open DeskBook and a SpeechScroll with its text; anchor zones render as `role="button"` elements titled "Tasks", "Petitions", "Triggers", "Closing Time"; the writingDesk zone shows the open-ask count when > 0.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat(study): the Study is inhabited`.

### Task 9: Milestone gate

- [ ] Unsandboxed `npm run test:focused` all green; `npm run typecheck` clean; `npm run build` succeeds.
- [ ] SUMMARY.md: per-task status, deviations, open questions; note that app-level visual QA is Aaron's (single-instance lock).
- [ ] Do not push — god integrates.
