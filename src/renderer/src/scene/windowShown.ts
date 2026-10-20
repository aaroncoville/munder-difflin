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

/** What App.tsx calls on every message from main. */
export function applyWindowVisibility(v: WindowVisibility): void {
  if (!setWindowShown(v.shown !== false)) return;
  for (const l of [...listeners]) l();
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
