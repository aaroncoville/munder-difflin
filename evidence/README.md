# Milestone 1 evidence — occult chrome

## How these were made

`build-specimen.cjs` mounts the **real** `PixelPanel`, `PixelButton`, `PixelBadge`
and `SixthHistoryCredit` through the repository's own `test/render-hooks.cjs`
harness, serialises what they render to HTML, and links the **real**
`design/global.css` (which pulls in `tokens.css`, `fonts.css` and the two new
`occult/*.css` files). It is component output under production stylesheets, not
a redrawn mock — but it is **not the running Electron app**. See "What is not
here" below.

Every shot: Chrome, 1000×820 viewport, same page, same data.

## The light/dark regression contract

| File | Tree |
|---|---|
| `before-light.png`, `before-dark.png` | `361bfddd`, the commit this branch was cut from |
| `after-light.png`, `after-dark.png` | branch HEAD |

```
light: IDENTICAL  c48c1bf289a9593127cd4886c5e728d88d40cf7e5026e7d2ac49cccdd044e251
dark:  IDENTICAL  595d178fdf622910c74f3f3f33ac5b0cb996609008673d0b321858081caec740
```

Byte-identical PNGs, and not vacuously: the "after" markup carries 19
`border-radius: var(--cth-radius-*)` declarations the "before" markup has none
of. The inert defaults are doing exactly what they claim.

## The new theme

`after-occult.png` — same page, `data-cth-theme='occult'`. Cormorant SC small
caps in the display slot, night grounds, gilt hairlines and dialog border,
softened corners, and the Sixth History licence credit in the footer (which
renders under this theme and no other).

## What is not here, and what would settle it

The plan's Task 9 asks for app-level shots — the office floor, Tasks, Settings,
a terminal — in all three themes. Those were **not captured**. A build of this
app was running the live agent hive during this work, Electron holds a single
instance lock, and a second instance would have shared that instance's state.
Launching one was not a safe thing to do to a running system.

What settles it: `npm run dev` from this worktree with the hive idle, or
pointing the running install at this branch and cycling the title-bar theme
button three times.

