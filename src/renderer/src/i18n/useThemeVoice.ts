/**
 * The app speaks in the Study's own register.
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
 * impossible: taking somebody's language away from them. Somebody reading the
 * app in Arabic did not ask for it in English, so the register is offered ONLY
 * to a reader already in English.
 *
 * The switch is deliberately not persisted. It is a function of the chosen
 * language, so it recomputes on the next launch — which leaves whatever the
 * reader actually chose in Settings as the thing that survives a restart.
 */
import { useEffect } from 'react';
import i18n from './index';

/** The register the app speaks in. */
export const THEME_VOICE = 'en-SH';

/** The plain English it is a register OF, and the only language it replaces. */
const BASE = 'en';

/**
 * The language the app should be speaking, or `null` for "leave it alone".
 *
 * Null is the common answer and it matters that it is distinguishable from
 * "switch to what you are already speaking": `changeLanguage` emits
 * `languageChanged`, which re-renders every translated component, and a rule
 * that returned the current language on every read would loop on its own
 * answer.
 */
export function voiceFor(current: string): string | null {
  return current === BASE ? THEME_VOICE : null;
}

/** The part of an i18next instance the watcher needs, so the rule can be run
 *  against a stand-in and the subscription is testable without a bundler. */
export interface VoiceI18n {
  language: string;
  changeLanguage(lng: string): unknown;
  on(event: 'languageChanged', listener: (lng: string) => void): void;
  off(event: 'languageChanged', listener: (lng: string) => void): void;
}

/**
 * Hold `inst` to the rule until the returned function is called.
 *
 * Applying the rule once at start-up is not enough: pick English in Settings
 * and you would get plain English until the next launch. So the watcher also
 * answers every language change.
 *
 * Answering `languageChanged` by calling `changeLanguage` does of course emit
 * `languageChanged` again, and this settles rather than spinning for exactly
 * one reason: `voiceFor` returns null once the language is already the one it
 * would ask for. That null is the fixed point of the loop, not a nicety — the
 * second hop is always the last one.
 */
export function watchVoice(inst: VoiceI18n): () => void {
  const apply = (): void => {
    const next = voiceFor(inst.language);
    if (next) void inst.changeLanguage(next);
  };
  apply();
  inst.on('languageChanged', apply);
  return () => inst.off('languageChanged', apply);
}

/** Keep the app in the house register. Called once, from `App`. */
export function useThemeVoice(): void {
  useEffect(() => watchVoice(i18n), []);
}
