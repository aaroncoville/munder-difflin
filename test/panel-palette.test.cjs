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

// ─── the local override: <userData>/panel-palette.json ───────────────────────

const os = require('node:os');

const SHARED = 'src/shared/panelPalette.ts';
const MAIN = 'src/main/panelPalette.ts';
const RENDERER = 'src/renderer/src/design/panelPalette.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-panel-palette-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let fileSeq = 0;
/** A palette file holding exactly `body`, at a fresh path. */
function paletteFile(body) {
  const file = path.join(tmp, `p${++fileSeq}`, 'panel-palette.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}
/** Read a palette file, capturing every warning instead of printing it. */
function readWith(file) {
  const { readPanelPalette } = loadTs(MAIN);
  const warnings = [];
  const palette = readPanelPalette(file, { warn: (...a) => warnings.push(a.join(' ')) });
  return { palette, warnings };
}

test('the overridable tokens are exactly the panel palette', () => {
  const { PANEL_PALETTE_TOKENS, PANEL_PALETTE_FILE } = loadTs(SHARED);
  assert.deepEqual([...PANEL_PALETTE_TOKENS].sort(), Object.keys(EXPECTED).sort());
  assert.equal(PANEL_PALETTE_FILE, 'panel-palette.json');
});

test('a valid file applies, in every accepted colour form', () => {
  const body = {
    '--cth-cream-50': '#123',
    '--cth-ink-900': '#AbCdEf',
    '--cth-gilt': '#11223380',
    '--cth-coral': 'rgb(255, 0, 12)',
    '--cth-coral-light': 'rgba(1,2,3,0.5)',
    '--cth-mint': 'rgba(0, 0, 0, 1)'
  };
  const { palette, warnings } = readWith(paletteFile(body));
  assert.deepEqual(palette, body);
  assert.deepEqual(warnings, []);
});

test('an unknown token name is ignored, and the rest still applies', () => {
  // `--cth-space-4` is a real token but not a colour one, and the unprefixed
  // name is not the accepted form. Written as text: an object literal would
  // treat `__proto__` as the prototype, where JSON.parse makes it a key.
  const { palette, warnings } = readWith(paletteFile(`{
    "--cth-cream-50": "#282A36",
    "--cth-space-4": "#000000",
    "cth-ink-900": "#FFFFFF",
    "--cth-nonsense": "#FFFFFF",
    "__proto__": "#FFFFFF"
  }`));
  assert.deepEqual(palette, { '--cth-cream-50': '#282A36' });
  assert.equal(Object.getPrototypeOf(palette), Object.prototype);
  assert.deepEqual(warnings, []);
});

test('one invalid value refuses the whole file, with one warning', () => {
  for (const bad of [
    'red; background:url(x)', 'var(--x)', '#12345', 12, { a: '#fff' }, ['#fff'], null, true,
    'red', 'url(x)', 'expression(alert(1))', '#fff;', '#fff}', ' #fff', '#ffff ',
    'rgb(256, 0, 0)', 'rgb(1, 2)', 'rgba(1, 2, 3)', 'rgb(1, 2, 3, 0.5)', 'rgba(1, 2, 3, 2)',
    'rgb(1, 2, 3) url(x)', 'rgb(1,2,3);x', '#GGGGGG', ''
  ]) {
    const { palette, warnings } = readWith(paletteFile({
      '--cth-cream-50': '#282A36',
      '--cth-ink-900': bad
    }));
    assert.deepEqual(palette, {}, `accepted a file holding ${JSON.stringify(bad)}`);
    assert.equal(warnings.length, 1, `${JSON.stringify(bad)}: ${warnings.length} warnings`);
  }
});

test('a file that is not a flat object refuses, with one warning', () => {
  for (const body of ['[]', 'null', '"#fff"', '42', 'true']) {
    const { palette, warnings } = readWith(paletteFile(body));
    assert.deepEqual(palette, {}, body);
    assert.equal(warnings.length, 1, body);
  }
});

test('bad JSON, a missing file and a directory each give the defaults, never a throw', () => {
  const bad = readWith(paletteFile('{"--cth-cream-50": "#282A36",'));
  assert.deepEqual(bad.palette, {});
  assert.equal(bad.warnings.length, 1);

  const missing = readWith(path.join(tmp, 'nowhere', 'panel-palette.json'));
  assert.deepEqual(missing.palette, {});
  assert.deepEqual(missing.warnings, [], 'no file is the normal case, not a warning');

  const dir = path.join(tmp, 'dir-case', 'panel-palette.json');
  fs.mkdirSync(dir, { recursive: true });
  const isDir = readWith(dir);
  assert.deepEqual(isDir.palette, {});
  assert.equal(isDir.warnings.length, 1);
});

test('the file is read once, however often the palette is asked for', () => {
  const { panelPaletteSource } = loadTs(MAIN);
  let reads = 0;
  const file = paletteFile({ '--cth-cream-50': '#000000' });
  const get = panelPaletteSource(() => file, {
    read: (p) => { reads++; return fs.readFileSync(p, 'utf8'); },
    warn: () => {}
  });
  assert.equal(reads, 0, 'read before anyone asked');
  const first = get();
  fs.writeFileSync(file, JSON.stringify({ '--cth-cream-50': '#FFFFFF' }));
  assert.deepEqual(get(), first);
  get();
  assert.equal(reads, 1);
  assert.deepEqual(first, { '--cth-cream-50': '#000000' });
});

/** Source with comments removed — naming an API must not read as calling it. */
const code = (p) => readRaw(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('main only ever parses the file as JSON', () => {
  const src = code(MAIN);
  assert.match(src, /JSON\.parse\(/);
  for (const banned of [/\brequire\s*\(/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bimport\s*\(/,
    /child_process/, /\bvm\b/]) {
    assert.doesNotMatch(src, banned, `${MAIN} uses ${banned}`);
  }
});

test('main serves the palette from <userData>, through the read-once source', () => {
  const src = code('src/main/index.ts');
  const source = src.match(/const (\w+) = panelPaletteSource\(\s*\(\) => join\(app\.getPath\('userData'\), PANEL_PALETTE_FILE\)\s*\)/);
  assert.ok(source, 'main does not build the palette source over <userData>/panel-palette.json');
  assert.match(src, new RegExp(
    `ipcMain\\.on\\('panel-palette:readSync', \\(evt\\) => \\{ evt\\.returnValue = ${source[1]}\\(\\); \\}\\)`));
  const preload = code('src/preload/index.ts');
  assert.match(preload, /panelPaletteSync:[\s\S]{0,200}ipcRenderer\.sendSync\('panel-palette:readSync'\)/);
});

// ─── the renderer ────────────────────────────────────────────────────────────

/** A fresh renderer palette module over a fake <html>. */
function freshRenderer() {
  const set = [];
  const root = { style: { setProperty: (n, v) => set.push([n, v]) } };
  global.document = { documentElement: root };
  return { mod: loadTs.fresh(RENDERER), set };
}

test('the renderer applies a palette as inline properties on <html>', () => {
  const { mod, set } = freshRenderer();
  mod.applyPanelPalette({ '--cth-cream-50': '#101010', '--cth-ink-900': 'rgb(1, 2, 3)' });
  assert.deepEqual(set, [['--cth-cream-50', '#101010'], ['--cth-ink-900', 'rgb(1, 2, 3)']]);
});

test('the renderer checks again what it is handed, and applies nothing it doubts', () => {
  // The preload bridge is the boundary main trusts least to stay narrow, so
  // the value is validated on both sides of it.
  const { mod, set } = freshRenderer();
  const warn = console.warn;
  console.warn = () => {};
  try {
    mod.applyPanelPalette({ '--cth-cream-50': '#101010', '--cth-ink-900': 'red;}body{x:url(y)' });
    mod.applyPanelPalette(undefined);
    mod.applyPanelPalette('nonsense');
  } finally { console.warn = warn; }
  assert.deepEqual(set, []);
});

test('the terminal and editor grounds follow the override', () => {
  const { mod } = freshRenderer();
  const { occultTerminalTheme, occultMonacoTheme } =
    loadTs('src/renderer/src/design/occult/occultTerminal.ts');
  // Nothing applied: the defaults, untouched.
  assert.deepEqual(mod.paletteTerminalTheme(occultTerminalTheme), occultTerminalTheme);
  mod.applyPanelPalette({ '--cth-cream-300': '#101010', '--cth-ink-900': '#EEEEEE' });
  const term = mod.paletteTerminalTheme(occultTerminalTheme);
  assert.equal(term.background, '#101010');
  assert.equal(term.cursorAccent, '#101010');
  assert.equal(term.foreground, '#EEEEEE');
  assert.equal(term.red, occultTerminalTheme.red, 'the ANSI slots are not overridable');
  const editor = mod.paletteMonacoTheme(occultMonacoTheme);
  assert.equal(editor.colors['editor.background'], '#101010');
  assert.equal(editor.colors['editor.foreground'], '#EEEEEE');
  assert.equal(editor.rules.find((r) => r.token === '').foreground, 'EEEEEE');
  assert.equal(editor.rules.find((r) => r.token === '').background, '101010');
  assert.equal(occultMonacoTheme.colors['editor.background'], '#1A1B23', 'the default theme was mutated');
});

test('the renderer applies the palette before the first render', () => {
  const src = code('src/renderer/src/main.tsx');
  const applied = src.search(/applyPanelPalette\(window\.cth\?\.panelPaletteSync\?\.\(\)\)/);
  assert.ok(applied >= 0, 'main.tsx never applies the palette');
  assert.ok(applied < src.search(/createRoot\(/), 'the palette is applied after the first render');
  // The live terminal and editor read the palette when they are built, not
  // when their module loads: module load runs before main.tsx's body does.
  assert.match(code('src/renderer/src/components/PtyTerminalView.tsx'), /paletteTerminalTheme\(occultTerminalTheme\)/);
  assert.match(code('src/renderer/src/ide/monaco.ts'), /defineTheme\(OCCULT_MONACO_THEME, paletteMonacoTheme\(occultMonacoTheme\)\)/);
});

test('the documentation lists exactly the tokens the file may set', () => {
  const { PANEL_PALETTE_TOKENS } = loadTs(SHARED);
  const doc = readRaw('docs/panel-palette.md');
  const list = doc.match(/### Tokens you can set[\s\S]*?```\n([\s\S]*?)```/);
  assert.ok(list, 'the token list is missing from docs/panel-palette.md');
  assert.deepEqual(list[1].split(/\s+/).filter(Boolean).sort(), [...PANEL_PALETTE_TOKENS].sort());
  // …and its example is a file the validator accepts.
  const example = doc.match(/### Format[\s\S]*?```json\n([\s\S]*?)```/);
  const { checkPanelPalette } = loadTs(SHARED);
  const check = checkPanelPalette(JSON.parse(example[1]));
  assert.equal(check.ok, true);
  assert.equal(Object.keys(check.palette).length, Object.keys(JSON.parse(example[1])).length);
});
