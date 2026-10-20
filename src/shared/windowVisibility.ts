/**
 * Whether a window is on screen at all, as the main process knows it.
 *
 * The renderer's own signal, `document.hidden`, is what the office floor and
 * the study's ambiance layer paused on. On WSLg it never flips: Chromium does
 * not mark a minimised or fully occluded Wayland window hidden, and the
 * windows are created with backgroundThrottling off besides. Measured with
 * the app window minimised for a minute, the floor went on drawing at full
 * cost, identical to the window being up.
 *
 * The main process does know. BrowserWindow fires 'minimize' / 'restore' and
 * 'hide' / 'show', and those are forwarded to the window's own renderer on
 * this channel, independent of document.hidden. Occlusion by another window
 * has no event on Linux, so it is not covered; minimise is the common case.
 */

export const WINDOW_VISIBILITY_CHANNEL = 'window:visibility';
/** invoke → the current state of the sender's window. A renderer that loads
 *  (or reloads) while its window is already minimised would otherwise start
 *  shown and never see a transition. */
export const WINDOW_VISIBILITY_GET_CHANNEL = 'window:visibility:get';

export interface WindowVisibility {
  /** False while minimised or hidden. */
  shown: boolean;
}

/** The slice of a BrowserWindow the decision reads. */
export interface WindowShownSource {
  isVisible(): boolean;
  isMinimized(): boolean;
}

/** Shown means visible and not minimised; a minimised window still reports
 *  isVisible() true on some platforms, which is why both are asked. */
export function windowShown(win: WindowShownSource): boolean {
  return win.isVisible() && !win.isMinimized();
}
