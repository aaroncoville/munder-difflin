/**
 * The Study's terminal and editor, lit by the same candle as everything else.
 *
 * Two palettes, one register. The register is the occult theme's: the Study's
 * deepest night ground, aged-parchment ink, and candleflame gold where the light and
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
 * between the eight that a program colouring its output stays readable. On
 * the deepest-night ground every normal slot clears 6.1:1 and every bright
 * 8.0:1, except `brightBlack`, which is deliberately the border colour (4.0:1).
 * The two inks that carry text — the foreground and the `white` a program
 * prints plain output in — sit at 14.4:1 and 7.9:1, a ratio of 1.8 between
 * them: warm parchment against a cool moonlight, so the eye separates them by
 * hue before it measures weight. Two shades of the same tan, told apart by
 * weight alone, was a legibility defect this palette has already had.
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
  background: '#120F1B',        // = --cth-cream-300, the Study's deepest night
  foreground: '#EAE0C8',        // = --cth-ink-900, aged paper
  cursor: '#C9A227',            // = --cth-gilt — a candleflame, not a block of light
  cursorAccent: '#120F1B',
  selectionBackground: '#514529',  // gilt held down low; the ink stays at 7.2:1 on it
  selectionForeground: '#EAE0C8',

  black:        '#0F0C17',   // one step under the ground,
                             //   so a program painting an ANSI-black cell dims
                             //   the parchment rather than punching a cold hole in it
  red:          '#D07D75',   // Grail crimson, lifted clear of the night — 6.2:1
  green:        '#74A177',   // verdigris — 6.4:1
  yellow:       '#C9A227',   // = --cth-gilt — candlelight, 7.8:1
  blue:         '#8494D2',   // periwinkle, the register --cth-status-waiting uses.
                             //   The lilac this slot once held sits in the
                             //   ground's own violet hue and lands at 4.0:1 on it
  magenta:      '#B886B4',   // lifted clear of both the blue and the ground — 6.4:1
  cyan:         '#55A2A0',   // the muted teal, one step up for the night — 6.4:1
  white:        '#ADA3BE',   // moonlight: the SECONDARY ink, cool where the
                             //   foreground is warm, 7.9:1 on the ground and 1.8
                             //   under the foreground
  brightBlack:  '#786E90',   // = --cth-ink-300; the borders colour, so dim text
                             //   sits at the same weight as a rule beside it
  brightRed:    '#E29A92',
  brightGreen:  '#8CB98F',
  brightYellow: '#E3C263',
  brightBlue:   '#9CAAE0',
  brightMagenta:'#C79CC3',
  brightCyan:   '#6FB8B5',
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
    { token: '', foreground: 'EAE0C8', background: '120F1B' },
    { token: 'comment', foreground: '786E90', fontStyle: 'italic' },
    { token: 'keyword', foreground: '9CAAE0' },
    { token: 'string', foreground: '8CB98F' },
    { token: 'number', foreground: 'E29A92' },
    { token: 'type', foreground: '6FB8B5' },
    { token: 'function', foreground: 'E3C263' },
    { token: 'variable', foreground: 'EAE0C8' },
    { token: 'delimiter', foreground: 'ADA3BE' }
  ],
  colors: {
    'editor.background': '#120F1B',
    'editor.foreground': '#EAE0C8',
    'editorLineNumber.foreground': '#8A7440',        // = --cth-hairline, gilt leaf
                                                     //   at 4.2:1 — quiet, findable
    'editorLineNumber.activeForeground': '#C9A227',  // = --cth-gilt
    'editor.selectionBackground': '#514529',
    'editor.lineHighlightBackground': '#332B50',
    'editorCursor.foreground': '#C9A227',
    'editorGutter.background': '#0F0C17',
    'editorWidget.background': '#0F0C17',
    'editorIndentGuide.background1': '#443A66',
    'diffEditor.insertedTextBackground': '#74A17733',
    'diffEditor.removedTextBackground': '#D07D7533',
    'diffEditor.insertedLineBackground': '#74A17722',
    'diffEditor.removedLineBackground': '#D07D7522'
  }
};
