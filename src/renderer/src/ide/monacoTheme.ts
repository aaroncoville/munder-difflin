/**
 * Which Monaco theme the editor wears, by app theme.
 *
 * This lives beside `monaco.ts` rather than inside it because `monaco.ts`
 * imports the whole editor and five web workers for its side effects, and a
 * test that only wants to know which theme id a theme maps to should not have
 * to drag that in. The mapping is the part worth pinning; the registration is
 * not.
 *
 * Light and dark both answer `cth-light`, and that is not an oversight — it is
 * the behaviour they have always had. The editor has only ever registered one
 * theme, so the dark app has always shown a cream editor. Giving dark its own
 * theme here would be a visible change to dark, and the occult work is not
 * allowed to make one. That is a separate change, worth making on its own.
 */
import type { AppTheme } from '@/design/theme';
import { OCCULT_MONACO_THEME } from '@/design/occult/occultTerminal';

export const CTH_MONACO_THEME = 'cth-light';

export function monacoThemeFor(theme: AppTheme): string {
  return theme === 'occult' ? OCCULT_MONACO_THEME : CTH_MONACO_THEME;
}
