/**
 * Reads a user's panel palette from `<userData>/panel-palette.json`.
 *
 * The file is data: it is read as text and parsed as JSON, never loaded as a
 * module or evaluated. What it may contain is decided in
 * `src/shared/panelPalette.ts`. Reading it can only ever produce the defaults
 * (an empty palette) or a fully validated one; it never throws, so a broken
 * file cannot stop the window opening.
 */
import { readFileSync } from 'node:fs';
import { checkPanelPalette, type PanelPalette } from '../shared/panelPalette';

export interface PanelPaletteDeps {
  read?: (file: string) => string;
  warn?: (message: string) => void;
}

const defaultRead = (file: string): string => readFileSync(file, 'utf8');
const defaultWarn = (message: string): void => console.warn(message);

/** Read and check one palette file. Missing is the normal case and is silent;
 *  anything else that stops the file applying is one warning. */
export function readPanelPalette(file: string, deps: PanelPaletteDeps = {}): PanelPalette {
  const read = deps.read ?? defaultRead;
  const warn = deps.warn ?? defaultWarn;
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      warn(`[panel-palette] could not read ${file}; using the default palette (${(err as Error)?.message ?? err})`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
