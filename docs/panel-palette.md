# The panel palette

Every colour the app's chrome is painted with comes from one set of tokens: panels, the command
centre, Settings, dialogs, cards, the terminal and the editor. The painted Study (its rooms,
portraits and candlelight) is artwork and is not part of it.

The palette lives once, at the top of the `:root` block in
[`src/renderer/src/design/tokens.css`](../src/renderer/src/design/tokens.css), and is mirrored in
`tokens.ts`. The terminal and editor restate it as literals in
`src/renderer/src/design/occult/occultTerminal.ts`, because xterm and Monaco cannot read CSS custom
properties.

## The defaults: open Dracula

The committed values are the open, MIT-licensed [Dracula](https://draculatheme.com/spec) palette.
Where the elevation ramp needs more grounds or inks than the palette has, the value is derived from
it by a per-channel mix of two palette colours (or of the background and black), and is marked
`DERIVED` in `tokens.css`.

| Token | Value | From |
|---|---|---|
| `--cth-cream-50` | `#282A36` | background (the app ground; also `APP_GROUND` in `src/shared/appGround.ts`) |
| `--cth-cream-100` | `#232530` | derived: background 12% toward black |
| `--cth-cream-200` | `#1E2029` | derived: background 24% toward black |
| `--cth-cream-300` | `#1A1B23` | derived: background 36% toward black (terminal and editor ground) |
| `--cth-paper-100` | `#323443` | derived: background 35% toward current line (cards, inputs) |
| `--cth-paper-200` | `#21222C` | ANSI black (recessed gutters) |
| `--cth-ink-900` | `#F8F8F2` | foreground (primary text) |
| `--cth-ink-700` | `#C4C9D7` | derived: foreground 35% toward comment (secondary text) |
| `--cth-ink-500` | `#9EA8C3` | derived: foreground 60% toward comment (hints) |
| `--cth-ink-300` | `#808DB4` | derived: comment 20% toward foreground (structural borders) |
| `--cth-ink-100` | `#44475A` | current line (dividers) |
| `--cth-coral` / `-light` | `#FF5555` / `#57333D` | red / derived: 78% toward background |
| `--cth-mint` / `-light` | `#50FA7B` / `#315845` | green / derived |
| `--cth-sky` / `-light` | `#8BE9FD` / `#3E5462` | cyan / derived |
| `--cth-lemon` / `-light` | `#F1FA8C` / `#545849` | yellow / derived |
| `--cth-lilac` / `-light` | `#BD93F9` / `#494161` | purple / derived |
| `--cth-peach` / `-light` | `#FFB86C` / `#574942` | orange / derived |
| `--cth-status-idle` | `#808DB4` | as ink-300 |
| `--cth-status-thinking` | `#8BE9FD` | cyan |
| `--cth-status-working` | `#F1FA8C` | yellow |
| `--cth-status-waiting` | `#BD93F9` | purple |
| `--cth-status-blocked` | `#FF5555` | red |
| `--cth-status-success` | `#50FA7B` | green |
| `--cth-status-ghost` | `#6272A4` | comment |
| `--cth-status-compacting` | `#FF79C6` | pink |
| `--cth-status-looping` | `#FFB86C` | orange |
| `--cth-status-typing` | `#F1FA8C` | yellow |
| `--cth-on-accent` | `var(--cth-cream-50)` | text on an accent fill |
| `--cth-hairline` | `var(--cth-ink-300)` | panel edges |
| `--cth-gilt` | `var(--cth-lilac)` | dialog borders, the focused rule |
| `--cth-gilt-soft` | `var(--cth-ink-100)` | selection fill |

Contrast (WCAG) across the six surfaces, cream-50 to paper-200: primary text 11.5 to 16.1:1,
secondary 7.4 to 10.4:1, hints 5.2 to 7.2:1, structural borders 3.7 to 5.2:1. Text on every accent
is at least 4.5:1. `test/panel-palette.test.cjs` holds these floors (text 4.5:1, borders 3:1).

The terminal uses the published Dracula ANSI colours, except `white`, which is `--cth-ink-500` so
plain program output stays distinguishable from the foreground.

## Using your own palette

You can replace any of these colours on your own machine, without changing the code, with a file
called `panel-palette.json` in the app's data folder (Electron's `userData`):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/<app name>/panel-palette.json` |
| Windows | `%APPDATA%\<app name>\panel-palette.json` |
| Linux | `~/.config/<app name>/panel-palette.json` (or `$XDG_CONFIG_HOME/<app name>/`) |

`<app name>` is `munder-difflin` when you run from source (`npm run dev`). An installed build
normally uses its product name, `Munder Difflin`. If you are unsure, it is the folder that already
holds `updater.log` and `usage/`.

The file is read **once, when the app starts**. Quit and reopen the app after editing it.

### Format

A flat JSON object. Each key is a token name **exactly as the CSS custom property is written,
including the leading `--cth-`**. Each value is a colour. You only need to list the tokens you want
to change; the rest keep their defaults.

```json
{
  "--cth-cream-50": "#282A36",
  "--cth-cream-100": "#232530",
  "--cth-cream-200": "#1E2029",
  "--cth-cream-300": "#1A1B23",
  "--cth-paper-100": "#323443",
  "--cth-paper-200": "#21222C",
  "--cth-ink-900": "#F8F8F2",
  "--cth-ink-700": "#C4C9D7",
  "--cth-ink-500": "#9EA8C3",
  "--cth-ink-300": "#808DB4",
  "--cth-ink-100": "#44475A",
  "--cth-coral": "#FF5555",
  "--cth-mint": "#50FA7B",
  "--cth-sky": "#8BE9FD",
  "--cth-lemon": "#F1FA8C",
  "--cth-lilac": "#BD93F9",
  "--cth-peach": "#FFB86C",
  "--cth-gilt": "#BD93F9",
  "--cth-gilt-soft": "#44475A"
}
```

(These are the defaults, so this example changes nothing; edit the values to taste.)

### Tokens you can set

Only these names are applied. Any other key is ignored.

```
--cth-cream-50  --cth-cream-100  --cth-cream-200  --cth-cream-300
--cth-paper-100  --cth-paper-200
--cth-ink-900  --cth-ink-700  --cth-ink-500  --cth-ink-300  --cth-ink-100
--cth-coral  --cth-coral-light  --cth-mint  --cth-mint-light
--cth-sky  --cth-sky-light  --cth-lemon  --cth-lemon-light
--cth-lilac  --cth-lilac-light  --cth-peach  --cth-peach-light
--cth-status-idle  --cth-status-thinking  --cth-status-working  --cth-status-waiting
--cth-status-blocked  --cth-status-success  --cth-status-ghost
--cth-status-compacting  --cth-status-looping  --cth-status-typing
--cth-on-accent  --cth-hairline  --cth-gilt  --cth-gilt-soft
```

### Validation

The values are written into CSS, so they are checked strictly:

- A value must be one of `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb(r, g, b)` or `rgba(r, g, b, a)`, with
  whole-number channels from 0 to 255 and an alpha from 0 to 1. Nothing else is accepted: no
  colour names, no `var()`, `url()` or other functions, no `;` or `}`, and no spaces around the
  value.
- **One invalid value refuses the whole file.** The app then uses the defaults and prints one
  warning to the console, saying which token was refused.
- A key that is not in the list above is ignored, whatever its value.
- A missing file means the defaults. An unreadable file, a folder at that path, or invalid JSON
  also means the defaults, with one warning.
- The file is only ever read as JSON. It is never run or loaded as code.

### What follows the override

The whole chrome. The terminal's and the editor's ground follow `--cth-cream-300`, and their text
follows `--cth-ink-900` (the editor only takes hex values for these two). Their ANSI and syntax
colours are not overridable. A few fixed literals are also outside the palette: the Librarian
panel's deepest well, and the release-notes window, which matches the landing site's page.
