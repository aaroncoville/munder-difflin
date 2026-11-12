/**
 * The terminal and editor palettes, from the same panel palette as the chrome.
 *
 * They follow the open Dracula palette: the panel palette's deepest ground and
 * its foreground, Dracula's selection colour, and the sixteen ANSI slots of the
 * published Dracula terminal spec — with one exception, `white`, explained at
 * the slot.
 *
 * Both are RE-STATED literals rather than references to `--cth-*`: xterm takes
 * literal colours and Monaco takes literal colours, and neither can read a CSS
 * custom property. That makes drift the standing risk, so every value that MUST
 * equal a token names it in a comment, and the two that carry the surface — the
 * ground and the ink — are held against the stylesheet by a test, which fails
 * the moment either side moves alone. A user's panel-palette.json reaches those
 * two at run time (design/panelPalette.ts); the ANSI slots are not overridable.
 *
 * On the ground every slot a program prints text in clears 4.5:1, and
 * `brightBlack`, the dim/comment colour, clears the 3:1 structural floor.
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
  background: '#1A1B23',        // = --cth-cream-300, the deepest ground
  foreground: '#F8F8F2',        // = --cth-ink-900, Dracula foreground
  cursor: '#F8F8F2',            // Dracula's cursor is the foreground
  cursorAccent: '#1A1B23',
  selectionBackground: '#44475A',  // = --cth-gilt-soft, Dracula selection
  selectionForeground: '#F8F8F2',

  black:        '#21222C',
  red:          '#FF5555',
  green:        '#50FA7B',
  yellow:       '#F1FA8C',
  blue:         '#BD93F9',
  magenta:      '#FF79C6',
  cyan:         '#8BE9FD',
  white:        '#9EA8C3',   // = --cth-ink-500. The published set makes white the
                             //   foreground, so a program printing plain output in
                             //   white would be indistinguishable from the prompt's
                             //   own ink. This keeps the two inks 2.2:1 apart.
  brightBlack:  '#6272A4',   // Dracula comment
  brightRed:    '#FF6E6E',
  brightGreen:  '#69FF94',
  brightYellow: '#FFFFA5',
  brightBlue:   '#D6ACFF',
  brightMagenta:'#FF92DF',
  brightCyan:   '#A4FFFF',
  brightWhite:  '#FFFFFF'
};

/** The id `monaco.editor.defineTheme` registers the candlelit editor under. */
export const OCCULT_MONACO_THEME = 'cth-occult';

/**
 * The editor, in the same palette as the terminal.
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
    { token: '', foreground: 'F8F8F2', background: '1A1B23' },
    { token: 'comment', foreground: '6272A4', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'FF79C6' },
    { token: 'string', foreground: 'F1FA8C' },
    { token: 'number', foreground: 'BD93F9' },
    { token: 'type', foreground: '8BE9FD', fontStyle: 'italic' },
    { token: 'function', foreground: '50FA7B' },
    { token: 'variable', foreground: 'F8F8F2' },
    { token: 'delimiter', foreground: 'F8F8F2' }
  ],
  colors: {
    'editor.background': '#1A1B23',                  // = --cth-cream-300
    'editor.foreground': '#F8F8F2',                  // = --cth-ink-900
    'editorLineNumber.foreground': '#6272A4',        // Dracula comment, 3.6:1 — quiet, findable
    'editorLineNumber.activeForeground': '#F8F8F2',
    'editor.selectionBackground': '#44475A',         // = --cth-gilt-soft
    'editor.lineHighlightBackground': '#282A36',     // = --cth-cream-50, one step up
    'editorCursor.foreground': '#F8F8F2',
    'editorGutter.background': '#1A1B23',
    'editorWidget.background': '#21222C',            // = --cth-paper-200
    'editorIndentGuide.background1': '#44475A',      // = --cth-ink-100
    'diffEditor.insertedTextBackground': '#50FA7B33',
    'diffEditor.removedTextBackground': '#FF555533',
    'diffEditor.insertedLineBackground': '#50FA7B22',
    'diffEditor.removedLineBackground': '#FF555522'
  }
};
