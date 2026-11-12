/**
 * A user's own panel palette: `<userData>/panel-palette.json`.
 *
 * The chrome's colours are the panel palette at the top of
 * `src/renderer/src/design/tokens.css`. A user can replace any of them at
 * launch with a flat JSON object mapping a token name, written exactly as the
 * CSS custom property (`--cth-cream-50`), to a colour:
 *
 *   { "--cth-cream-50": "#282A36", "--cth-ink-900": "#F8F8F2" }
 *
 * The values end up inside CSS, so this is a security boundary and the rules
 * are deliberately narrow:
 *
 * - a value is `#RGB`, `#RRGGBB` or `#RRGGBBAA`, or `rgb(r, g, b)` /
 *   `rgba(r, g, b, a)` with integer channels 0-255 and an alpha 0-1, and
 *   nothing else: no names, no `var()`, no `url()`, no whitespace around it,
 *   and inside the brackets only plain spaces and tabs;
 * - ONE invalid value refuses the whole file, so a typo never yields half a
 *   palette;
 * - a name outside {@link PANEL_PALETTE_TOKENS} is ignored, whatever its value,
 *   and never reaches CSS.
 *
 * Shared because both sides check: main when it reads the file, and the
 * renderer again before it writes anything into the document.
 */

/** The file's name inside Electron's `userData` directory. */
export const PANEL_PALETTE_FILE = 'panel-palette.json';

/** Every token the file may set: the colour tokens of the panel palette. */
export const PANEL_PALETTE_TOKENS = [
  '--cth-cream-50', '--cth-cream-100', '--cth-cream-200', '--cth-cream-300',
  '--cth-paper-100', '--cth-paper-200',
  '--cth-ink-900', '--cth-ink-700', '--cth-ink-500', '--cth-ink-300', '--cth-ink-100',
  '--cth-coral', '--cth-coral-light', '--cth-mint', '--cth-mint-light',
  '--cth-sky', '--cth-sky-light', '--cth-lemon', '--cth-lemon-light',
  '--cth-lilac', '--cth-lilac-light', '--cth-peach', '--cth-peach-light',
  '--cth-status-idle', '--cth-status-thinking', '--cth-status-working',
  '--cth-status-waiting', '--cth-status-blocked', '--cth-status-success',
  '--cth-status-ghost', '--cth-status-compacting', '--cth-status-looping',
  '--cth-status-typing',
  '--cth-on-accent', '--cth-hairline', '--cth-gilt', '--cth-gilt-soft'
] as const;

export type PanelPaletteToken = typeof PANEL_PALETTE_TOKENS[number];
export type PanelPalette = Partial<Record<PanelPaletteToken, string>>;

const TOKENS: ReadonlySet<string> = new Set(PANEL_PALETTE_TOKENS);

const HEX = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const RGB = /^rgb\([ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*\)$/;
const RGBA = /^rgba\([ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*,[ \t]*(\d{1,3})[ \t]*,[ \t]*(0|1|0?\.\d{1,4}|1\.0{1,4})[ \t]*\)$/;

/** Whether `value` is a colour in one of the accepted forms, and only that. */
export function isPaletteColour(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (HEX.test(value)) return true;
  const m = RGB.exec(value) ?? RGBA.exec(value);
  return m !== null && [m[1], m[2], m[3]].every((c) => Number(c) <= 255);
}

export type PanelPaletteCheck =
  | { ok: true; palette: PanelPalette }
  | { ok: false; reason: string };

/** Check a parsed palette file. Never throws. */
export function checkPanelPalette(raw: unknown): PanelPaletteCheck {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'the file is not a JSON object of token names to colours' };
  }
  const palette: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!TOKENS.has(name)) continue;
    if (!isPaletteColour(value)) {
      return { ok: false, reason: `${name} is not a #hex or rgb()/rgba() colour` };
    }
    palette[name] = value;
  }
  return { ok: true, palette: palette as PanelPalette };
}
