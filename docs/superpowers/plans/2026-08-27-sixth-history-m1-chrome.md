# Sixth History Theme — Milestone 1 (Chrome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third app theme `occult` — the Sixth History occult-deco dress for the entire DOM chrome — leaving light/dark byte-identical and the pixel office floor untouched.

**Architecture:** The existing theme system is a token swap (`data-cth-theme` on `<html>` + guarded blocks in CSS). We add one theme id, one new CSS file carrying the full occult token block plus four new token families (radius/hairline/gilt/motion) whose *base* defaults are inert, a self-hosted display font, and minimal component diffs (the three Pixel primitives learn a radius token; terminals map occult→dark palettes).

**Tech Stack:** React 18 inline styles + CSS custom properties, node:test + `test/load-ts.cjs`/`test/render-hooks.cjs` harness, self-hosted woff2 fonts.

**Spec:** `docs/superpowers/specs/2026-08-27-sixth-history-theme-design.md`

## Global Constraints

- Branch: `theme/sixth-history` on the fork. Never push to upstream. All work commits here.
- **Light/dark regression contract:** with theme = light or dark, every surface renders byte-identically to before this plan. New token families get inert defaults in the base `:root` (radius `0`, hairline = existing border colors, gilt = existing accents, durations unchanged).
- New-files-first: only these existing files may be modified: `src/renderer/src/design/theme.ts`, `src/renderer/src/design/global.css` (one `@import` line), `src/renderer/src/design/tokens.css` (base-`:root` additions ONLY — never edit existing values or the dark block), `src/renderer/src/App.tsx` (toggle button), `src/renderer/src/components/FullscreenTerminal.tsx` (toggle mirror), `src/renderer/src/components/PtyTerminalView.tsx` (occult→dark palette map), `src/renderer/src/components/{PixelPanel,PixelButton,PixelBadge}.tsx` (radius token), `src/renderer/src/components/ReleaseDrop.tsx` (palette→tokens), `src/renderer/src/components/SettingsModal.tsx` (attribution block).
- Explicit non-goals for M1 (deferred, matching the dark theme's own precedent): Monaco stays `cth-light`; xterm gets the *dark* ANSI palette under occult (custom candlelit palette is M3); the pre-React splash and BrowserWindow background stay cream (dark has the same flash today); the 22-icon deco redraw is M3.
- Licence: only curated Sixth History pack assets; attribution + logo ship in this milestone (Task 8).
- Tests run with `node --test test/<file>` (sandbox note: full `npm run test:focused` must run unsandboxed — tilde/network tests fail falsely in a sandbox).
- Commit after every task; plain commit messages, no AI attribution artifacts.

---

### Task 1: `occult` theme id

**Files:**
- Modify: `src/renderer/src/design/theme.ts`
- Test: `test/app-theme.test.cjs` (create)

**Interfaces:**
- Produces: `type AppTheme = 'light' | 'dark' | 'occult'`; `toggleAppTheme(): AppTheme` cycles `light → dark → occult → light`; `setAppTheme/appTheme/useAppTheme` unchanged in signature.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// theme.ts touches window.localStorage and document at module load.
function freshTheme(stored) {
  const store = new Map(stored ? [['cth.theme', stored]] : []);
  global.window = { localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v)
  } };
  global.document = { documentElement: { dataset: {} } };
  delete require('./load-ts.cjs').cache; // load-ts caches per path; bust via fresh loadTs
  // load-ts.cjs keeps its own module cache keyed by filename; simplest reliable
  // reset is to delete the entry before each load:
  const loadTs = require('./load-ts.cjs');
  return { mod: loadTs.fresh
    ? loadTs.fresh('src/renderer/src/design/theme.ts')
    : loadTs('src/renderer/src/design/theme.ts'), store };
}

test('occult is a legal persisted theme', () => {
  const { mod } = freshTheme('occult');
  assert.equal(mod.appTheme(), 'occult');
  assert.equal(global.document.documentElement.dataset.cthTheme, 'occult');
});

test('the toggle cycles light -> dark -> occult -> light', () => {
  const { mod } = freshTheme('light');
  assert.equal(mod.toggleAppTheme(), 'dark');
  assert.equal(mod.toggleAppTheme(), 'occult');
  assert.equal(mod.toggleAppTheme(), 'light');
});

