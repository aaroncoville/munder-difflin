/**
 * Forward a window's shown/hidden state to its renderer (see
 * shared/windowVisibility.ts for why document.hidden is not enough). Pure
 * event wiring over the slice of BrowserWindow it needs, so node:test can
 * drive it with a fake window.
 */
import {
  WINDOW_VISIBILITY_CHANNEL, WINDOW_VISIBILITY_GET_CHANNEL, windowShown,
  type WindowShownSource, type WindowVisibility
} from '../shared/windowVisibility';

export type WindowVisibilityEvent = 'minimize' | 'restore' | 'hide' | 'show' | 'closed';

/** The BrowserWindow events that change whether anyone can see the window. */
export const WINDOW_VISIBILITY_EVENTS: readonly WindowVisibilityEvent[] = ['minimize', 'restore', 'hide', 'show'];

export interface WindowLike extends WindowShownSource {
  on(event: WindowVisibilityEvent, listener: () => void): unknown;
  removeListener(event: WindowVisibilityEvent, listener: () => void): unknown;
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: WindowVisibility): void };
}

/** Send the window's state to its renderer on every change, and let go on
 *  'closed'. Returns the uninstall; a destroyed window is left alone rather
 *  than thrown at. */
export function installWindowVisibility(win: WindowLike): () => void {
  const announce = () => {
    if (win.isDestroyed()) return;
    const payload: WindowVisibility = { shown: windowShown(win) };
    try { win.webContents.send(WINDOW_VISIBILITY_CHANNEL, payload); } catch { /* renderer gone */ }
  };
  const uninstall = () => {
    for (const ev of WINDOW_VISIBILITY_EVENTS) win.removeListener(ev, announce);
    win.removeListener('closed', uninstall);
  };
  for (const ev of WINDOW_VISIBILITY_EVENTS) win.on(ev, announce);
  win.on('closed', uninstall);
  return uninstall;
}

/** The slice of ipcMain the query needs. */
export interface IpcHandleLike {
  handle(channel: string, listener: (event: { sender: unknown }) => unknown): void;
}

/** Answer a renderer asking for its own window's state: the handshake that
 *  seeds a renderer which loaded while already minimised. `windowOf` is
 *  BrowserWindow.fromWebContents; a sender with no window (gone, or not one of
 *  ours) is told it is shown, which is the renderer's own default. */
export function registerWindowVisibilityQuery(
  ipc: IpcHandleLike,
  windowOf: (sender: unknown) => (WindowShownSource & { isDestroyed(): boolean }) | null
): void {
  ipc.handle(WINDOW_VISIBILITY_GET_CHANNEL, (event): WindowVisibility => {
    const win = windowOf(event.sender);
    if (!win || win.isDestroyed()) return { shown: true };
    return { shown: windowShown(win) };
  });
}
