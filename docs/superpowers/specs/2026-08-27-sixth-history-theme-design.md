# Sixth History Theme — Design

**Date:** 2026-08-27 · **Branch:** `theme/sixth-history` (fork-only until polished)
**Decided with:** Aaron, live session 2026-08-27. Choices recorded inline.

## What this is

A full re-metaphor of Munder Difflin in the idiom of Weather Factory's Secret
Histories games (Cultist Simulator / BOOK OF HOURS), under their
[Sixth History Community Licence](https://weatherfactory.biz/sixth-history-community-licence/).
The office floor becomes a painted, candlelit **Study**; agents become framed
portrait-cards at reading desks; tasks become books being read — BOOK OF HOURS
research at a desk. The whole chrome takes an occult art-deco dress, and the
app can speak in the Secret Histories voice via a locale.

Decisions taken during brainstorming (each was an explicit fork):

1. **Re-metaphor, not reskin** — the fiction changes, not just the palette.
2. **Painted/illustrated, not pixel-art** — the pixel idiom is abandoned for
   this theme; raster art is AI-generated (Flux via Replicate), vector
   ornament is hand-authored SVG.
3. **Portrait-cards, not walking sprites** — agents are framed painted
   portraits that glide between berths. No character animation frames exist
   or are needed. The backdrop is composed *for* cards so they read as
   resting on desks, not floating over an office.
4. **Hybrid renderer (approach 3)** — DOM card layer over a thin Pixi
   ambiance canvas over a painted backdrop. Ambiance is required, not
   optional polish ("gotta have ambiance").
5. **Voice as a locale** — the Secret Histories verbiage ships as `en-SH`,
   leveraging upstream's i18n rather than forking strings.
6. **New-files-first** — nearly all work lands in new files so upstream
   merges stay cheap. Shared-file surface area is ~5 one-line touch-points.

## Licence obligations (hard requirements)

The Sixth History Community Licence permits fan works — including commercial
up to £50k/yr combined — under conditions this theme builds in, not bolts on:

- **Unofficial marking**: the suggested wording ("… is unofficial content
  based on the Secret Histories by Weather Factory Ltd …") renders in the
  About/credits surface and the themed splash.
- **Sixth History logo** displayed on content created under the licence
  (resize/recolor permitted). Rendered with the attribution.
- **Curated assets only**: only the downloadable community asset pack's
  portraits/icons/images may be used — never other WF art or official logos.
- **Fair-Use text only**: no substantial copying of their prose. The `en-SH`
  locale is original writing in their register, not quoted text.
- An `ATTRIBUTION-SIXTH-HISTORY.md` beside the assets records all of this,
  mirroring the existing LimeZu attribution pattern.

## Architecture

```
src/renderer/src/scene/study/          ← the scene (all new files)
  StudyScene.tsx        top component: backdrop → ambiance → card layer
  roomManifest.ts       types + loader for room.json (berths, anchors, zones)
  AgentCard.tsx         framed portrait-card: portrait, plaque, status, glide
  DeskBook.tsx          task-as-open-book at a desk
  SpeechScroll.tsx      parchment replacement for thought/tool bubbles
  AmbianceLayer.tsx     thin Pixi canvas: flicker, motes, hearth smoke
  useSceneState.ts      Zustand selectors → scene props (pure projection)
  assets/               backdrop, frame/ornament SVGs, room.json, portraits
src/renderer/src/design/occult/
  occult-tokens.css     :root[data-cth-theme='occult'] + new token families
  occult-fonts.css      self-hosted deco display face
src/renderer/src/i18n/locales/en-SH.json
tools/occult-art/                      ← generation scripts + prompt sheets
```

**Touch-points in existing files** (the entire shared surface):
`App.tsx` floor mount gains a `FloorHost` conditional (occult theme →
`StudyScene`, else `OfficeFloor`); `design/theme.ts` gains the `'occult'` id;
i18n index registers `en-SH`; `global.css` gains two `@import` lines; splash
+ BrowserWindow background follow the theme id. The tile-oriented
`ThemeConfig` registry (TV-show offices) is deliberately **not** extended —
the painted scene is selected above it, so upstream evolves it untouched.

## The Study (scene)

One painted interior at Hush House intimacy, not cathedral scale. Berths are
data (`room.json`, normalized coordinates), so art iterations never touch
code. Berths and their meanings:

| Berth | Is | Interaction |
|---|---|---|
| Reading desks (6–8) | one agent each | card + DeskBook; click → agent |
| The god's desk | Aaron's seat, foreground | larger card |
| Card table | task board | click → Tasks kanban; card stacks mirror column counts |
| Writing desk | Ask Me | sealed letters stack = open-ask badge; click → Ask Me |
| Almanac stand | Triggers | click → Triggers |
| Hearth | Closing Time | click → Closing Time |
| Shelves | done archive | completed book flies desk → shelf (the one scripted animation) |

Task states on the DeskBook: idle = closed book, candle low; working = open
book, quill on card, candle bright; blocked = ribbon seal on the book.

**Data flow:** `useSceneState.ts` projects the existing store (roster,
status, tasks, asks, speech feed). No new state, no new IPC. Speech renders
as a `SpeechScroll` above the card, same content source as the bubbles.

**Motion:** cards move only on real events (summon = glide from door to a
free desk; archive = fade). No wandering — the ambiance layer supplies life.
Card motion is CSS transforms on motion tokens; no per-frame JS for cards.

**Ambiance (Pixi):** glow-sprite flicker at manifest-marked light points,
dust motes in window light, hearth smoke. Capped particle counts, paused
when hidden, disabled entirely under `prefers-reduced-motion`.
`pointer-events: none` — all input is DOM (manifest zones as positioned
regions).

## App-wide chrome

- **Tokens:** `occult-tokens.css` redefines all 66 existing tokens (deep
  ink-blue/charcoal grounds, parchment text, candlelight gold, Grail
  crimson, muted teal) and adds four families the deco look needs:
  `--cth-radius-*`, `--cth-hairline`, `--cth-gilt-*`, `--cth-ease-*`/
  `--cth-dur-*`. Light/dark receive inert defaults for the new families and
  must render **byte-identically** — that is the regression contract.
  Palette changes are mirrored into `design/tokens.ts` (Pixi) per its
  lockstep rule.
- **Type:** `--cth-font-display` swaps Press Start 2P for a self-hosted
  deco/didone face (specimens of Cormorant, Playfair Display, Poiret One to
  be rendered for Aaron's pick); the six display size/LH tokens are retuned
  per-theme. Body Inter and mono JetBrains Mono stay. CJK/Arabic fallback
  tails preserved verbatim.
- **Primitives:** `PixelPanel`/`PixelButton`/`PixelBadge` read the new
  families (soft candlelit elevation, gilt hairlines, subtle radius) —
  token-driven, invisible outside the occult theme. Optional SVG ornament
  slot for marquee panels.
- **Portraits in chrome:** licensed pack portraits wherever the DOM shows an
  agent face; a mapping file assigns portraits per role; unmapped agents get
  a style-matched generated portrait.
- **Stragglers, each themed by the same id:** Monaco (`cth-occult`), both
  xterm ANSI palettes (candlelit-legible 16 colors), `ReleaseDrop`'s private
  palette, `global.css` noise gradient + cursor SVG, pre-React splash,
  BrowserWindow background, and a deco redraw of the 22-icon set inside
  `Icon.tsx`'s contract.

## Voice locale (`en-SH`)

Base-English locale in the Secret Histories register: agents → *Assistants*,
hive → *the House*, spawn → *summon*, tokens/cost → *essence*, Ask Me →
*Petitions*, Closing Time → *the Hour of Rest*, kanban → *Intended /
Underway / Impeded / Concluded*. Rules: flavor lives in nouns, never
obscures what a control does; complete coverage with fallback-to-English for
any key upstream adds later. Theme and locale toggle independently; the
occult theme suggests the pair.

## Art pipeline

`tools/occult-art/` drives Replicate (token at `~/.config/replicate/token`,
validated 2026-08-27 with a first probe). One YAML prompt sheet per asset
(prompt, model, seed, size, post-steps); flux-schnell (~$0.003/img) for
draft batches, flux-dev (~$0.025/img) for finals. Every shipped image is
reproducible from its checked-in sheet. Loop per asset: draft batch →
contact sheet to Aaron → pick/veto → final. The backdrop is generated in
layers (room shell, then desk vignettes) so berth positions can shift
without regenerating the world. Card frames and ornament are hand-authored
SVG, not generated. Budget: well under the $20 credited.

## Testing

node:test + the existing render-hooks harness: mounts for `StudyScene`,
`AgentCard`, `DeskBook`; manifest-zone hit mapping; glide-on-event logic; a
token-contract test (light/dark untouched by new families); locale
completeness (every en key present in en-SH or intentionally falling
through); reduced-motion gate on the ambiance layer. Visual QA is manual
(Aaron + screenshots), per house workflow.

## Rollout

Long-lived fork branch `theme/sixth-history`; upstream merges stay cheap via
the new-files discipline. Milestones, each independently demoable:

1. **Chrome** — occult tokens + fonts + primitives + icons; floor still the
   pixel office.
2. **The Study** — painted scene replaces the floor under the occult theme.
3. **Ambiance + voice** — Pixi ambiance layer, `en-SH`, polish pass.

## Risks

- **Style consistency** across generated assets → seeds, reference
  prompting, one shared prompt vocabulary.
- **Licence obligations** → rendered by the theme itself; attribution file;
  curated-pack-only rule enforced at the asset directory.
- **Upstream i18n drift** → fallback rule absorbs new keys.
- **Scene scope creep** → the manifest is the fence: features not
  expressible as berths/zones wait.
- **Perf** on the ambiance layer → particle caps, visibility pause,
  reduced-motion off-switch.