test('an unknown stored value still falls back to light', () => {
  const { mod } = freshTheme('cerulean');
  assert.equal(mod.appTheme(), 'light');
});
```

If `load-ts.cjs` has no cache-reset affordance, add `loadTs.fresh(path)` to it (delete the cache entry, then load) — 4 lines, keeps existing behavior intact.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/app-theme.test.cjs`
Expected: FAIL — `load()` rejects `'occult'`, cycle returns `'light'` after `'dark'`.

- [ ] **Step 3: Implement**

In `theme.ts`:

```ts
export type AppTheme = 'light' | 'dark' | 'occult';
```

In `load()` accept the third value:

```ts
    if (v === 'dark' || v === 'light' || v === 'occult') return v;
```

Replace the toggle body:

```ts
const CYCLE: readonly AppTheme[] = ['light', 'dark', 'occult'];

export function toggleAppTheme(): AppTheme {
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
  setAppTheme(next);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/app-theme.test.cjs` → PASS. Also `npm run typecheck` — expect NEW errors where `AppTheme` is consumed exhaustively (`PtyTerminalView` etc.); note them, they are Task 2's worklist. If typecheck must stay green per-commit, do Steps 3–4 of Task 2 in this commit.

- [ ] **Step 5: Commit**

```bash
git add test/app-theme.test.cjs src/renderer/src/design/theme.ts test/load-ts.cjs
git commit -m "feat(theme): occult joins the theme cycle"
```

### Task 2: Consumers handle the third value

**Files:**
- Modify: `src/renderer/src/App.tsx` (~line 317 toggle), `src/renderer/src/components/FullscreenTerminal.tsx` (~line 335 mirror), `src/renderer/src/components/PtyTerminalView.tsx` (~line 135)
- Test: `test/app-theme.test.cjs` (extend)

**Interfaces:**
- Consumes: `AppTheme` from Task 1.
- Produces: the rule **"terminals treat occult as dark"** — a single exported helper `terminalThemeFor(theme: AppTheme): 'light' | 'dark'` in `theme.ts`.

- [ ] **Step 1: Write the failing test** (append to `test/app-theme.test.cjs`)

```js
test('terminals collapse occult to dark', () => {
  const { mod } = freshTheme('occult');
  assert.equal(mod.terminalThemeFor('occult'), 'dark');
  assert.equal(mod.terminalThemeFor('dark'), 'dark');
  assert.equal(mod.terminalThemeFor('light'), 'light');
});
```

- [ ] **Step 2: Run to verify it fails** — `terminalThemeFor` not exported.

- [ ] **Step 3: Implement**

`theme.ts`:

```ts
/** Terminals and TUIs have two palettes; occult borrows the dark one (M1). */
export function terminalThemeFor(t: AppTheme): 'light' | 'dark' {
  return t === 'light' ? 'light' : 'dark';
}
```

`PtyTerminalView.tsx:135` — palettes are keyed light/dark; route through the helper:

```ts
  const ptyTheme: PtyTheme = terminalThemeFor(useAppTheme());
```

`App.tsx` toggle (and the `FullscreenTerminal.tsx` mirror — keep both call sites textually identical): where it currently does `notifyThemeChangeAll(next === 'dark' ? 'dark' : 'light')` and mirrors `config.terminalTheme`, substitute `terminalThemeFor(next)` for the ternary in both places.

