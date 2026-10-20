/**
 * Which of the terminal pane's writes come from a person.
 *
 * xterm's `onData` fires for keystrokes AND for the terminal's own automated
 * replies: a CLI that probes the terminal at startup (DA, DSR, cursor-position
 * queries) gets its answers through the same event, so `onData` alone cannot
 * tell a person from a probe. xterm fires `onKey` for keyboard-originated
 * input just before the matching `onData`, so a transient flag set there, and
 * by the pane's paste paths, is what marks the next `onData` as a person's.
 * Main uses the answer (`PtyManager.write` source) to tell a PTY somebody has
 * used from one that died on launch (spawnRetry.ts).
 *
 * Trade-off, accepted: IME composition reaches `onData` without an `onKey`
 * event and is reported as 'auto'. The cost is one direction only — a
 * composed character not counted as a person means a launch-failure retry is
 * not suppressed for that PTY, which is harmless; counting a terminal reply
 * as a person would suppress it wrongly.
 */

export type TerminalInputSource = 'user' | 'auto';

/** How long a keyboard flag stays valid. `onKey` and its `onData` run in the
 *  same tick, so this only has to outlast a busy frame, not a round trip. */
export const KEYBOARD_FLAG_MS = 250;
/** A paste flag waits for an async clipboard read before `term.paste` fires. */
export const PASTE_FLAG_MS = 3_000;
/** Pasted text arrives wrapped in bracketed-paste markers; a terminal reply
 *  never does, so the wrapper alone identifies a person's paste — the browser's
 *  own Ctrl+V reaches xterm's paste handler without passing our paste paths. */
const BRACKETED_PASTE_START = '\x1b[200~';

export interface InputSourceTracker {
  /** A keyboard event that will produce data (xterm's onKey, or a custom key
   *  handler writing its own sequence). */
  noteKeyboard(now?: number): void;
  /** One of the pane's paste paths is about to feed text to the terminal. */
  notePaste(now?: number): void;
  /** Classify the `onData` chunk that just arrived and clear the flags. */
  consume(data: string, now?: number): TerminalInputSource;
}

export function createInputSourceTracker(): InputSourceTracker {
  let keyboardAt = -Infinity;
  let pasteAt = -Infinity;
  return {
    noteKeyboard: (now = Date.now()) => { keyboardAt = now; },
    notePaste: (now = Date.now()) => { pasteAt = now; },
    consume: (data, now = Date.now()) => {
      const user =
        now - keyboardAt <= KEYBOARD_FLAG_MS ||
        now - pasteAt <= PASTE_FLAG_MS ||
        data.includes(BRACKETED_PASTE_START);
      keyboardAt = -Infinity;
      pasteAt = -Infinity;
      return user ? 'user' : 'auto';
    }
  };
}

/** Wire a tracker to a terminal's keyboard events. Only `onKey` is needed from
 *  xterm; the pane calls `notePaste` from its own paste paths. */
export function attachInputSourceTracker(
  term: { onKey(listener: (event: unknown) => void): unknown }
): InputSourceTracker {
  const tracker = createInputSourceTracker();
  term.onKey(() => tracker.noteKeyboard());
  return tracker;
}
