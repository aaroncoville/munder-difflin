/**
 * The colour a window shows before the renderer has painted anything.
 *
 * Electron fills a new window with `backgroundColor` until the first frame, and
 * the boot splash in `src/renderer/index.html` covers the gap after that until
 * React mounts. Both used to be the old cream ground, so every launch flashed
 * cream before the app settled on its own dark palette.
 *
 * This is the app ground, `--cth-cream-50` in the panel palette of
 * `src/renderer/src/design/tokens.css` (Dracula background). The main process cannot
 * read a renderer stylesheet, so the value is kept here and a test holds it to
 * the token; `index.html` is static and repeats it, held to the same test.
 */
export const APP_GROUND = '#282A36';