- [ ] **Step 4: Verify** — `node --test test/app-theme.test.cjs` PASS; `npm run typecheck` clean; launch `npm run dev`, click the theme button three times: chrome cycles light → dark → (occult = dark-looking for now, tokens land in Task 3), terminals stay legible throughout.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/design/theme.ts src/renderer/src/App.tsx src/renderer/src/components/FullscreenTerminal.tsx src/renderer/src/components/PtyTerminalView.tsx test/app-theme.test.cjs
git commit -m "feat(theme): route terminal palettes through terminalThemeFor"
```

### Task 3: The occult token block + new families

**Files:**
- Create: `src/renderer/src/design/occult/occult-tokens.css`
- Modify: `src/renderer/src/design/tokens.css` (append new-family defaults to base `:root` only), `src/renderer/src/design/global.css` (add `@import './occult/occult-tokens.css';` after line 2)
- Test: `test/occult-tokens.test.cjs` (create)

**Interfaces:**
- Produces: every `--cth-*` token of the base `:root` redefined under `:root[data-cth-theme='occult']`; new families `--cth-radius-panel|control|badge`, `--cth-hairline`, `--cth-gilt|gilt-soft`, `--cth-dur-slow|drift`, `--cth-ease-glide` defined in base `:root` (inert) and in the occult block (live).

- [ ] **Step 1: Write the failing test** — source-contract style (house pattern, cf. `test/arabic-ui.test.cjs`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const tokensOf = (css, blockRe) => {
  const m = css.match(blockRe);
  assert.ok(m, `block ${blockRe} not found`);
  return new Set([...m[1].matchAll(/--cth-[\w-]+(?=\s*:)/g)].map((x) => x[0]));
};

const base = read('src/renderer/src/design/tokens.css');
const occult = read('src/renderer/src/design/occult/occult-tokens.css');
const baseRoot = tokensOf(base, /:root\s*{([\s\S]*?)\n}/);
const occultRoot = tokensOf(occult, /:root\[data-cth-theme='occult'\]\s*{([\s\S]*?)\n}/);

test('occult redefines every base token', () => {
  const missing = [...baseRoot].filter((t) => !occultRoot.has(t));
  assert.deepEqual(missing, [], 'tokens the occult theme forgot');
});

test('new families have inert base defaults', () => {
  for (const t of ['--cth-radius-panel', '--cth-radius-control', '--cth-radius-badge',
    '--cth-hairline', '--cth-gilt', '--cth-gilt-soft',
    '--cth-dur-slow', '--cth-dur-drift', '--cth-ease-glide']) {
    assert.ok(baseRoot.has(t), `${t} missing from base :root`);
  }
  assert.match(base, /--cth-radius-panel:\s*0px/);
  assert.match(base, /--cth-radius-control:\s*0px/);
  assert.match(base, /--cth-radius-badge:\s*0px/);
});

test('the dark block is untouched by this branch', () => {
  // Guard: occult work must never edit dark. Count dark's tokens and pin it.
  const dark = tokensOf(base, /:root\[data-cth-theme='dark'\]\s*{([\s\S]*?)\n}/);
  assert.ok(dark.size >= 40, 'dark block shrank — occult work leaked into it');
});

test('global.css imports the occult tokens', () => {
  assert.match(read('src/renderer/src/design/global.css'),
    /@import '\.\/occult\/occult-tokens\.css';/);
});
```

- [ ] **Step 2: Run to verify it fails** — file absent.

- [ ] **Step 3: Implement.** Append to base `:root` in `tokens.css`:

```css
  /* Theme-shape families (v-fork sixth-history). Inert here: light/dark render
     byte-identically. The occult block gives them life. */
  --cth-radius-panel: 0px;
  --cth-radius-control: 0px;
  --cth-radius-badge: 0px;
  --cth-hairline: var(--cth-ink-300);
  --cth-gilt: var(--cth-lemon);
  --cth-gilt-soft: var(--cth-lemon-light);
  --cth-dur-slow: 200ms;
  --cth-dur-drift: 1200ms;
  --cth-ease-glide: cubic-bezier(0.4, 0.0, 0.2, 1);
```

Create `occult-tokens.css` with the full block — starting palette (candlelight gold + Grail crimson + muted teal on deep ink; every base token present; iterate values later, presence is the contract):

