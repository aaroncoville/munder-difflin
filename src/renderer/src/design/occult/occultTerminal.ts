/**
 * The Study's terminal and editor, lit by the same candle as everything else.
 *
 * Two palettes, one register — and the register is the theme's NIGHT one: the
 * ink-blue the frame and its title bar are cut from, with parchment ink and
 * candleflame gold where the light and dark palettes reach for a cool blue.
 * The terminal sat on parchment until it was seen at full height, where it is
 * the largest single field of colour on screen: a coffee-brown pane inside an
 * indigo frame read as two applications rather than two panels, and the two tan
 * inks on it were separated by weight alone, which is not enough separation to
 * scan. So the ground moved onto the night, the primary ink stayed warm, and
 * the secondary ink went cool — the eye now tells them apart by hue before it
 * measures the weight. Nothing here fluoresces; a colour that glows on a night
 * ground reads as a different medium from the painted rooms around it, which is
 * exactly the seam the theme exists to remove.
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
 * between the eight that a program colouring its output stays readable. Every
 * normal slot clears 4.7:1 on the ground and every bright clears 6.2:1; the two
 * that carry text — the foreground and the `white` a program prints plain
 * output in — sit at 11.7:1 and 6.1:1, a ratio of 1.9 between them.
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
  background: '#2B2444',        // = --cth-terminal-ground, the night the frame is cut from
  foreground: '#EDE6D2',        // = --cth-terminal-ink — parchment, 11.7:1
  cursor: '#C9A227',            // = --cth-gilt — a candleflame, not a block of light
  cursorAccent: '#2B2444',
  selectionBackground: '#514529',  // gilt held down low; the ink stays at 7.6:1 on it
  selectionForeground: '#EDE6D2',

  black:        '#211B36',   // one step under the ground, so a program painting
                             //   an ANSI-black cell deepens the night rather than
                             //   punching a hole of a different colour in it
  red:          '#D07D75',   // Grail crimson, lifted off the indigo — 4.8:1
  green:        '#74A177',   // verdigris — 4.9:1
  yellow:       '#C9A227',   // = --cth-gilt — candlelight, 6.0:1
  blue:         '#8494D2',   // periwinkle, the register --cth-status-waiting uses.
                             //   The old lilac sat in the GROUND's own hue and went
                             //   muddy the moment the ground became violet
  magenta:      '#B886B4',   // lifted clear of both the blue and the ground — 4.9:1
  cyan:         '#55A2A0',   // the muted teal, one step up for the night — 4.9:1
  white:        '#ADA3BE',   // moonlight: the SECONDARY ink, cool where the
                             //   foreground is warm, 6.1:1 on the ground and 1.9
                             //   under the foreground
  brightBlack:  '#968FB9',   // dim text, at the weight of a rule beside it — 4.8:1
  brightRed:    '#E29A92',
  brightGreen:  '#8CB98F',
  brightYellow: '#E3C263',
  brightBlue:   '#9CAAE0',
  brightMagenta:'#C79CC3',
  brightCyan:   '#6FB8B5',
  brightWhite:  '#EDE6D2'    // = --cth-terminal-ink
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
    { token: '', foreground: 'EDE6D2', background: '2B2444' },
    { token: 'comment', foreground: '968FB9', fontStyle: 'italic' },
    { token: 'keyword', foreground: '9CAAE0' },
    { token: 'string', foreground: '8CB98F' },
    { token: 'number', foreground: 'E29A92' },
    { token: 'type', foreground: '6FB8B5' },
    { token: 'function', foreground: 'E3C263' },
    { token: 'variable', foreground: 'EDE6D2' },
    { token: 'delimiter', foreground: 'ADA3BE' }
  ],
  colors: {
    'editor.background': '#2B2444',
    'editor.foreground': '#EDE6D2',
    'editorLineNumber.foreground': '#8A7440',        // = --cth-hairline, gilt leaf
                                                     //   at 3.2:1 — quiet, findable
    'editorLineNumber.activeForeground': '#C9A227',  // = --cth-gilt
    'editor.selectionBackground': '#514529',
    'editor.lineHighlightBackground': '#332B50',
    'editorCursor.foreground': '#C9A227',
    'editorGutter.background': '#211B36',
    'editorWidget.background': '#211B36',
    'editorIndentGuide.background1': '#443A66',
    'diffEditor.insertedTextBackground': '#74A17733',
    'diffEditor.removedTextBackground': '#D07D7533',
    'diffEditor.insertedLineBackground': '#74A17722',
    'diffEditor.removedLineBackground': '#D07D7522'
  }
};
