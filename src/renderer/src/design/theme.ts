/**
 * The app's one theme: Sixth History.
 *
 * The renderer is styled through the `--cth-*` tokens, and occult-tokens.css
 * re-points them under `data-cth-theme='occult'` on <html>. There is nothing to
 * choose between any more, so this module only stamps that attribute once, at
 * start-up, before the first render.
 *
 * Earlier builds let the reader pick light or dark and saved the pick in
 * localStorage (`cth.theme`, and before that `cth.ptyTheme`). Nothing reads
 * those keys now, so they are cleared rather than rewritten: a stored choice
 * that nothing honours could only mislead whoever finds it later.
 */

export const APP_THEME = 'occult';

const STALE_KEYS = ['cth.theme', 'cth.ptyTheme'] as const;

export function applyAppTheme(): void {
  try {
    for (const key of STALE_KEYS) window.localStorage.removeItem(key);
  } catch { /* storage unavailable: nothing to clear */ }
  try { document.documentElement.dataset.cthTheme = APP_THEME; } catch { /* SSR/tests */ }
}
