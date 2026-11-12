/**
 * Renderer side of the local usage log (docs/usage-log.md): which screens are
 * open and for how long, and when asks are first seen and answered. Ids, enums
 * and durations only; the main process allowlists every event again and writes
 * it to <userData>/usage, the app's own data folder. Nothing is sent anywhere.
 */
import { useEffect, useRef } from 'react';
import { answerShape } from '@shared/answerShape';

type UsageEvent = Record<string, string | number | boolean>;

function send(event: UsageEvent): void {
  try { window.cth.usageEvent?.(event); } catch { /* the log is best effort */ }
}

/** Visible and focused right now: only that time counts as dwell. */
const attending = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

/** Log a view opening, and its attended dwell time when it closes or changes. null = not shown. */
export function useUsageView(view: string | null, ids: { agentId?: string; cardId?: string } = {}): void {
  const { agentId, cardId } = ids;
  useEffect(() => {
    if (!view) return;
    send({ kind: 'ui-view', view, ...(agentId ? { agentId } : {}), ...(cardId ? { cardId } : {}) });
    let dwell = 0;
    let since = attending() ? Date.now() : null;
    const tick = (): void => {
      if (since !== null) dwell += Date.now() - since;
      since = attending() ? Date.now() : null;
    };
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('blur', tick);
    return () => {
      tick();
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('blur', tick);
      send({ kind: 'ui-view-end', view, dwellMs: dwell });
    };
  }, [view, agentId, cardId]);
}

/** When each ask was first seen in this window, by ask key. */
const shownAt = new Map<string, number>();

/** A zero-size marker inside an ask row: logs `ask-shown` once the row has been on screen for a second. */
export function AskSeen({ askKey, askedAt }: { askKey: string; askedAt?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || shownAt.has(askKey) || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onScreen = false;
    const disarm = (): void => { if (timer) { clearTimeout(timer); timer = null; } };
    // Start the one-second clock whenever the row is on screen and the window
    // is attended; attention can return after the row scrolled in, so focus and
    // visibility changes re-arm it too.
    const arm = (): void => {
      if (!onScreen || !attending() || shownAt.has(askKey)) { disarm(); return; }
      timer ??= setTimeout(() => {
        timer = null;
        // Still attending when the second is up, not only when it started.
        if (!onScreen || !attending() || shownAt.has(askKey)) return;
        const now = Date.now();
        shownAt.set(askKey, now);
        const asked = askedAt ? Date.parse(askedAt) : NaN;
        send({ kind: 'ask-shown', askKey, surface: 'ask-me', ...(Number.isFinite(asked) && now >= asked ? { ageMs: now - asked } : {}) });
        stop();
      }, 1000);
    };
    const obs = new IntersectionObserver(([entry]) => { onScreen = !!entry?.isIntersecting; arm(); });
    const stop = (): void => {
      obs.disconnect();
      window.removeEventListener('focus', arm);
      window.removeEventListener('blur', arm);
      document.removeEventListener('visibilitychange', arm);
      disarm();
    };
    window.addEventListener('focus', arm);
    window.addEventListener('blur', arm);
    document.addEventListener('visibilitychange', arm);
    obs.observe(el);
    return stop;
  }, [askKey, askedAt]);
  return <span ref={ref} aria-hidden style={{ display: 'block', width: 0, height: 0 }} />;
}

/** Log an answer sent from the Ask Me board: its length and shape, never its text. */
export function noteAskSubmitted(askKey: string, answer: string): void {
  const seen = shownAt.get(askKey);
  send({
    kind: 'ask-submitted', askKey, surface: 'ask-me',
    answerLen: answer.trim().length, answerShape: answerShape(answer),
    ...(seen !== undefined ? { msSinceShown: Date.now() - seen } : {})
  });
}
