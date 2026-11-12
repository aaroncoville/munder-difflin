/**
 * Reads a user's panel palette from `<userData>/panel-palette.json`.
 *
 * The file is data: it is read as text and parsed as JSON, never loaded as a
 * module or evaluated. What it may contain is decided in
 * `src/shared/panelPalette.ts`. Reading it can only ever produce the defaults
 * (an empty palette) or a fully validated one; it never throws, so a broken
 * file cannot stop the window opening.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { checkPanelPalette, type PanelPalette } from '../shared/panelPalette';

/** The largest palette file that is read. The full token list with comments
 *  fits in a few kilobytes; anything near this is not a palette. */
export const PANEL_PALETTE_MAX_BYTES = 64 * 1024;

export interface PanelPaletteDeps {
  read?: (file: string) => string;
  warn?: (message: string) => void;
}

const refused = (reason: string): Error => Object.assign(new Error(reason), { code: 'EPALETTE' });

/**
 * Read a small regular file, deciding what it is from the open handle, not
 * from the path. Checking the path first and opening it after leaves a gap in
 * which the path can be swapped for a link or a pipe; so the file is opened
 * once, without following a final link and without blocking (a named pipe
 * with no writer would otherwise hold the launch), and then the handle itself
 * is examined: it must be a regular file of at most PANEL_PALETTE_MAX_BYTES,
 * and no more than that is ever read from it.
 */
export function readBoundedFile(file: string): string {
  const noFollow = constants.O_NOFOLLOW;
  // Windows has no O_NOFOLLOW; there, refuse a link by looking first. The
  // remaining gap is a local race inside the user's own profile folder.
  if (noFollow === undefined && lstatSync(file).isSymbolicLink()) throw refused('it is a link');
  const fd = openSync(file, constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw refused('it is not a regular file');
    if (info.size > PANEL_PALETTE_MAX_BYTES) throw refused(`it is larger than ${PANEL_PALETTE_MAX_BYTES} bytes`);
    const buf = Buffer.alloc(PANEL_PALETTE_MAX_BYTES + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > PANEL_PALETTE_MAX_BYTES) throw refused(`it is larger than ${PANEL_PALETTE_MAX_BYTES} bytes`);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const defaultWarn = (message: string): void => console.warn(message);

/** Read and check one palette file. Missing is the normal case and is silent;
 *  anything else that stops the file applying is one warning. */
export function readPanelPalette(file: string, deps: PanelPaletteDeps = {}): PanelPalette {
  const read = deps.read ?? readBoundedFile;
  const warn = deps.warn ?? defaultWarn;
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      warn(`[panel-palette] ${file} is a link, which is not followed; using the default palette`);
    } else if (code !== 'ENOENT') {
      warn(`[panel-palette] could not read ${file}; using the default palette (${(err as Error)?.message ?? err})`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    // Some editors save UTF-8 with a byte-order mark, which JSON.parse rejects.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    warn(`[panel-palette] ${file} is not valid JSON; using the default palette`);
    return {};
  }
  const check = checkPanelPalette(parsed);
  if (!check.ok) {
    warn(`[panel-palette] ${file} was refused: ${check.reason}; using the default palette`);
    return {};
  }
  return check.palette;
}

/**
 * The palette for this run: the file is read the first time it is asked for
 * and never again, so every window of one launch wears the same palette and
 * an edit takes effect on the next start.
 */
export function panelPaletteSource(file: () => string, deps: PanelPaletteDeps = {}): () => PanelPalette {
  let palette: PanelPalette | undefined;
  return () => (palette ??= readPanelPalette(file(), deps));
}
