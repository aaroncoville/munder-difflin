/**
 * App-wide theme (v0.3.4) — ONE light/dark switch for the whole UI, not just
 * the terminal.
 *
 * The entire renderer is styled through the `--cth-*` tokens, so dark mode is
 * a token swap: this module stamps `data-cth-theme` on <html> and tokens.css
 * carries the dark overrides. The xterm palette (PtyTerminalView) and the
 * per-agent Claude session theme (config.terminalTheme, applied on spawn)
 * follow the same state, so terminals and TUIs match the chrome.
 *
 * Shared subscribable module (same pattern as terminalFontSize): components
 * read it with `useAppTheme()`; the ONE toggle lives in the title bar.
 */
import { useSyncExternalStore } from 'react';

export type AppTheme = 'light' | 'dark' | 'occult';

const LS_KEY = 'cth.theme';
/** Pre-0.3.4 the terminal had its own theme key — honor it once as the seed. */
const LEGACY_LS_KEY = 'cth.ptyTheme';

function load(): AppTheme {
  try {
    const v = window.localStorage.getItem(LS_KEY) ?? window.localStorage.getItem(LEGACY_LS_KEY);
    if (v === 'dark' || v === 'light' || v === 'occult') return v;
  } catch { /* noop */ }
  return 'light';
}

let theme: AppTheme = load();
const subscribers = new Set<() => void>();

function apply(): void {
  try { document.documentElement.dataset.cthTheme = theme; } catch { /* SSR/tests */ }
}
apply();

export function appTheme(): AppTheme {
  return theme;
}

export function setAppTheme(next: AppTheme): void {
  if (next === theme) return;
  theme = next;
  try { window.localStorage.setItem(LS_KEY, next); } catch { /* noop */ }
  apply();
  subscribers.forEach((fn) => fn());
}

/** The one title-bar control walks this ring; order is the ring. */
const CYCLE: readonly AppTheme[] = ['light', 'dark', 'occult'];

export function toggleAppTheme(): AppTheme {
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
  setAppTheme(next);
  return next;
}

/** What the one theme control shows and says, given where the ring stands. */
export interface ThemeControlFace {
  /** The theme a click moves to. */
  next: AppTheme;
  /** Glyph for the destination, in the title bar's existing text-glyph idiom. */
  icon: string;
  /** English wording, for the title bar, which is not wired to i18n. */
  label: string;
  /** The same wording as a translation key, for the fullscreen mirror. */
  labelKey: string;
}

/**
 * The ring has three stops but both controls presented it as a binary: under
 * occult they showed a moon and said "dark theme" while a click went to light.
 * Icon and wording now come from here, so the two controls cannot disagree
 * with each other or with the cycle, and every state is one line to read.
 */
const CONTROL_FACE: Readonly<Record<AppTheme, ThemeControlFace>> = {
  light: {
    next: 'dark', icon: '☾',
    label: 'Switch to the dark theme', labelKey: 'fullscreenTerminal.darkTheme'
  },
  dark: {
    // A star rather than a candle: the title bar's glyphs are text at 13px in
    // the UI face, and this one has to sit beside the sun and the moon.
    next: 'occult', icon: '✦',
    label: 'Switch to the occult theme', labelKey: 'fullscreenTerminal.occultTheme'
  },
  occult: {
    next: 'light', icon: '☀',
    label: 'Switch to the light theme', labelKey: 'fullscreenTerminal.lightTheme'
  }
};

export function themeControlFace(current: AppTheme): ThemeControlFace {
  return CONTROL_FACE[current];
}

/**
 * Terminals and TUIs only have two palettes. Occult borrows the dark one until
 * it grows a candlelit palette of its own, so every place that hands a theme to
 * xterm or to a spawned agent's settings routes through here rather than
 * re-deciding the mapping.
 */
export function terminalThemeFor(t: AppTheme): 'light' | 'dark' {
  return t === 'light' ? 'light' : 'dark';
}

export function useAppTheme(): AppTheme {
  return useSyncExternalStore(
    (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    () => theme
  );
}
