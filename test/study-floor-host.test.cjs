'use strict';

/**
 * The one place the Study meets the rest of the app: the floor it stands on.
 *
 * The Study must not be able to take the app down. It is the newest thing here
 * and it parses a hand-edited floor plan, so it is reached through a lazy chunk
 * and renders under a boundary. When it fails, the boundary puts up a plain
 * panel of its own saying the room could not be drawn — not the pixel office,
 * which is no longer part of the app's look.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, text } = require('./render-hooks.cjs');
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
const { StudyScene } = loadTs(SCENE);

/** Load the host afresh. */
function host() {
  return loadTs.fresh(HOST);
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

test('the Study is fetched as its own chunk', async () => {
  const { FloorHost, StudySceneLazy } = host();
  const tree = mount(FloorHost, {}).tree;
  assert.ok(find(tree, (n) => n.type === StudySceneLazy), 'the Study is mounted');
  assert.ok(find(tree, (n) => n.type === React.Suspense),
    'a lazy floor is wrapped in Suspense, or React throws on first paint');
  // The loader the module actually built, resolved: the chunk behind it has to
  // be the real scene, not something that merely mentions it.
  assert.equal((await StudySceneLazy.loader()).default, StudyScene,
    'the lazy chunk is the Study');
});

test('the Study is not statically imported, so the chrome paints before its art arrives', () => {
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
function boundaryAroundStudy() {
  const mod = host();
  const element = find(mount(mod.FloorHost, {}).tree,
    (n) => n.type === mod.FloorErrorBoundary);
  assert.ok(element, 'the Study is mounted under a boundary');
  return { ...mod, element };
}

/** What the host puts on screen once `error` has reached its boundary. */
function afterFailure(error) {
  const { FloorErrorBoundary, StudySceneLazy, element } = boundaryAroundStudy();
  const boundary = new FloorErrorBoundary(element.props);
  assert.ok(find(boundary.render(), (n) => n.type === StudySceneLazy),
    'a boundary that has not caught anything shows the Study');
  boundary.state = FloorErrorBoundary.getDerivedStateFromError(error);
  const shown = boundary.render();
  assert.equal(find(shown, (n) => n.type === StudySceneLazy), undefined,
    'the Study that failed is gone');
  return { shown, StudyUnavailable: loadTs(HOST).StudyUnavailable };
}

/** The failure panel is what stands in the Study's place, and it says so. */
function assertPanel({ shown, StudyUnavailable }) {
  assert.ok(shown && shown.type === StudyUnavailable,
    'the panel is standing where the Study would have been');
  const en = require('../src/renderer/src/i18n/locales/en.json');
  assert.match(en.study.unavailable, /could not be drawn/i, 'the English sentence changed meaning');
  assert.equal(text(shown.type(shown.props)).join(' ').trim(), en.study.unavailable,
    'the panel does not say what happened, in the reader\'s language');
}

test('a floor plan that will not validate leaves the failure panel standing', () => {
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
  assertPanel(afterFailure(error));
});

test('a Study chunk that will not load leaves the failure panel standing', async () => {
  // A chunk that 404s, or a module that throws as it is evaluated, both reach
  // the host as a rejected loader — Suspense does not catch either.
  loadTs.stub(SCENE, {
    get StudyScene() { throw new Error('Failed to fetch dynamically imported module'); }
  });
  let error;
  try {
    const { StudySceneLazy } = host();
    error = await StudySceneLazy.loader().then(
      () => { throw new Error('the loader resolved a chunk that cannot load'); },
      (err) => err);
    assert.match(error.message, /dynamically imported module/);
  } finally {
    loadTs.fresh(SCENE);
  }
  assertPanel(afterFailure(error));
});

test('a Study that throws mid-render leaves the failure panel standing', () => {
  assertPanel(afterFailure(new Error('Cannot read properties of undefined')));
});

test('the boundary reports what it caught rather than swallowing it', () => {
  const { FloorErrorBoundary, element } = boundaryAroundStudy();
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
