/**
 * Who is asked to confirm a quit that was asked for from inside the floor.
 *
 * The clock on the office wall and the hearth in the Study's parlour are
 * painted props, and a click on one has no undo behind it: it must always land
 * on the shared quit confirmation, wherever the click came from. The primary
 * window is the one that renders that dialog, so it is preferred — but it is
 * not the only renderer in the house, and its absence says nothing about what
 * the click meant.
 *
 * Being unable to show the confirmation is NOT permission to quit. So this
 * resolution is deliberately given nothing that can end the app: the worst it
 * can do is report that nobody could be asked, and the caller's only honest
 * answer to that is to refuse the request.
 */

/** The renderer side of a host: alive, and sendable. Structural on purpose, so
 *  the resolution can be exercised without an Electron window. */
export interface QuitHostContents {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** A window that could carry the dialog. */
export interface QuitHostWindow {
  isDestroyed(): boolean;
  focus(): void;
  webContents: QuitHostContents;
}

/** The event the confirmation is raised by. */
export const CLOSE_REQUESTED = 'app:closeRequested';

/**
 * Raise the quit confirmation on the first live renderer there is: the primary
 * window, else the floor that asked, else any other floor still standing.
 *
 * Returns whether anybody was asked. `false` means the request could not be
 * put to a human — never that it may be carried out.
 */
export function askToConfirmQuit(opts: {
  primary?: QuitHostWindow | null;
  /** The renderer that sent the request, when one did. */
  sender?: QuitHostContents | null;
  /** Every window currently open, primary included. */
  windows?: Iterable<QuitHostWindow>;
  ptyCount: number;
}): boolean {
  const live = (wc: QuitHostContents | null | undefined): wc is QuitHostContents =>
    !!wc && !wc.isDestroyed();
  const standing = (w: QuitHostWindow | null | undefined): w is QuitHostWindow =>
    !!w && !w.isDestroyed() && live(w.webContents);

  const ask = (wc: QuitHostContents, win?: QuitHostWindow): true => {
    // Bring the floor that is about to be asked forward, or the dialog opens
    // behind whatever the click was made through.
    win?.focus();
    wc.send(CLOSE_REQUESTED, { ptyCount: opts.ptyCount });
    return true;
  };

  if (standing(opts.primary)) return ask(opts.primary.webContents, opts.primary);
  if (live(opts.sender)) return ask(opts.sender);
  for (const w of opts.windows ?? []) if (standing(w)) return ask(w.webContents, w);
  return false;
}
