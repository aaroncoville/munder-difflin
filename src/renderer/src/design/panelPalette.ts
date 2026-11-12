/**
 * Applies a user's panel palette (`<userData>/panel-palette.json`, read and
 * validated by main) to the document.
 *
 * The palette is written as inline custom properties on <html>, which outrank
 * every stylesheet rule that declares the same token, so the whole chrome
 * follows it. This runs once, before the first render.
 *
 * The terminal and editor cannot read custom properties, so their two surface
 * colours are carried across by hand: the ground follows `--cth-cream-300` and
 * the ink follows `--cth-ink-900` (in the editor, only when they are hex).
 * Their syntax and ANSI colours are not overridable.
 */
import { checkPanelPalette, type PanelPalette } from '@shared/panelPalette';

let applied: PanelPalette = {};

/** Validate `raw` again on this side of the bridge and apply it to <html>.
 *  Anything that fails the check applies nothing. */
export function applyPanelPalette(raw: unknown): void {
  const check = checkPanelPalette(raw ?? {});
  if (!check.ok) {
    console.warn(`[panel-palette] refused in the renderer: ${check.reason}`);
    return;
  }
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(check.palette)) style.setProperty(name, value);
  applied = check.palette;
}

interface TerminalSurface { background: string; foreground: string; cursorAccent: string }

/** `base` with its ground and ink taken from the applied palette. */
export function paletteTerminalTheme<T extends TerminalSurface>(base: T): T {
  const ground = applied['--cth-cream-300'];
  const ink = applied['--cth-ink-900'];
  return {
    ...base,
    ...(ground ? { background: ground, cursorAccent: ground } : {}),
    ...(ink ? { foreground: ink } : {})
  };
}

interface MonacoRule { token: string; foreground?: string; background?: string }
interface MonacoSurface { rules: MonacoRule[]; colors: Record<string, string> }

/** Monaco parses only hex colours, so an rgb()/rgba() override leaves the
 *  editor on its default for that colour. */
const hexOnly = (value: string | undefined): string | undefined =>
  value?.startsWith('#') ? value : undefined;

/** Monaco rule colours are six hex digits without the '#'. */
const ruleColour = (hex: string): string => {
  const h = hex.slice(1);
  return h.length === 3 || h.length === 4
    ? h.slice(0, 3).split('').map((c) => c + c).join('')
    : h.slice(0, 6);
};

/** `base` with its ground and ink taken from the applied palette. */
export function paletteMonacoTheme<T extends MonacoSurface>(base: T): T {
  const ground = hexOnly(applied['--cth-cream-300']);
  const ink = hexOnly(applied['--cth-ink-900']);
  if (!ground && !ink) return base;
  const colors = { ...base.colors };
  if (ground) colors['editor.background'] = ground;
  if (ink) colors['editor.foreground'] = ink;
  const rules = base.rules.map((rule) => {
    if (rule.token !== '') return rule;
    const next = { ...rule };
    if (ground) next.background = ruleColour(ground);
    if (ink) next.foreground = ruleColour(ink);
    return next;
  });
  return { ...base, colors, rules };
}