```css
/* Sixth History occult theme — the whole app in candlelight.
   Every base :root token is redefined here; test/occult-tokens.test.cjs
   enforces completeness. Palette anchors: ink-blue night grounds, parchment
   text, candleflame gold, Grail crimson, Winter teal. */
:root[data-cth-theme='occult'] {
  /* Grounds — deep ink, warmer than the dark theme's neutral */
  --cth-cream-50:  #221E30;
  --cth-cream-100: #1C1828;
  --cth-cream-200: #171322;
  --cth-cream-300: #120F1B;
  --cth-paper-100: #262134;
  --cth-paper-200: #1E1A2B;

  /* Ink → parchment */
  --cth-ink-900: #EAE0C8;
  --cth-ink-700: #C9BEA4;
  --cth-ink-500: #988F7C;
  --cth-ink-300: #5C5470;
  --cth-ink-100: #3A3450;

  /* Accents — same six slots, occult register */
  --cth-coral: #B0524E;       --cth-coral-light: #4A2C31;
  --cth-mint:  #5F7E5A;       --cth-mint-light:  #2C3A2E;
  --cth-sky:   #3E7C7B;       --cth-sky-light:   #24393E;
  --cth-lemon: #C9A227;       --cth-lemon-light: #453A1E;
  --cth-lilac: #7B6AA8;       --cth-lilac-light: #322C4A;
  --cth-peach: #C98A4B;       --cth-peach-light: #45321F;

  /* Status — hue meanings unchanged, candlelit values */
  --cth-status-idle:     #6E6880;
  /* …copy EVERY remaining base token (status-*, space-*, font-*, text-*,
     lh-*, shadow, panel-border-*, on-accent) with occult values; space-*
     and lh-* may repeat base values verbatim but MUST be present. */

  --cth-shadow-hard: 0 2px 10px rgba(0, 0, 0, 0.55);
  --cth-panel-border:          inset 0 0 0 1px var(--cth-hairline);
  --cth-panel-border-inset:    inset 0 0 0 1px var(--cth-ink-100);
  --cth-panel-border-terminal: inset 0 0 0 1px var(--cth-hairline);
  --cth-panel-border-dialog:   inset 0 0 0 1px var(--cth-gilt);

  /* The families come alive */
  --cth-radius-panel: 3px;
  --cth-radius-control: 2px;
  --cth-radius-badge: 2px;
  --cth-hairline: #8A7440;
  --cth-gilt: #C9A227;
  --cth-gilt-soft: #6B5A2E;
  --cth-dur-slow: 320ms;
  --cth-dur-drift: 2400ms;
}

/* Occult ground: replace the cream diagonal noise + cursor for this theme */
:root[data-cth-theme='occult'] body {
  background:
    repeating-linear-gradient(-45deg, transparent 0 14px, rgba(201, 162, 39, 0.04) 14px 15px),
    var(--cth-cream-200);
}
```

(The elided token runs are mechanical: open the base block, copy each remaining declaration, choose an occult value or keep the base one — the completeness test is the checklist.)

Add the `@import` to `global.css` after the tokens import.

- [ ] **Step 4: Verify** — `node --test test/occult-tokens.test.cjs` PASS; `npm run dev`, cycle to occult: whole chrome goes candlelit; cycle back: light/dark pixel-identical (spot-check panels/buttons/terminal against a pre-branch screenshot).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/design/occult/occult-tokens.css src/renderer/src/design/tokens.css src/renderer/src/design/global.css test/occult-tokens.test.cjs
git commit -m "feat(theme): occult token block and theme-shape families"
```

### Task 4: Display face

**Files:**
- Create: `src/renderer/src/design/occult/occult-fonts.css`, `src/renderer/src/assets/fonts/cormorant-sc-latin-{400,700}.woff2`
- Modify: `src/renderer/src/design/global.css` (one `@import`)
- Test: extend `test/occult-tokens.test.cjs`

**Interfaces:**
- Produces: under occult only, `--cth-font-display` = `"Cormorant SC", <base fallback tail verbatim>`; retuned `--cth-text-display-lg: 22px / -md: 16px / -sm: 11px` and `--cth-lh-display-*` to match.

- [ ] **Step 1: Failing test** (append):

```js
test('occult swaps the display face but keeps the CJK/Arabic tail', () => {
  assert.match(occult, /--cth-font-display:\s*"Cormorant SC",[^;]*"Noto Naskh Arabic"/);
  assert.match(occult, /--cth-text-display-sm:\s*11px/);
});
test('the deco face is self-hosted', () => {
  assert.match(read('src/renderer/src/design/occult/occult-fonts.css'),
    /font-family:\s*'Cormorant SC';[\s\S]*?url\('\.\.\/\.\.\/assets\/fonts\/cormorant-sc-latin-400\.woff2'\)/);
});
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement.** Fetch the OFL-licensed woff2s (Google Fonts static CDN; commit the files — self-hosting is house policy, see `fonts.css:1-17`):

```bash
curl -sL -o src/renderer/src/assets/fonts/cormorant-sc-latin-400.woff2 "$(curl -s 'https://fonts.googleapis.com/css2?family=Cormorant+SC&display=swap' -A 'Mozilla/5.0' | grep -o 'https://[^)]*\.woff2' | head -1)"
```

(repeat with `:wght@700` for the bold file). `occult-fonts.css`:

```css
/* Cormorant SC — OFL licence. Self-hosted like every face here (fonts.css:1). */
@font-face {
  font-family: 'Cormorant SC';
  font-style: normal; font-weight: 400; font-display: swap;
  src: url('../../assets/fonts/cormorant-sc-latin-400.woff2') format('woff2');
}
@font-face {
  font-family: 'Cormorant SC';
  font-style: normal; font-weight: 700; font-display: swap;
  src: url('../../assets/fonts/cormorant-sc-latin-700.woff2') format('woff2');
}
```

