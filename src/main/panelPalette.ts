/**
 * Reads a user's panel palette from `<userData>/panel-palette.json`.
 *
 * The file is data: it is read as text and parsed as JSON, never loaded as a
 * module or evaluated. What it may contain is decided in
 * `src/shared/panelPalette.ts`. Reading it can only ever produce the defaults
 * (an empty palette) or a fully validated one; it never throws, so a broken
 * file cannot stop the window opening.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { checkPanelPalette, type PanelPalette } from '../shared/panelPalette';

/** The largest palette file that is read. The full token list with comments
 *  fits in a few kilobytes; anything near this is not a palette. */
export const PANEL_PALETTE_MAX_BYTES = 64 * 1024;

interface PaletteStat { isFile(): boolean; size: number }

export interface PanelPaletteDeps {
  stat?: (file: string) => PaletteStat;
  read?: (file: string) => string;
  warn?: (message: string) => void;
}

const defaultStat = (file: string): PaletteStat => lstatSync(file);
const defaultRead = (file: string): string => readFileSync(file, 'utf8');
const defaultWarn = (message: string): void => console.warn(message);

/** Read and check one palette file. Missing is the normal case and is silent;
 *  anything else that stops the file applying is one warning. */
export function readPanelPalette(file: string, deps: PanelPaletteDeps = {}): PanelPalette {
  const stat = deps.stat ?? defaultStat;
  const read = deps.read ?? defaultRead;
  const warn = deps.warn ?? defaultWarn;
  let text: string;
  try {
    // Look before opening: a named pipe or device at the path would block the
    // read, and so the launch, indefinitely. lstat, so a link is refused too
    // rather than followed somewhere else.
    const info = stat(file);
    if (!info.isFile()) {
      warn(`[panel-palette] ${file} is not a regular file; using the default palette`);
      return {};
    }
    if (info.size > PANEL_PALETTE_MAX_BYTES) {
      warn(`[panel-palette] ${file} is larger than ${PANEL_PALETTE_MAX_BYTES} bytes; using the default palette`);
      return {};
    }
    text = read(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
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
