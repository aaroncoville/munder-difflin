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
    const obs = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && attending()) {
        timer ??= setTimeout(() => {
          timer = null;
          // Still attending when the second is up, not only when the row scrolled in.
          if (!attending()) return;
          const now = Date.now();
          shownAt.set(askKey, now);
          const asked = askedAt ? Date.parse(askedAt) : NaN;
          send({ kind: 'ask-shown', askKey, surface: 'ask-me', ...(Number.isFinite(asked) && now >= asked ? { ageMs: now - asked } : {}) });
          obs.disconnect();
        }, 1000);
      } else if (timer) { clearTimeout(timer); timer = null; }
    });
    obs.observe(el);
    return () => { obs.disconnect(); if (timer) clearTimeout(timer); };
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
