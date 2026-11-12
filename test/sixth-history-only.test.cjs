'use strict';
/**
 * Sixth History is the app's only theme.
 *
 * Light and dark, and the controls that cycled between them, are gone. What
 * has to hold afterwards:
 *
 * - a reader who saved light or dark lands on Sixth History, and the stale
 *   choice is not left behind in storage for anything to misread later;
 * - nothing in the renderer still asks which theme it is in;
 * - the Study is the floor, and when it cannot draw it says so in its own
 *   panel rather than falling back to the pixel office;
 * - config keys that only existed for the removed themes stop riding along
 *   into the renderer and back to disk.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sixth-only-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, ipcMain: { handle() {}, on() {} } }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const React = require('react');
React.Suspense = React.Suspense ?? Symbol.for('react.suspense');
React.lazy = (loader) => ({ $$typeof: Symbol.for('react.lazy'), loader });
React.Component = class Component {
  constructor(props) { this.props = props; }
};

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with comments removed — naming an API must not read as calling it. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const THEME = 'src/renderer/src/design/theme.ts';
const HOST = 'src/renderer/src/scene/study/FloorHost.tsx';

/** A fresh theme module over a fake DOM whose storage starts as `stored`. */
function freshTheme(stored) {
  const store = new Map(Object.entries(stored));
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
  };
  global.document = { documentElement: { dataset: {} } };
  return { mod: loadTs.fresh(THEME), store };
}

// ─── the theme module ────────────────────────────────────────────────────────

test('the theme module offers no way to be anything but Sixth History', () => {
  const { mod } = freshTheme({});
  for (const gone of ['toggleAppTheme', 'setAppTheme', 'themeControlFace',
    'terminalThemeFor', 'terminalPaletteFor', 'useAppTheme']) {
    assert.equal(gone in mod, false, `theme.ts still exports ${gone}`);
  }
  assert.equal(mod.APP_THEME, 'occult');
});

test('a saved light or dark choice lands on Sixth History', () => {
  for (const stored of [
    { 'cth.theme': 'light' },
    { 'cth.theme': 'dark' },
    { 'cth.ptyTheme': 'light' },
    { 'cth.ptyTheme': 'dark', 'cth.theme': 'light' }
  ]) {
    const { mod, store } = freshTheme(stored);
    mod.applyAppTheme();
    const label = JSON.stringify(stored);
    assert.equal(global.document.documentElement.dataset.cthTheme, 'occult', label);
    // Nothing reads the stored choice any more, so it is cleared rather than
    // rewritten: a value nobody reads is a value that can only mislead.
    assert.equal(store.has('cth.theme'), false, `${label}: cth.theme left behind`);
    assert.equal(store.has('cth.ptyTheme'), false, `${label}: cth.ptyTheme left behind`);
  }
});

test('the stamp survives storage that will not open', () => {
  global.window = { get localStorage() { throw new Error('denied'); } };
  global.document = { documentElement: { dataset: {} } };
  const mod = loadTs.fresh(THEME);
  mod.applyAppTheme();
  assert.equal(global.document.documentElement.dataset.cthTheme, 'occult');
});

test('the renderer entry point applies the theme before the app renders', () => {
  const src = strip(read('src/renderer/src/main.tsx'));
  const applied = src.search(/applyAppTheme\(\)/);
  assert.ok(applied >= 0, 'main.tsx never applies the theme');
  assert.ok(applied < src.search(/createRoot\(/), 'the theme is applied after the first render');
});

test('nothing in the renderer still asks which theme it is in', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const src = strip(fs.readFileSync(full, 'utf8'));
      if (/\b(useAppTheme|toggleAppTheme|themeControlFace|terminalThemeFor|terminalPaletteFor|monacoThemeFor|notifyThemeChangeAll)\b/.test(src)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src/renderer/src'));
  assert.deepEqual(offenders, []);
});

test('no locale carries the wording of the removed theme controls', () => {
  const dir = path.join(ROOT, 'src/renderer/src/i18n/locales');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const ft = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).fullscreenTerminal ?? {};
    for (const key of ['lightTheme', 'darkTheme', 'occultTheme']) {
      assert.equal(key in ft, false, `${file} still has fullscreenTerminal.${key}`);
    }
  }
});

