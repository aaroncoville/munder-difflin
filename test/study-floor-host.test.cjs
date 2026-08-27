'use strict';

/**
 * The one place the Study meets the rest of the app: which floor gets mounted.
 *
 * Two properties are load-bearing here, and they pull in opposite directions.
 *
 * The office floor must mount SYNCHRONOUSLY. Light and dark have always
 * rendered it on the first paint, and reaching it through a lazy chunk replaces
 * that first paint with a blank fallback for as long as the chunk takes — and
 * with nothing at all if the chunk never arrives. So the host imports it
 * statically, and these tests assert the office component itself is in the tree
 * rather than a placeholder standing in for it.
 *
 * The Study must not be able to take the app down. It is the newest thing here,
 * it parses a hand-edited floor plan, and it is only ever mounted under one of
 * three themes — so it is the branch that gets the lazy chunk, and it renders
 * under a boundary whose fallback is the office floor.
 *
 * OfficeFloor cannot be loaded in this harness — it pulls in Pixi and a handful
 * of Vite `?url` asset imports that only a bundler resolves — so it is stood in
 * for at its real path. The host still has to import THAT path to see it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');
const fs = require('node:fs');
const path = require('node:path');

const React = require('react');
React.Suspense = Symbol.for('react.suspense');
React.lazy = (loader) => ({ $$typeof: Symbol.for('react.lazy'), loader });
// The real base class only stores props and provides setState/forceUpdate; a
// boundary reads `this.props` and `this.state` and is otherwise driven by
// React calling its statics, which the cases below do directly.
React.Component = class Component {
  constructor(props) { this.props = props; }
};

const HOST = 'src/renderer/src/scene/study/FloorHost.tsx';
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const MANIFEST = 'src/renderer/src/scene/study/roomManifest.ts';
const OFFICE = 'src/renderer/src/scene/office/OfficeFloor.tsx';

/** The pixel office, stood in for — see the header. */
const OfficeFloor = ({ children }) => children ?? null;
loadTs.stub(OFFICE, { OfficeFloor });

const { StudyScene } = loadTs(SCENE);

/** Load the host and the theme module afresh, with the theme already chosen —
 *  theme.ts reads localStorage once, at module load. */
