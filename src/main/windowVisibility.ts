/**
 * Forward a window's shown/hidden state to its renderer (see
 * shared/windowVisibility.ts for why document.hidden is not enough). Pure
 * event wiring over the slice of BrowserWindow it needs, so node:test can
 * drive it with a fake window.
 */
import {
  WINDOW_VISIBILITY_CHANNEL, windowShown, type WindowShownSource, type WindowVisibility
} from '../shared/windowVisibility';

export type WindowVisibilityEvent = 'minimize' | 'restore' | 'hide' | 'show';

/** The BrowserWindow events that change whether anyone can see the window. */
export const WINDOW_VISIBILITY_EVENTS: readonly WindowVisibilityEvent[] = ['minimize', 'restore', 'hide', 'show'];

export interface WindowLike extends WindowShownSource {
  on(event: WindowVisibilityEvent, listener: () => void): unknown;
  removeListener(event: WindowVisibilityEvent, listener: () => void): unknown;
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: WindowVisibility): void };
}

/** Send the window's state to its renderer on every change. Returns the
 *  uninstall; a destroyed window is left alone rather than thrown at. */
export function installWindowVisibility(win: WindowLike): () => void {
  const announce = () => {
    if (win.isDestroyed()) return;
    const payload: WindowVisibility = { shown: windowShown(win) };
    try { win.webContents.send(WINDOW_VISIBILITY_CHANNEL, payload); } catch { /* renderer gone */ }
  };
  for (const ev of WINDOW_VISIBILITY_EVENTS) win.on(ev, announce);
  return () => { for (const ev of WINDOW_VISIBILITY_EVENTS) win.removeListener(ev, announce); };
}
