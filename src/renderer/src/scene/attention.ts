/**
 * Is anyone looking at the window?
 *
 * Two answers, for the scenes' ambient effects (the office floor's halo and
 * monitors, the Study's candlelight, dust and turning pages), which are worth
 * drawing only while someone can see them:
 *
 *  - `usePageVisible`: the document is not hidden and the window is shown
 *    (not minimised — document.hidden never flips for a minimised window on
 *    WSLg, so main reports minimise/restore itself, scene/windowShown.ts).
 *  - `useWindowAttended`: the window has focus, or lost it less than
 *    UNATTENDED_GRACE_MS ago. The grace is the same one the office floor's
 *    motion gate uses (officeMotion.ts), and counts from the blur alone: a
 *    scene that keeps changing is not a reason to keep drawing for nobody.
 *
 * Both are plain state hooks over window events; the planning is
 * unattendedPauseDelay, which is already pinned by the office-motion tests.
 */
import { useEffect, useState } from 'react';
import { getWindowShown, subscribeWindowShown } from './windowShown';
import { UNATTENDED_GRACE_MS, unattendedPauseDelay } from './office/officeMotion';

/** Can this global take event listeners? A test host's stand-in document or
 *  window often cannot; the hooks then hold their initial answer. */
function listens(target: unknown): target is { addEventListener: Function; removeEventListener: Function } {
  return !!target && typeof (target as { addEventListener?: unknown }).addEventListener === 'function';
}

/** The document is visible and the window is shown. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === 'undefined' || !listens(document)) return;
    const read = (): void => setVisible(!document.hidden && getWindowShown());
    read();
    document.addEventListener('visibilitychange', read);
    const unsubscribe = subscribeWindowShown(read);
    return () => { document.removeEventListener('visibilitychange', read); unsubscribe(); };
  }, []);
  return visible;
}

/** document.hasFocus(), or true where a document cannot say (test hosts). */
function hasFocus(): boolean {
  try { return typeof document.hasFocus === 'function' ? document.hasFocus() : true; } catch { return true; }
}

/** Focused, or blurred for less than `graceMs`. Starts from document.hasFocus();
 *  a window born unfocused still gets the whole grace. */
export function useWindowAttended(graceMs: number = UNATTENDED_GRACE_MS): boolean {
  const [attended, setAttended] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !listens(window)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let blurredAt = Date.now();
    const plan = (): void => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      const delay = unattendedPauseDelay({
        mode: 'reduced', focused: hasFocus(), blurredAt, now: Date.now(), graceMs
      });
      if (delay === null) { setAttended(true); return; }
      if (delay === 0) { setAttended(false); return; }
      setAttended(true);
      timer = setTimeout(() => { timer = null; setAttended(false); }, delay);
    };
    const onBlur = (): void => { blurredAt = Date.now(); plan(); };
    window.addEventListener('focus', plan);
    window.addEventListener('blur', onBlur);
    plan();
    return () => {
      window.removeEventListener('focus', plan);
      window.removeEventListener('blur', onBlur);
      if (timer !== null) clearTimeout(timer);
    };
  }, [graceMs]);
  return attended;
}