function hostFor(theme) {
  global.window = { localStorage: { getItem: () => theme, setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
  loadTs.fresh('src/renderer/src/design/theme.ts');
  return loadTs.fresh(HOST);
}

/** Every theme in the shipped ring, walked from the module itself rather than
 *  written down here — a theme added later joins this test on its own. */
function allThemes() {
  const { themeControlFace } = hostFor('light') && loadTs('src/renderer/src/design/theme.ts');
  const seen = [];
  let t = 'light';
  while (!seen.includes(t)) { seen.push(t); t = themeControlFace(t).next; }
  return seen;
}

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};

test('the occult theme mounts the Study, every other theme the office', () => {
  const themes = allThemes();
  assert.ok(themes.length >= 3, `walked the ring: ${themes.join(', ')}`);
  for (const theme of themes) {
    const { floorForTheme } = hostFor(theme);
    assert.equal(floorForTheme(theme), theme === 'occult' ? 'study' : 'office',
      `${theme} floor`);
  }
});

test('outside the occult theme the office floor mounts on the first paint', () => {
  for (const theme of ['light', 'dark']) {
    const { FloorHost } = hostFor(theme);
    const tree = mount(FloorHost, {}).tree;
    // The office COMPONENT, not a lazy element standing in for it: a chunk that
    // has not arrived (or never arrives) is a blank window where light and dark
    // have always had a floor.
    assert.equal(tree.type, OfficeFloor, `${theme}: the office floor is the whole floor`);
    assert.equal(find(tree, (n) => n.type === React.Suspense), undefined,
      `${theme}: nothing is waiting on a chunk`);
    assert.equal(find(tree, (n) => n.props?.loader !== undefined), undefined,
      `${theme}: and nothing is fetched to draw it`);
    assert.equal(find(tree, (n) => n.type === StudyScene), undefined,
      `${theme}: the Study stays out of the pixel office`);
  }
});

test('the occult theme fetches the Study rather than shipping it to every floor', async () => {
  const { FloorHost, StudySceneLazy } = hostFor('occult');
  const tree = mount(FloorHost, {}).tree;
  assert.ok(find(tree, (n) => n.type === StudySceneLazy), 'the Study is mounted');
  assert.ok(find(tree, (n) => n.type === React.Suspense),
    'a lazy floor is wrapped in Suspense, or React throws on first paint');
  // The loader the module actually built, resolved: the chunk behind it has to
  // be the real scene, not something that merely mentions it.
  assert.equal((await StudySceneLazy.loader()).default, StudyScene,
    'the lazy chunk is the Study');
});

test('the Study is not statically imported, so light and dark never fetch its art', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', HOST), 'utf8');
  assert.doesNotMatch(src, /^import\s[^\n]*['"]\.\/StudyScene['"]/m,
    'StudyScene must be reached through a dynamic import');
});

// ─── When the Study will not come up ─────────────────────────────────────────
// React answers a render error — and a lazy chunk that rejects, which surfaces
// the same way — by calling the nearest boundary's `getDerivedStateFromError`
// and re-rendering it. These drive the REAL boundary the host installs, with
// the REAL error each failure produces, and assert what is left on screen.

/** The boundary element the host wraps the Study in, and the class behind it. */
function boundaryUnderOccult() {
  const mod = hostFor('occult');
  const element = find(mount(mod.FloorHost, {}).tree,
    (n) => n.type === mod.FloorErrorBoundary);
  assert.ok(element, 'the Study is mounted under a boundary');
  return { ...mod, element };
}

/** What the host puts on screen once `error` has reached its boundary. */
function afterFailure(error) {
  const { FloorErrorBoundary, StudySceneLazy, element } = boundaryUnderOccult();
  const boundary = new FloorErrorBoundary(element.props);
  assert.ok(find(boundary.render(), (n) => n.type === StudySceneLazy),
    'a boundary that has not caught anything shows the Study');
  boundary.state = FloorErrorBoundary.getDerivedStateFromError(error);
  const shown = boundary.render();
  assert.equal(find(shown, (n) => n.type === StudySceneLazy), undefined,
    'the Study that failed is gone');
  return shown;
}

test('a floor plan that will not validate leaves the office floor standing', () => {
  // The real scene, with a real broken plan: the module still LOADS — importing
  // it is what a rejected chunk would take down — and the failure arrives as a
  // render error naming the field, which is what reaches the boundary.
  const real = loadTs(MANIFEST);
  loadTs.stub(MANIFEST, {
    ...real,
    loadRoomManifest: () => ({ ok: false, error: 'berth-3 hangs off the panel of desk-3' })
  });
  let error;
  try {
    const broken = loadTs.fresh(SCENE);
    assert.match(broken.studyRoomError, /berth-3/, 'the scene knows why it cannot draw');
    error = assert.throws(() => mount(broken.StudyScene, {}), /berth-3/);
  } finally {
    loadTs.fresh(MANIFEST);
    loadTs.fresh(SCENE);
  }
  assert.ok(find(afterFailure(error), (n) => n.type === OfficeFloor),
    'the office floor is standing where the Study would have been');
});

test('a Study chunk that will not load leaves the office floor standing', async () => {
  // A chunk that 404s, or a module that throws as it is evaluated, both reach
  // the host as a rejected loader — Suspense does not catch either.
  loadTs.stub(SCENE, {
    get StudyScene() { throw new Error('Failed to fetch dynamically imported module'); }
  });
  let error;
  try {
    const { StudySceneLazy } = hostFor('occult');
    error = await StudySceneLazy.loader().then(
      () => { throw new Error('the loader resolved a chunk that cannot load'); },
      (err) => err);
    assert.match(error.message, /dynamically imported module/);
  } finally {
    loadTs.fresh(SCENE);
  }
  assert.ok(find(afterFailure(error), (n) => n.type === OfficeFloor),
    'the office floor is standing where the Study would have been');
});

test('a Study that throws mid-render leaves the office floor standing', () => {
  assert.ok(find(afterFailure(new Error('Cannot read properties of undefined')),
    (n) => n.type === OfficeFloor),
  'the office floor is standing where the Study would have been');
});

test('the boundary reports what it caught rather than swallowing it', () => {
  const { FloorErrorBoundary, element } = boundaryUnderOccult();
  const boundary = new FloorErrorBoundary(element.props);
  const seen = [];
  const original = console.error;
  console.error = (...args) => seen.push(args);
  try {
    boundary.componentDidCatch(new Error('the hearth is on fire'), { componentStack: '' });
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1, 'a floor that fell over is reported once');
  assert.ok(seen[0].some((a) => String(a?.message ?? a).includes('the hearth is on fire')),
    'and the error itself is what is reported');
});

test('App mounts the host instead of the floor directly', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/src/App.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /<OfficeFloor\b/, 'App still mounts the office floor directly');
  assert.doesNotMatch(src, /scene\/office\/OfficeFloor/, 'App still imports the office floor');
  assert.match(src, /<FloorHost\s*\/>/, 'App mounts the floor host');
});
