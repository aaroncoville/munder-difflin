/**
 * The Study speaks in its own register while you are standing in it.
 *
 * `en-SH` is not a translation — it is English said differently: assistants at
 * reading desks instead of agents on a floor, commissions instead of tasks,
 * essence instead of tokens. It ships as a locale because that is where a
 * vocabulary belongs, and because i18next's `fallbackLng` then gives the
 * overlay for free: the file re-voices the nouns and every other key in the app
 * resolves to plain English, including keys added long after this was written.
 *
 * What is delicate is not the file, it is *when* the app switches to it. The
 * rule is in `voiceFor` alone, it is pure, and it exists to make one thing
 * impossible: taking somebody's language away from them because they changed a
 * theme. Somebody reading the app in Arabic did not ask for it in English, so
 * the register is offered ONLY to a reader already in English.
 *
 * The switch is deliberately not persisted. It is a function of the theme, so
 * it recomputes on the next launch from the theme — which leaves whatever the
 * reader actually chose in Settings as the thing that survives a restart.
 */
import { useEffect } from 'react';
import i18n from './index';
import { useAppTheme } from '@/design/theme';

/** The register the occult theme speaks in. */
export const THEME_VOICE = 'en-SH';

/** The plain English it is a register OF, and the only language it replaces. */
const BASE = 'en';

/**
 * The language the app should be speaking, or `null` for "leave it alone".
 *
 * Null is the common answer and it matters that it is distinguishable from
 * "switch to what you are already speaking": `changeLanguage` emits
 * `languageChanged`, which re-renders every translated component, and a rule
 * that returned the current language on every read would do that on every
 * theme subscription tick.
 */
export function voiceFor(theme: string, current: string): string | null {
  if (theme === 'occult') return current === BASE ? THEME_VOICE : null;
  return current === THEME_VOICE ? BASE : null;
}

/** Keep the app's voice in step with the theme. Called once, from `App`. */
export function useThemeVoice(): void {
  const theme = useAppTheme();
  useEffect(() => {
    const next = voiceFor(theme, i18n.language);
    if (next) void i18n.changeLanguage(next);
  }, [theme]);
}
