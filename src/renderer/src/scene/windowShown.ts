/**
 * The renderer's mirror of the main process's window visibility (see
 * shared/windowVisibility.ts). App.tsx feeds it from the preload's
 * onWindowVisibility; the office floor and the study's ambiance layer read it
 * next to document.hidden, which never flips for a minimised window on WSLg.
 * Shown until told otherwise: a window is created shown, and a renderer with
 * no main process behind it (tests) should behave as if looked at.
 */
import { useEffect, useState } from 'react';
import type { WindowVisibility } from '@shared/windowVisibility';

let shown = true;
/** Whether main has pushed a state yet. A push is newer than any answer to
 *  the seeding query still in flight, so the answer must not override it. */
let pushed = false;
const listeners = new Set<() => void>();

export function getWindowShown(): boolean {
  return shown;
}

/** Record what main reported. Returns true when it changed. */
export function setWindowShown(next: boolean): boolean {
  if (next === shown) return false;
  shown = next;
  return true;
}

export function subscribeWindowShown(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For tests. */
export function windowShownListenerCount(): number {
  return listeners.size;
}

function notify(): void {
  for (const l of [...listeners]) l();
}

/** What App.tsx calls on every message from main. */
export function applyWindowVisibility(v: WindowVisibility): void {
  pushed = true;
  if (!setWindowShown(v.shown !== false)) return;
  notify();
}

/** What App.tsx calls with main's answer to the query it sends on subscribe:
 *  the state of a renderer that loaded while its window was already
 *  minimised. Ignored once a push has arrived, which is newer. */
export function seedWindowVisibility(v: WindowVisibility): void {
  if (pushed) return;
  if (!setWindowShown(v.shown !== false)) return;
  notify();
}

/** For tests: forget that anything was pushed. */
export function resetWindowShown(): void {
  pushed = false;
  shown = true;
}

/** Is the window on screen, per the main process? */
export function useWindowShown(): boolean {
  const [state, setState] = useState(getWindowShown);
  useEffect(() => {
    setState(getWindowShown());
    return subscribeWindowShown(() => setState(getWindowShown()));
  }, []);
  return state;
}
