'use strict';
/**
 * The panel palette: the colour tokens the chrome is painted with (panels,
 * the command centre, settings, dialogs, cards, the terminal and the editor).
 *
 * The committed defaults are the open, MIT-licensed Dracula palette, plus a
 * few ground steps derived from it by plain arithmetic. The expected values
 * below are written out from the published palette, not read from the code,
 * so a value that drifts in the stylesheet cannot carry this test with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const readRaw = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** CSS with comments removed: a comment naming a value is not a declaration. */
const read = (p) => readRaw(p).replace(/\/\*[\s\S]*?\*\//g, '');

// ─── the open palette, restated from its published spec ─────────────────────

const DRACULA = {
  background: '#282A36',
  currentLine: '#44475A',
  foreground: '#F8F8F2',
  comment: '#6272A4',
  cyan: '#8BE9FD',
  green: '#50FA7B',
  orange: '#FFB86C',
  pink: '#FF79C6',
  purple: '#BD93F9',
  red: '#FF5555',
  yellow: '#F1FA8C'
};
const DRACULA_ANSI = {
  black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C',
  blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
  brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94',
  brightYellow: '#FFFFA5', brightBlue: '#D6ACFF', brightMagenta: '#FF92DF',
  brightCyan: '#A4FFFF', brightWhite: '#FFFFFF'
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
/** `a` moved fraction `t` of the way to `b`, per channel. */
const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const darken = (t) => mix(DRACULA.background, '#000000', t);
const tint = (accent) => mix(accent, DRACULA.background, 0.78);

/** Every panel colour token and the value it must default to. */
const EXPECTED = {
  '--cth-cream-50': DRACULA.background,
  '--cth-cream-100': darken(0.12),
  '--cth-cream-200': darken(0.24),
  '--cth-cream-300': darken(0.36),
  '--cth-paper-100': mix(DRACULA.background, DRACULA.currentLine, 0.35),
  '--cth-paper-200': DRACULA_ANSI.black,
  '--cth-ink-900': DRACULA.foreground,
  '--cth-ink-700': mix(DRACULA.foreground, DRACULA.comment, 0.35),
  '--cth-ink-500': mix(DRACULA.foreground, DRACULA.comment, 0.6),
  '--cth-ink-300': mix(DRACULA.comment, DRACULA.foreground, 0.2),
  '--cth-ink-100': DRACULA.currentLine,
  '--cth-coral': DRACULA.red, '--cth-coral-light': tint(DRACULA.red),
  '--cth-mint': DRACULA.green, '--cth-mint-light': tint(DRACULA.green),
  '--cth-sky': DRACULA.cyan, '--cth-sky-light': tint(DRACULA.cyan),
  '--cth-lemon': DRACULA.yellow, '--cth-lemon-light': tint(DRACULA.yellow),
  '--cth-lilac': DRACULA.purple, '--cth-lilac-light': tint(DRACULA.purple),
  '--cth-peach': DRACULA.orange, '--cth-peach-light': tint(DRACULA.orange),
  '--cth-status-idle': mix(DRACULA.comment, DRACULA.foreground, 0.2),
  '--cth-status-thinking': DRACULA.cyan,
  '--cth-status-working': DRACULA.yellow,
  '--cth-status-waiting': DRACULA.purple,
  '--cth-status-blocked': DRACULA.red,
  '--cth-status-success': DRACULA.green,
  '--cth-status-ghost': DRACULA.comment,
  '--cth-status-compacting': DRACULA.pink,
  '--cth-status-looping': DRACULA.orange,
  '--cth-status-typing': DRACULA.yellow,
  '--cth-on-accent': DRACULA.background,
  '--cth-hairline': mix(DRACULA.comment, DRACULA.foreground, 0.2),
  '--cth-gilt': DRACULA.purple,
  '--cth-gilt-soft': DRACULA.currentLine
};

// ─── reading the stylesheets ─────────────────────────────────────────────────

const TOKENS_CSS = 'src/renderer/src/design/tokens.css';
const OCCULT_CSS = 'src/renderer/src/design/occult/occult-tokens.css';

/** The declarations of one block, as a name → raw value map. */
function declarations(css, blockRe) {
  const m = css.match(blockRe);
  assert.ok(m, `block ${blockRe} not found`);
  const out = {};
  for (const d of m[1].matchAll(/(--cth-[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const baseRoot = () => declarations(read(TOKENS_CSS), /:root\s*{([\s\S]*?)\n}/);
const occultRoot = () => declarations(read(OCCULT_CSS), /:root\[data-cth-theme='occult'\]\s*{([\s\S]*?)\n}/);

/** What a token paints with at the document root: the occult block wins over
 *  the base :root, and var() references are followed. */
function resolved() {
  const decl = { ...baseRoot(), ...occultRoot() };
  const resolve = (name, seen = new Set()) => {
    assert.ok(!seen.has(name), `var() cycle at ${name}`);
    seen.add(name);
    const raw = decl[name];
    assert.ok(raw !== undefined, `${name} is not declared`);
    const ref = raw.match(/^var\((--cth-[\w-]+)\)$/);
    return ref ? resolve(ref[1], seen) : raw.toUpperCase();
  };
  return Object.fromEntries(Object.keys(decl).map((n) => [n, resolve(n)]));
}

// ─── contrast ────────────────────────────────────────────────────────────────

const channel = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ─── the defaults ────────────────────────────────────────────────────────────

test('every panel colour token defaults to the open Dracula palette', () => {
  const tokens = resolved();
  const wrong = Object.entries(EXPECTED)
    .filter(([name, want]) => tokens[name] !== want.toUpperCase())
    .map(([name, want]) => `${name}: ${tokens[name]} (expected ${want})`);
  assert.deepEqual(wrong, []);
});

test('the palette is declared in one place, so it can be swapped in one place', () => {
  // A second declaration of the same token would win or lose by specificity,
  // which is how the old theme blocks drifted apart. The occult block keeps
  // the theme's shape (type, radius, borders) and declares no colour token.
  const base = baseRoot();
  const occult = occultRoot();
  for (const name of Object.keys(EXPECTED)) {
    assert.ok(name in base, `${name} is missing from the base :root`);
    assert.equal(name in occult, false, `${name} is declared again in the occult block`);
  }
});

test('the TypeScript mirror carries the same values as the stylesheet', () => {
  const { colors, hex } = loadTs('src/renderer/src/design/tokens.ts');
  const tokens = resolved();
  const pairs = [
    ...Object.entries(colors.cream).map(([w, v]) => [`--cth-cream-${w}`, v]),
    ...Object.entries(colors.paper).map(([w, v]) => [`--cth-paper-${w}`, v]),
    ...Object.entries(colors.ink).map(([w, v]) => [`--cth-ink-${w}`, v]),
    ...Object.entries(colors.accent).map(([k, v]) =>
      [`--cth-${k.replace(/Light$/, '-light')}`, v]),
    ...Object.entries(colors.status).map(([k, v]) => [`--cth-status-${k}`, v])
  ];
  const drift = pairs.filter(([n, v]) => tokens[n] !== hex(v)).map(([n, v]) => `${n}: ts ${hex(v)} css ${tokens[n]}`);
  assert.deepEqual(drift, []);
});

test('the window opens on the palette ground', () => {
  const { APP_GROUND } = loadTs('src/shared/appGround.ts');
  assert.equal(APP_GROUND.toUpperCase(), resolved()['--cth-cream-50']);
  // The boot splash is static HTML painted before any stylesheet loads, so it
  // restates the ground, the text ink and the hint ink.
  const splash = readRaw('src/renderer/index.html').match(/#cth-splash\s*\{[^}]*\}/)[0];
  assert.match(splash, new RegExp(`color:\\s*${resolved()['--cth-ink-900']}\\b`, 'i'));
  const hint = readRaw('src/renderer/index.html').match(/#cth-splash \.hint\s*\{[^}]*\}/)[0];
  assert.match(hint, new RegExp(`color:\\s*${resolved()['--cth-ink-500']}\\b`, 'i'));
});

test('the chrome rules carry no colour from outside the palette', () => {
  // The occult stylesheet also paints the body weave, the I-beam and the
  // Librarian's deepest well with literals. Each must be an open Dracula
  // colour or one of its derived ground steps. The release-drop family is the
  // landing site's window and is held to that site's values elsewhere.
  const allowed = new Set([
    ...Object.values(DRACULA), ...Object.values(DRACULA_ANSI),
    ...Object.values(EXPECTED).filter((v) => v.startsWith('#')), darken(0.48), '#000000'
  ].map((v) => v.toUpperCase()));
  const css = read(OCCULT_CSS).replace(/--cth-drop-[\w-]+\s*:[^;]+;/g, '');
  const found = [
    ...[...css.matchAll(/(?:#|%23)([0-9A-Fa-f]{6})\b/g)].map((m) => `#${m[1]}`),
    ...[...css.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)].map((m) => toHex(m.slice(1, 4).map(Number)))
  ].map((v) => v.toUpperCase());
  assert.ok(found.length > 0, 'found no colour literals at all; the scan is broken');
  assert.deepEqual(found.filter((v) => !allowed.has(v)), []);
});

test('the defaults keep the contrast floors', () => {
  // Body text >= 4.5:1 and the structural border (ink-300, and the hairline
  // that panel edges use) >= 3:1, on every surface either can sit on.
  const t = resolved();
  const surfaces = ['--cth-cream-50', '--cth-cream-100', '--cth-cream-200', '--cth-cream-300',
    '--cth-paper-100', '--cth-paper-200'];
  const misses = [];
  const floor = (fg, bg, min) => {
    const r = contrast(t[fg] ?? fg, t[bg] ?? bg);
    if (r < min) misses.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
  };
  for (const s of surfaces) {
    for (const ink of ['--cth-ink-900', '--cth-ink-700', '--cth-ink-500']) floor(ink, s, 4.5);
    for (const line of ['--cth-ink-300', '--cth-hairline']) floor(line, s, 3);
  }
  for (const a of ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach']) {
    floor('--cth-on-accent', `--cth-${a}`, 4.5);   // text on an accent fill
    floor('--cth-ink-900', `--cth-${a}-light`, 4.5); // text on a chip
  }
  floor('--cth-ink-900', '--cth-gilt-soft', 4.5);   // selected text
  floor('--cth-status-ghost', '--cth-cream-50', 3); // the quietest mark, still findable
  assert.deepEqual(misses, []);
});

test('the terminal and editor take the open ANSI set', () => {
  const { occultTerminalTheme: term, occultMonacoTheme: editor } =
    loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  // `white` is the one deliberate exception: the published set makes it the
  // foreground, and plain output would then be indistinguishable from it. It
  // takes the secondary ink instead (see occult-terminal.test.cjs).
  const off = Object.entries(DRACULA_ANSI)
    .filter(([slot]) => slot !== 'white')
    .filter(([slot, want]) => term[slot].toUpperCase() !== want)
    .map(([slot, want]) => `${slot}: ${term[slot]} (expected ${want})`);
  assert.deepEqual(off, []);
  assert.equal(term.white.toUpperCase(), resolved()['--cth-ink-500']);
  assert.equal(term.selectionBackground.toUpperCase(), DRACULA.currentLine);
  assert.equal(term.cursor.toUpperCase(), DRACULA.foreground);
  const rule = (token) => `#${editor.rules.find((r) => r.token === token).foreground}`.toUpperCase();
  assert.equal(rule('comment'), DRACULA.comment);
  assert.equal(rule('keyword'), DRACULA.pink);
  assert.equal(rule('string'), DRACULA.yellow);
  assert.equal(rule('function'), DRACULA.green);
  assert.equal(editor.colors['editor.selectionBackground'].toUpperCase(), DRACULA.currentLine);
});

test('the UA draws its controls for a dark ground', () => {
  // Without `color-scheme: dark`, Chromium paints scrollbars, native selects
  // and date pickers for a light page: pale slabs on the dark chrome.
  const css = read('src/renderer/src/design/global.css');
  assert.match(css, /:root\s*{\s*color-scheme:\s*dark;\s*}/);
  // The caret follows the ink rather than the UA scheme either way.
  assert.match(css, /input, textarea\s*{\s*caret-color:\s*var\(--cth-ink-900\);\s*}/);
});
