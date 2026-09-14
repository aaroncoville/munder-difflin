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
  //
  // The pin moved OFF --cth-paper-100 when the terminal moved off the parchment
  // surface onto the theme's night register: the panel and the canvas still have
  // to agree, but the token they agree ON is now the terminal's own, which the
  // panel reads too. Pinning the old one would have asserted the seam back.
  const { occultTerminalTheme } = loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  const css = read('src/renderer/src/design/occult/occult-tokens.css')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ground = css.match(/--cth-terminal-ground:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(occultTerminalTheme.background.toUpperCase(), ground.toUpperCase(),
    'the terminal ground drifted from --cth-terminal-ground');
  const ink = css.match(/--cth-terminal-ink:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(occultTerminalTheme.foreground.toUpperCase(), ink.toUpperCase(),
    'the terminal ink drifted from --cth-terminal-ink');
  // …and the panel around the canvas reads the same token, or the 8px frame and
  // the header row go back to being a different colour from the terminal inside
  // them — the reported symptom, in the one place a palette file cannot fix it.
  const view = strip(read('src/renderer/src/components/PtyTerminalView.tsx'));
  assert.match(view, /background:\s*'var\(--cth-terminal-ground\)'/,
    'the terminal panel is back on the shared panel surface');
  assert.doesNotMatch(view, /background:\s*'var\(--cth-paper-100\)'/,
    'something in the terminal panel still paints itself with the shared surface');
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

  // INDIGO, specifically. This assertion used to read `r > b` and demanded the
  // opposite: the terminal was parchment then, and a blue-violet ground was the
  // thing to keep out. Seen at full height that inverted — the brown pane was
  // the largest field of colour on screen and sat inside an indigo frame, so the
  // theme's night register is now what the terminal belongs to, and a ground
  // drifting back toward the warm ramp is the regression worth catching.
  const [r, , b] = rgb(occultTerminalTheme.background);
  assert.ok(b > r, 'the terminal ground drifted off the night register back toward parchment');

  // The reported defect was not only the hue: the two inks were two shades of
  // the same tan, told apart by weight alone. Both floors, and the gap.
  assert.ok(contrast(occultTerminalTheme.foreground, occultTerminalTheme.background) >= 4.5,
    `primary terminal ink is ${contrast(occultTerminalTheme.foreground, occultTerminalTheme.background).toFixed(2)}:1`);
  assert.ok(contrast(occultTerminalTheme.white, occultTerminalTheme.background) >= 4.5,
    `secondary terminal ink is ${contrast(occultTerminalTheme.white, occultTerminalTheme.background).toFixed(2)}:1`);
  assert.ok(contrast(occultTerminalTheme.foreground, occultTerminalTheme.white) >= 1.6,
    `primary and secondary ink are ${contrast(occultTerminalTheme.foreground, occultTerminalTheme.white).toFixed(2)}:1 `
    + 'apart — close enough to read as one colour, which is the defect this palette was retuned for');

  // Every ANSI slot a program can print text in has to clear 4.5:1 on the new
  // ground. `black` is excluded because it is a FILL, not an ink — it is the
  // ground one step deeper, and holding it to a text ratio would forbid that.
  for (const slot of ANSI.filter((s) => s !== 'black')) {
    const ratio = contrast(occultTerminalTheme[slot], occultTerminalTheme.background);
    assert.ok(ratio >= 4.5, `ANSI ${slot} is ${ratio.toFixed(2)}:1 on the ground`);
  }

  // The editor beside it is the same document in the same light, so it takes the
  // same two inks rather than a second pair that can drift from them.
  const { occultMonacoTheme } = loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  assert.equal(`#${occultMonacoTheme.rules.find((r0) => r0.token === '').foreground}`.toUpperCase(),
    occultTerminalTheme.foreground.toUpperCase(),
    'the editor default ink drifted from the terminal it sits beside');
  assert.equal(occultMonacoTheme.colors['editor.foreground'].toUpperCase(),
    occultTerminalTheme.foreground.toUpperCase());
});