// ─── the house voice and the credit ──────────────────────────────────────────

test('English is always spoken in the house register, and nothing else is touched', () => {
  const { voiceFor } = loadTs('src/renderer/src/i18n/useThemeVoice.ts');
  assert.equal(voiceFor('en'), 'en-SH');
  assert.equal(voiceFor('en-SH'), null);
  assert.equal(voiceFor('ar'), null);
  assert.equal(voiceFor('zh-CN'), null);
});

test('the licence credit renders whatever was saved before', () => {
  freshTheme({ 'cth.theme': 'light' });
  const { SixthHistoryCredit } = loadTs.fresh('src/renderer/src/components/SixthHistoryCredit.tsx');
  const tree = mount(SixthHistoryCredit, {}).tree;
  assert.ok(tree, 'the credit rendered nothing');
  assert.match(text(tree).join(' '), /unofficial content/i);
});

// ─── the floor ───────────────────────────────────────────────────────────────

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};

test('the floor host does not reach for the pixel office', () => {
  const src = strip(read(HOST));
  assert.doesNotMatch(src, /OfficeFloor/, 'FloorHost still imports or mounts the office');
});

test('the Study mounts whatever was saved before', () => {
  for (const saved of ['light', 'dark', 'occult']) {
    freshTheme({ 'cth.theme': saved });
    const mod = loadTs.fresh(HOST);
    const tree = mount(mod.FloorHost, {}).tree;
    assert.ok(find(tree, (n) => n.type === mod.StudySceneLazy), `${saved}: no Study`);
  }
});

test('a Study that fails says so in its own panel, not the pixel office', () => {
  freshTheme({});
  const mod = loadTs.fresh(HOST);
  const element = find(mount(mod.FloorHost, {}).tree, (n) => n.type === mod.FloorErrorBoundary);
  assert.ok(element, 'the Study is not under a boundary');
  const boundary = new mod.FloorErrorBoundary(element.props);
  boundary.state = mod.FloorErrorBoundary.getDerivedStateFromError(new Error('boom'));
  const shown = boundary.render();
  assert.ok(shown, 'the boundary shows nothing once the Study fails');
  assert.equal(find(shown, (n) => n.type === mod.StudySceneLazy), undefined, 'the failed Study is still up');
  // The fallback is a component of the host's own: render it and read it.
  const rendered = typeof shown.type === 'function' ? shown.type(shown.props) : shown;
  assert.match(text(rendered).join(' '), /could not be drawn/i);
});

// ─── config and voice settings ───────────────────────────────────────────────

test('keys left over from the removed themes are dropped on read and not written back', () => {
  const { readConfig, writeConfig } = loadTs('src/main/config.ts');
  const file = path.join(userData, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    onboardingComplete: true, tvShowOffices: true, officeTheme: 'brooklyn99', terminalTheme: 'light'
  }));
  const c = readConfig();
  assert.equal(c.onboardingComplete, true, 'the rest of the config did not survive');
  for (const key of ['tvShowOffices', 'officeTheme', 'terminalTheme']) {
    assert.equal(key in c, false, `${key} rode along into the loaded config`);
  }
  writeConfig({ autoMode: true });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.autoMode, true);
  assert.equal(onDisk.onboardingComplete, true);
  for (const key of ['tvShowOffices', 'officeTheme', 'terminalTheme']) {
    assert.equal(key in onDisk, false, `${key} was written back to disk`);
  }
});

test('every agent is spawned for a dark terminal', () => {
  const src = strip(read('src/main/index.ts'));
  assert.doesNotMatch(src, /terminalTheme/, 'the spawn still reads a terminal theme setting');
  assert.match(src, /theme:\s*'dark'/, 'the spawn no longer tells the agent its ground is dark');
});

test('voice cannot change the terminal theme, because there is none to change', () => {
  const { VOICE_SETTING_KEYS } = loadTs('src/main/realtimeActions.ts');
  assert.equal(VOICE_SETTING_KEYS.includes('terminalTheme'), false);
});

// ─── leftovers ───────────────────────────────────────────────────────────────

test('the generator for an already-deleted map is gone too', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'tools/gen-b99-map.cjs')), false);
  assert.doesNotMatch(read('package.json'), /gen-b99-map/);
});