In `occult-tokens.css`, inside the occult block, set `--cth-font-display` to `"Cormorant SC"` followed by the base tail *copied verbatim from tokens.css:57 minus "Press Start 2P"*, and the six display size/LH tokens (`lg 22/26`, `md 16/20`, `sm 11/15`).

- [ ] **Step 4: Verify** — tests PASS; dev run under occult: headers/labels render serif small-caps at readable sizes; under light: Press Start 2P untouched. **CHECKPOINT: screenshot the Settings + Tasks headers to Aaron — he picks Cormorant vs alternates (Playfair Display, Poiret One) before polish continues; swapping is this task re-run with a different family.**

- [ ] **Step 5: Commit** — `git add -A src/renderer/src/design/occult src/renderer/src/assets/fonts test/occult-tokens.test.cjs && git commit -m "feat(theme): Cormorant SC display face for occult"`

### Task 5: Primitives learn radius

**Files:**
- Modify: `src/renderer/src/components/PixelPanel.tsx`, `PixelButton.tsx`, `PixelBadge.tsx`
- Test: `test/occult-primitives.test.cjs` (create)

**Interfaces:**
- Consumes: `--cth-radius-*` (Task 3). No prop/type changes — pure style additions, inert outside occult.

- [ ] **Step 1: Failing test** — mount via render-hooks (house pattern of `test/mcp-toggle-component.test.cjs`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');
const { PixelPanel } = loadTs('src/renderer/src/components/PixelPanel.tsx');
const { PixelButton } = loadTs('src/renderer/src/components/PixelButton.tsx');
const { PixelBadge } = loadTs('src/renderer/src/components/PixelBadge.tsx');

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  const kids = [].concat(n.props?.children ?? []);
  for (const k of kids) { const hit = find(k, pred); if (hit) return hit; }
  return undefined;
};

