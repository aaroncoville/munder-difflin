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
