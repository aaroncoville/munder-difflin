'use strict';
/**
 * The candlelit terminal and editor.
 *
 * The load-bearing assertion in this file is the FIRST one, and it is a
 * negative: `terminalThemeFor` must keep answering 'dark' for the occult
 * theme. It feeds two things that cannot be told about a third theme —
 * DEC mode 2031, whose reply has exactly two values, and a persisted config
 * field the main process types and validates as 'light' | 'dark' and spawned
 * agents read to theme their own TUI. The candlelight therefore lives in a
 * SEPARATE selector that only our own xterm instances read. Collapsing the two
 * back into one function is the regression this test exists to catch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const at = (p) => path.resolve(__dirname, '..', p);
const read = (p) => fs.readFileSync(at(p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'];

test('what an external program is told stays a two-value answer', () => {
  const theme = loadTs('src/renderer/src/design/theme.ts');
  // DEC 2031 replies `CSI ? 997 ; 1 n` (dark) or `; 2 n` (light). There is no
  // third reply, and main/config.ts types terminalTheme as exactly this pair.
  assert.equal(theme.terminalThemeFor('occult'), 'dark');
  assert.equal(theme.terminalThemeFor('dark'), 'dark');
  assert.equal(theme.terminalThemeFor('light'), 'light');
  assert.equal(strip(read('src/main/realtimeActions.ts'))
    .match(/terminalTheme:\s*{[^}]*values:\s*\[([^\]]*)\]/)[1].replace(/['"\s]/g, ''),
  'light,dark', 'the config schema grew a value it cannot have grown');
});

test('our own terminals get a third palette, and it is the occult one', () => {
  const { terminalPaletteFor } = loadTs('src/renderer/src/design/theme.ts');
  assert.equal(terminalPaletteFor('occult'), 'occult');
  assert.equal(terminalPaletteFor('dark'), 'dark');
  assert.equal(terminalPaletteFor('light'), 'light');
});

test('the candlelit palette is complete — every ANSI slot and the ground', () => {
  const { occultTerminalTheme } = loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  for (const slot of [...ANSI, 'background', 'foreground', 'cursor', 'cursorAccent',
    'selectionBackground', 'selectionForeground']) {
    assert.match(String(occultTerminalTheme[slot] ?? ''), /^#[0-9A-Fa-f]{6}$/,
      `${slot} is not a colour`);
  }
  // Sixteen DISTINCT-ish slots: a palette that repeats one hex across the
  // colour names is a palette where half of ANSI is invisible.
  assert.ok(new Set(ANSI.map((s) => occultTerminalTheme[s].toUpperCase())).size >= 12,
    'too many ANSI slots share a colour to be legible');
});

test('the terminal sits on the same ground the panel holding it does', () => {
  // xterm takes literal colours and cannot read a CSS custom property, so this
  // hex is RE-STATED from occult-tokens.css and would drift silently the first
  // time the palette moved. Holding the two against each other is the whole
  // reason this assertion reads the stylesheet rather than a second constant.
  const { occultTerminalTheme } = loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  const css = read('src/renderer/src/design/occult/occult-tokens.css')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const paper = css.match(/--cth-paper-100:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(occultTerminalTheme.background.toUpperCase(), paper.toUpperCase(),
    'the terminal ground drifted from --cth-paper-100');
  const ink = css.match(/--cth-ink-900:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(occultTerminalTheme.foreground.toUpperCase(), ink.toUpperCase(),
    'the terminal ink drifted from --cth-ink-900');
});

test('the live terminal can actually reach the third palette', () => {
  // A palette nothing selects is the "written and never read" defect: correct,
  // tested, and invisible in the running app.
  //
  // PtyTerminalView is the only terminal the app mounts. components/TerminalView.tsx
  // holds a second, older copy of the light palette and has no importer anywhere
  // in src/ — it is deliberately left alone rather than themed, because editing
  // a file nothing renders is a diff a reviewer has to read for no change a user
  // can see. This assertion is what would catch it becoming live again unthemed.
  const src = strip(read('src/renderer/src/components/PtyTerminalView.tsx'));
  assert.match(src, /terminalPaletteFor/, 'still picks by terminalThemeFor');
  assert.match(src, /occult:\s*occultTerminalTheme/, 'no occult entry in the palette map');
  const dead = read('src/renderer/src/components/TerminalView.tsx');
  assert.doesNotMatch(dead, /terminalPaletteFor/,
    'TerminalView was themed — if it now has an importer, theme it properly; if not, revert');
});

test('the editor has a candlelit theme, and light and dark keep the one they had', () => {
  const { monacoThemeFor } = loadTs('src/renderer/src/ide/monacoTheme.ts');
  const { OCCULT_MONACO_THEME, occultMonacoTheme, occultTerminalTheme } =
    loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  assert.equal(monacoThemeFor('occult'), 'cth-occult');
  assert.equal(OCCULT_MONACO_THEME, 'cth-occult');
  // A theme id that is selected but never registered leaves Monaco on its
  // built-in default — the failure looks like "the editor ignored the theme",
  // so the id the selector returns and the id monaco.ts registers are held
  // against each other rather than both spelled out as literals.
  const src = strip(read('src/renderer/src/ide/monaco.ts'));
  assert.match(src, /defineTheme\(\s*(OCCULT_MONACO_THEME|'cth-occult')/,
    'the candlelit editor theme is never registered');
  assert.equal(occultMonacoTheme.colors['editor.background'].toUpperCase(),
    occultTerminalTheme.background.toUpperCase(),
    'the editor sits on a different ground from the terminal beside it');
  // Unchanged, deliberately: the editor has only ever registered cth-light, and
  // dark has always rendered with it. Giving dark an editor theme here would be
  // a visible change to dark, which this milestone is not allowed to make.
  assert.equal(monacoThemeFor('light'), 'cth-light');
  assert.equal(monacoThemeFor('dark'), 'cth-light');
  for (const p of ['src/renderer/src/ide/MonacoEditor.tsx', 'src/renderer/src/ide/MonacoDiff.tsx']) {
    assert.match(strip(read(p)), /monacoThemeFor/, `${p} still pins one theme`);
  }
});

test('the candlelit ground is a different colour from the dark one, not a different black', () => {
  // The reported symptom was "the terminal looks the same black as before" after
  // switching to the occult theme, and the palette WAS reaching xterm — the
  // ground was simply cloned from a surface token that sat 1.11:1 away from the
  // dark terminal's, which is below what an eye resolves. So the property worth
  // asserting is not "occult has a background" (it always did) but "the two
  // grounds are far enough apart to be seen as different".
  //
  // The dark ground is READ OUT OF the view that paints it rather than restated
  // here: a constant shared with the implementation is a constant that cannot
  // catch the implementation moving.
  const { occultTerminalTheme } = loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  const dark = read('src/renderer/src/components/PtyTerminalView.tsx')
    .match(/const darkTheme = {\s*background:\s*'(#[0-9A-Fa-f]{6})'/)[1];

  const channel = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = (hex) => {
    const [r, g, b] = rgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  assert.ok(contrast(occultTerminalTheme.background, dark) >= 1.15,
    `the candlelit ground is ${contrast(occultTerminalTheme.background, dark).toFixed(3)}:1 `
    + `from the dark one (${dark}) — switching theme changes nothing a user can see`);

  // Warm, specifically: the brief is candlelight on parchment, and a ground that
  // is merely a lighter blue-violet reads as the same night surface lit harder.
  const [r, , b] = rgb(occultTerminalTheme.background);
  assert.ok(r > b, 'the candlelit ground is cooler than it is warm');
});