test('each primitive rounds through its radius token', () => {
  for (const [C, props, token] of [
    [PixelPanel, {}, 'var(--cth-radius-panel)'],
    [PixelButton, { children: 'x' }, 'var(--cth-radius-control)'],
    [PixelBadge, { children: 'x' }, 'var(--cth-radius-badge)']
  ]) {
    const inst = mount(C, props);
    const styled = find(inst.tree, (n) => n.props?.style?.borderRadius === token);
    assert.ok(styled, `${C.name} has no borderRadius ${token}`);
  }
});
```

- [ ] **Step 2: Run — fails** (no borderRadius anywhere).

- [ ] **Step 3: Implement** — in each primitive's base style object add one line, e.g. `PixelPanel`'s `baseStyle`: `borderRadius: 'var(--cth-radius-panel)',` (control/badge tokens for the other two; if a primitive styles multiple boxes, the OUTER box gets it).

- [ ] **Step 4: Verify** — test PASS; full component-test sweep `node --test test/*.test.cjs` (unsandboxed) still green; dev run: light/dark corners still square (token is 0px), occult subtly rounded.

- [ ] **Step 5: Commit** — `git add src/renderer/src/components/Pixel*.tsx test/occult-primitives.test.cjs && git commit -m "feat(theme): primitives round via radius tokens"`

### Task 6: ReleaseDrop joins the token system

**Files:**
- Modify: `src/renderer/src/components/ReleaseDrop.tsx` (~lines 49-54)
- Test: `test/occult-tokens.test.cjs` (extend)

**Interfaces:** none new — the file's private `PAPER/INK/YELLOW/SKY/MAROON` constants become `var(--cth-...)` strings.

- [ ] **Step 1: Failing test:**

```js
test('ReleaseDrop reads tokens, not a private palette', () => {
  const src = read('src/renderer/src/components/ReleaseDrop.tsx');
  assert.ok(!/#F3E9D2|#1A1320(?![\w])/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'private hex palette survives in ReleaseDrop');
  assert.match(src, /var\(--cth-/);
});
```

(Adjust the hex literals in the assertion to the actual constants at lines 49-54 after reading the file.)

- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** — map each constant to its nearest token (`PAPER → 'var(--cth-paper-100)'`, `INK → 'var(--cth-ink-900)'`, `YELLOW → 'var(--cth-lemon)'`, `SKY → 'var(--cth-sky)'`, `MAROON → 'var(--cth-coral)'`), keeping the constant names so the diff stays 5 lines.
- [ ] **Step 4: Verify** — test PASS; `node --test test/release-drop.test.cjs` still green; dev: release-drop surface follows all three themes.
- [ ] **Step 5: Commit** — `git commit -am "refactor: ReleaseDrop reads design tokens"`

### Task 7: Occult text-cursor + selection ground

**Files:**
- Modify: `src/renderer/src/design/occult/occult-tokens.css` (append)
- Test: `test/occult-tokens.test.cjs` (extend)

**Interfaces:** none — pure CSS under the occult guard.

- [ ] **Step 1: Failing test:**

```js
test('occult overrides the I-beam cursor and selection', () => {
  assert.match(occult, /data-cth-theme='occult'[\s\S]*cursor:/);
  assert.match(occult, /data-cth-theme='occult'[\s\S]*::selection/);
});
```

- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** — copy `global.css:47`'s SVG data-URI I-beam, recolor its two fills to parchment `%23EAE0C8` and gilt `%23C9A227`, add under `:root[data-cth-theme='occult'] textarea, :root[data-cth-theme='occult'] input, …` (same selector list global.css uses); add `:root[data-cth-theme='occult'] ::selection { background: var(--cth-gilt-soft); color: var(--cth-ink-900); }`.
- [ ] **Step 4: Verify** — test PASS; dev under occult: visible cursor in inputs, gilt selection; light/dark untouched.
- [ ] **Step 5: Commit** — `git commit -am "feat(theme): occult cursor and selection ground"`

### Task 8: Licence attribution + Sixth History logo

**Files:**
- Create: `src/renderer/src/assets/sixth-history/logo.png`, `src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md`, `src/renderer/src/components/SixthHistoryCredit.tsx`
- Modify: `src/renderer/src/components/SettingsModal.tsx` (mount the credit at the modal's footer region)
- Test: `test/sixth-history-credit.test.cjs` (create)

**Interfaces:**
- Produces: `SixthHistoryCredit(): JSX.Element | null` — renders the unofficial-content wording + logo when `useAppTheme() === 'occult'`, null otherwise.

- [ ] **Step 1: Obtain the logo** — download the Sixth History logo from the community-licence page's asset link (https://weatherfactory.biz/sixth-history-community-licence/). If the download needs a human step (form/zip), file it to Aaron and continue with a placeholder path; the component ships regardless. Write `ATTRIBUTION-SIXTH-HISTORY.md` recording: licence URL, download date, the exact obligation list (unofficial marking, logo display, curated-pack-only, Fair-Use text), and the licence's suggested attribution sentence verbatim.

- [ ] **Step 2: Failing test:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

test('the credit renders under occult and only under occult', () => {
  global.window = { localStorage: { getItem: () => 'occult', setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
  const { SixthHistoryCredit } = loadTs('src/renderer/src/components/SixthHistoryCredit.tsx');
  const inst = mount(SixthHistoryCredit, {});
  const text = JSON.stringify(inst.tree);
  assert.match(text, /unofficial content/i);
  assert.match(text, /Weather Factory/);
});
```

- [ ] **Step 3: Run — fails.** Implement the component:

```tsx
import { useAppTheme } from '@/design/theme';
import logo from '@/assets/sixth-history/logo.png';

/** Licence obligation, not decoration: the Sixth History Community Licence
 *  requires the unofficial marking + logo on content created under it. */
export function SixthHistoryCredit() {
  if (useAppTheme() !== 'occult') return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 'var(--cth-text-xs, 11px)', color: 'var(--cth-ink-500)' }}>
      <img src={logo} alt="Sixth History" style={{ height: 20 }} />
      <span>
        This theme is unofficial content based on the Secret Histories by
        Weather Factory Ltd. Find out more at weatherfactory.biz.
      </span>
    </div>
  );
}
```

Mount `<SixthHistoryCredit />` in `SettingsModal`'s footer region (locate the modal's bottom bar; one JSX line).

- [ ] **Step 4: Verify** — test PASS; dev under occult: credit + logo visible in Settings; under light/dark: absent.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(theme): Sixth History licence attribution"`

### Task 9: Milestone gate

- [ ] Run the full suite **unsandboxed**: `npm run test:focused` → all green; `npm run typecheck` → clean.
- [ ] Dev-run screenshot set for Aaron: light, dark, occult × (floor, Tasks, Settings, a terminal). Light/dark must match pre-branch screenshots exactly.
- [ ] Push `theme/sixth-history` to the fork. No PR — long-lived branch, Aaron reviews screenshots.
