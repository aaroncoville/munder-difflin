'use strict';
/**
 * The Study is the only floor, so the pixel office scene and everything that
 * existed only to draw it are gone: the Tiled map, the licensed tilesets and
 * their credits, the sitcom cast with its sprites and quips, and the cast
 * pickers.
 *
 * What must survive the removal is pinned here too:
 *   - a hire manifest written for an older build, which names a cast member in
 *     `character`, still validates — the field is accepted and dropped;
 *   - agents stored by an older build, which all carry `character`, still load
 *     under the names they had, and the retired field is not written back;
 *   - an assistant the portrait pack cannot cover shows a monogram, not a sprite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// MUST come before loadTs of any component — it seeds the react modules.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const R = (...p) => path.join(ROOT, ...p);
const RENDERER = R('src', 'renderer', 'src');
const read = (rel) => fs.readFileSync(R(rel), 'utf8');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourcesUnder(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourcesUnder(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ─── the scene and its assets ───────────────────────────────────────────────

test('the office scene, its map, its tilesets and the sprite portrait are gone', () => {
  for (const rel of [
    ['scene', 'office'],
    ['assets', 'tilesets'],
    ['assets', 'maps'],
    ['components', 'SpritePortrait.tsx']
  ]) {
    assert.equal(fs.existsSync(path.join(RENDERER, ...rel)), false, `${rel.join('/')} still ships`);
  }
});

test('nothing in the renderer imports from the office scene', () => {
  const offenders = sourcesUnder(RENDERER)
    .filter((f) => /scene\/office\b|SpritePortrait/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

test('the LimeZu credits go with the tilesets they credited', () => {
  for (const rel of [
    'README.md', 'CONTRIBUTING.md', 'docs/index.html', 'docs/pro/index.html',
    'tools/landing-halloween/base.html', 'src/renderer/src/assets/ATTRIBUTION.md'
  ]) {
    assert.doesNotMatch(read(rel), /limezu/i, `${rel} still credits art that no longer ships`);
  }
  assert.equal(fs.existsSync(R('LICENSE-ASSETS')), false, 'the asset licence carve-out has nothing left to carve out');
});

test('the asset attribution lists only files that still ship', () => {
  const doc = read('src/renderer/src/assets/ATTRIBUTION.md');
  const linked = [...doc.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
  assert.ok(linked.length > 0, 'the attribution points at nothing');
  for (const l of linked) {
    assert.ok(fs.existsSync(path.join(RENDERER, 'assets', l)), `ATTRIBUTION.md links to ${l}, which does not exist`);
  }
  for (const dir of fs.readdirSync(path.join(RENDERER, 'assets'), { withFileTypes: true })) {
    if (dir.isDirectory()) assert.match(doc, new RegExp(`${dir.name}/`), `assets/${dir.name} is shipped but not listed`);
  }
});

// ─── hire manifests ─────────────────────────────────────────────────────────

test('a manifest that names a cast member still validates, and the field is dropped', () => {
  const { validateHireManifest } = loadTs('src/shared/hire.ts');
  const res = validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'Dwight', character: 'dwight', accent: 'mint' });
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.manifest.name, 'Dwight', 'the name is untouched');
  assert.equal('character' in res.manifest, false, 'the retired field is carried into the result');
  assert.equal(res.manifest.accent, 'mint');
});

test('the retired field keeps the published gallery validator\'s length cap', () => {
  // docs/hires/validator.js still caps `character` at 24; the two must agree on
  // what is valid, so the runtime keeps rejecting what the gallery rejects.
  const { validateHireManifest } = loadTs('src/shared/hire.ts');
  assert.equal(validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'X', character: 'c'.repeat(25) }).ok, false);
});

// ─── stored agents ──────────────────────────────────────────────────────────

const old = (id, name) => ({
  id, name, character: 'dwight', accent: 'sky', description: 'a reader', project: 'p',
  tmuxTarget: '', cwd: '/tmp/p', status: 'idle', action: '', progress: 0
});

function storeWith(win) {
  global.window = win;
  loadTs.reset();
  return loadTs('src/renderer/src/store/store.ts').useStore.getState();
}

function assertLoaded(state) {
  assert.deepEqual(state.agents.map((a) => a.name), ['Dwight Schrute'], 'a stored agent was lost or renamed');
  assert.deepEqual(state.archivedAgents.map((a) => a.name), ['Kevin']);
  assert.deepEqual(state.restorableAgents.map((a) => a.name), ['Pam']);
  for (const a of [...state.agents, ...state.archivedAgents, ...state.restorableAgents]) {
    assert.equal('character' in a, false, `${a.name} still carries the retired field`);
  }
}

test('agents an older build wrote to the roster file load, and shed `character`', () => {
  const state = storeWith({
    cth: {
      rosterReadSync: () => ({
        agents: [old('w-1', 'Dwight Schrute')], archived: [old('w-2', 'Kevin')], restorable: [old('w-3', 'Pam')]
      }),
      harnessHomeSync: () => '/hive'
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {}
  });
  assertLoaded(state);
});

test('agents an older build wrote to localStorage load, and shed `character`', () => {
  const stored = {
    'cth.agents': JSON.stringify([old('w-1', 'Dwight Schrute')]),
    'cth.archivedAgents': JSON.stringify([old('w-2', 'Kevin')]),
    'cth.restorableAgents': JSON.stringify([old('w-3', 'Pam')]),
    'cth.rosterHome': '/hive'
  };
  const state = storeWith({
    cth: { rosterReadSync: () => null, harnessHomeSync: () => '/hive' },
    localStorage: { getItem: (k) => stored[k] ?? null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {}
  });
  assertLoaded(state);
});

// ─── the face ───────────────────────────────────────────────────────────────

test('an assistant the pack cannot cover wears a monogram in the display face', () => {
  global.window = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
  loadTs.reset();
  loadTs.stub('src/renderer/src/scene/study/portraits.ts', {
    GOD_PORTRAIT: 'fascination',
    portraitFor: () => undefined,
    portraitNamed: () => undefined
  });
  const { AgentFace } = loadTs('src/renderer/src/components/AgentFace.tsx');
  const nodes = flatten(mount(AgentFace, { id: 'w-1', name: 'enid' }).tree).map((e) => e.node);
  assert.equal(nodes.some((n) => n && (n.type === 'img' || n.type === 'canvas')), false,
    'drew a picture where there is none to draw');
  const mono = nodes.find((n) => n && n.props && n.props.children === 'E');
  assert.ok(mono, `no monogram; rendered: ${JSON.stringify(text(nodes[0]))}`);
  assert.equal(mono.props.style.fontFamily, 'var(--cth-font-display)');
  assert.match(mono.props.style.color, /^var\(--cth-[a-z0-9-]+\)$/, 'the monogram colour is not a design token');
});

// ─── the window before the renderer paints ──────────────────────────────────

test('the window and the boot splash open on the occult ground, not cream', () => {
  const { APP_GROUND } = loadTs('src/shared/appGround.ts');
  const tokens = read('src/renderer/src/design/occult/occult-tokens.css');
  const ground = tokens.match(/--cth-cream-50:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(APP_GROUND.toLowerCase(), ground.toLowerCase(), 'the shared ground drifted from the occult token');

  const main = stripComments(read('src/main/index.ts'));
  assert.doesNotMatch(main, /#FFF8E7/i, 'main still opens the window cream');
  assert.match(main, /backgroundColor:\s*APP_GROUND\b/, 'the window does not take its ground from the shared value');

  const html = read('src/renderer/index.html');
  const splash = html.match(/#cth-splash\s*\{[^}]*\}/)[0];
  assert.match(splash, new RegExp(`background:\\s*${APP_GROUND}\\b`, 'i'), 'the boot splash is not on the occult ground');
});

// ─── the Study's failure panel ──────────────────────────────────────────────

test('the Study\'s failure sentence is translated in every locale', () => {
  for (const code of ['en', 'en-SH', 'ar', 'zh-CN']) {
    const cat = JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
    const s = cat.study && cat.study.unavailable;
    assert.equal(typeof s, 'string', `${code} has no study.unavailable`);
    assert.ok(s.trim().length > 0, `${code} study.unavailable is empty`);
  }
  const host = stripComments(read('src/renderer/src/scene/study/FloorHost.tsx'));
  assert.doesNotMatch(host, /could not be drawn/i, 'the sentence is still hard-coded in the panel');
  assert.match(host, /t\(\s*'study\.unavailable'\s*\)/, 'the panel does not read the key');
});
