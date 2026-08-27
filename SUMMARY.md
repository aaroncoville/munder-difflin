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
