/**
 * The Study's terminal and editor, lit by the same candle as everything else.
 *
 * Two palettes, one register. The register is the occult theme's: a warm
 * ink-blue ground, aged-parchment ink, and candleflame gold where the light and
 * dark palettes reach for a cool blue. Nothing here fluoresces — a colour that
 * glows on a night ground reads as a different medium from the painted rooms
 * around it, which is exactly the seam the theme exists to remove.
 *
 * Both are RE-STATED literals rather than references to `--cth-*`, for the same
 * reason the light and dark xterm palettes above them are: xterm takes literal
 * colours and Monaco takes literal colours, and neither can read a CSS custom
 * property. That makes drift the standing risk — the dark palette sat a visible
 * step apart from its own panel for a release for exactly this reason. So every
 * value that MUST equal a token names it in a comment, and the two that carry
 * the surface — the ground and the ink — are held against the stylesheet by a
 * test, which fails the moment either side moves alone.
 *
 * The sixteen ANSI slots follow the dark palette's discipline: recognisable
 * hues, brights one legible step up rather than pastels, and enough separation
 * between the eight that a program colouring its output stays readable.
 */

/** The shape xterm's `theme` option takes — the subset this app sets. */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export const occultTerminalTheme: XtermTheme = {
  background: '#312717',        // = --cth-paper-100, the ground its panel sits on
  foreground: '#EAE0C8',        // = --cth-ink-900, aged paper
  cursor: '#C9A227',            // = --cth-gilt — a candleflame, not a block of light
  cursorAccent: '#312717',
  selectionBackground: '#453A1E',  // = --cth-lemon-light, gilt held down low
  selectionForeground: '#EAE0C8',

  black:        '#251E12',   // = --cth-paper-200 — one step under the ground,
                             //   so a program painting an ANSI-black cell dims
                             //   the parchment rather than punching a cold hole in it
  red:          '#B0524E',   // = --cth-coral — Grail crimson
  green:        '#5F7E5A',   // = --cth-mint — a verdigris green
  yellow:       '#C9A227',   // = --cth-gilt — candlelight
  blue:         '#7B6AA8',   // = --cth-lilac; the palette has no cold blue in it
  magenta:      '#9B6A93',   // between lilac and coral, so the two stay apart
  cyan:         '#3E7C7B',   // = --cth-sky, a muted teal
  white:        '#C9BEA4',   // = --cth-ink-700 — parchment, one step under the ink
  brightBlack:  '#776D8F',   // = --cth-ink-300; the borders colour, so dim text
                             //   sits at the same weight as a rule beside it
  brightRed:    '#CE7069',
  brightGreen:  '#83A077',
  brightYellow: '#E3C263',
  brightMagenta:'#BB89AF',
  brightBlue:   '#9C8CC6',
  brightCyan:   '#5FA09C',
  brightWhite:  '#EAE0C8'    // = --cth-ink-900
};

/** The id `monaco.editor.defineTheme` registers the candlelit editor under. */
export const OCCULT_MONACO_THEME = 'cth-occult';

/**
 * The editor in candlelight.
 *
 * Same hues as the terminal, so a file open in the editor and the same file
 * catted in the terminal are recognisably the same document. Monaco wants its
 * rule colours without the leading `#` and its `colors` map with it, which is
 * why the two halves below look inconsistent and are not.
 */
export const occultMonacoTheme = {
  base: 'vs-dark' as const,
  inherit: true,
  rules: [
    { token: '', foreground: 'EAE0C8', background: '312717' },
    { token: 'comment', foreground: '776D8F', fontStyle: 'italic' },
    { token: 'keyword', foreground: '9C8CC6' },
    { token: 'string', foreground: '83A077' },
    { token: 'number', foreground: 'CE7069' },
    { token: 'type', foreground: '5FA09C' },
    { token: 'function', foreground: 'E3C263' },
    { token: 'variable', foreground: 'EAE0C8' },
    { token: 'delimiter', foreground: 'C9BEA4' }
  ],
  colors: {
    'editor.background': '#312717',
    'editor.foreground': '#EAE0C8',
    'editorLineNumber.foreground': '#6B5A2E',        // = --cth-gilt-soft
    'editorLineNumber.activeForeground': '#C9A227',  // = --cth-gilt
    'editor.selectionBackground': '#453A1E',
    'editor.lineHighlightBackground': '#3B301D',
    'editorCursor.foreground': '#C9A227',
    'editorGutter.background': '#251E12',            // = --cth-paper-200
    'editorWidget.background': '#251E12',
    'editorIndentGuide.background1': '#4A3D26',
    'diffEditor.insertedTextBackground': '#5F7E5A33',
    'diffEditor.removedTextBackground': '#B0524E33',
    'diffEditor.insertedLineBackground': '#5F7E5A22',
    'diffEditor.removedLineBackground': '#B0524E22'
  }
};
