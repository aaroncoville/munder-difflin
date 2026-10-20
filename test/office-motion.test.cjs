'use strict';

// How hard the office floor animates. On a software GPU (SwiftShader on WSL2/
// WSLg, llvmpipe in a VM) the Pixi scene's uncapped ticker and >=2x canvas are
// pure CPU — ~5.9 cores of rasterizer threads for people sitting at desks — so
// the floor consults this before it builds its renderer. These pin the decision
// (setting × classification × reduced-motion → fps/resolution), the unattended
// pause, the extra ticker gate, and the fact that the floor and config actually
// wire it up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// Loads with no `window`/`document` in scope: everything but currentOfficeMotion
// must be pure, and the WebGL probe it reuses must stay lazy.
const {
  decideOfficeMotion, resolveOfficeMotionMode, fullMotionResolution, unattendedPauseDelay,
  getOfficeMotionPref, setOfficeMotionPref, applyOfficeMotionPref, subscribeOfficeMotionPref,
  prefersReducedMotion,
  REDUCED_MOTION_MAX_FPS, REDUCED_MOTION_RESOLUTION, FULL_MOTION_MIN_RESOLUTION, UNATTENDED_GRACE_MS
} = loadTs('src/renderer/src/scene/office/officeMotion.ts');
const { shouldRunTicker } = loadTs('src/renderer/src/scene/office/glRecovery.ts');

const CLASSES = ['hardware', 'software', 'unknown'];

// --- the constants are the documented ones -------------------------------------

test('the reduced path is 15 fps at 1x; the full path floors resolution at 2', () => {
  assert.equal(REDUCED_MOTION_MAX_FPS, 15);
  assert.equal(REDUCED_MOTION_RESOLUTION, 1);
  assert.equal(FULL_MOTION_MIN_RESOLUTION, 2);
  assert.equal(UNATTENDED_GRACE_MS, 30_000);
});

// --- the decision --------------------------------------------------------------------

test("'auto' reduces on software and on OS reduced motion, and only then", () => {
  assert.equal(resolveOfficeMotionMode('auto', 'software', false), 'reduced');
  assert.equal(resolveOfficeMotionMode('auto', 'hardware', false), 'full');
  assert.equal(resolveOfficeMotionMode('auto', 'unknown', false), 'full', "unknown must preserve today's behaviour");
  for (const c of CLASSES) {
    assert.equal(resolveOfficeMotionMode('auto', c, true), 'reduced', `prefers-reduced-motion on ${c}`);
  }
  // An absent setting (older config.json) is 'auto'.
  assert.equal(resolveOfficeMotionMode(undefined, 'software', false), 'reduced');
  assert.equal(resolveOfficeMotionMode(undefined, 'hardware', false), 'full');
});

test("'full' and 'reduced' override both the probe and the OS hint", () => {
  for (const c of CLASSES) for (const rm of [false, true]) {
    assert.equal(resolveOfficeMotionMode('full', c, rm), 'full', `full/${c}/${rm}`);
    assert.equal(resolveOfficeMotionMode('reduced', c, rm), 'reduced', `reduced/${c}/${rm}`);
  }
});

test('the full path is exactly today: uncapped, max(dpr, 2), antialias off', () => {
  for (const [dpr, want] of [[1, 2], [1.25, 2], [1.5, 2], [2, 2], [2.5, 2.5], [3, 3], [0, 2], [NaN, 2]]) {
    assert.equal(fullMotionResolution(dpr), want, `dpr ${dpr}`);
  }
  const d = decideOfficeMotion('auto', 'hardware', false, 1.5);
  assert.deepEqual(d, { mode: 'full', maxFPS: 0, resolution: 2, antialias: false });
  assert.equal(decideOfficeMotion('auto', 'hardware', false, 3).resolution, 3);
  assert.equal(decideOfficeMotion('auto', 'unknown', false, 1).resolution, 2);
});

test('the reduced path caps the ticker and renders at 1x whatever the dpr', () => {
  for (const dpr of [1, 1.5, 2, 3]) {
    assert.deepEqual(decideOfficeMotion('auto', 'software', false, dpr),
      { mode: 'reduced', maxFPS: 15, resolution: 1, antialias: false }, `dpr ${dpr}`);
  }
  assert.deepEqual(decideOfficeMotion('reduced', 'hardware', false, 2),
    { mode: 'reduced', maxFPS: 15, resolution: 1, antialias: false });
  assert.deepEqual(decideOfficeMotion('auto', 'hardware', true, 2),
    { mode: 'reduced', maxFPS: 15, resolution: 1, antialias: false });
});

test('the reduced path does roughly a sixteenth of the full path\'s rasterisation', () => {
  // 1600×900 CSS floor at 60 Hz: pixels per second painted on each path.
  const w = 1600, h = 900, hz = 60;
  const full = decideOfficeMotion('auto', 'hardware', false, 1);
  const reduced = decideOfficeMotion('auto', 'software', false, 1);
  const pxPerSec = (d) => w * d.resolution * h * d.resolution * (d.maxFPS || hz);
  assert.equal(pxPerSec(full) / pxPerSec(reduced), 16);
});

// --- the unattended pause ---------------------------------------------------------

test('the full path never pauses for focus — today\'s behaviour on a real GPU', () => {
  assert.equal(unattendedPauseDelay({ mode: 'full', focused: false, lastAgentChangeAt: 0, now: 10_000_000 }), null);
});

test('a focused window never pauses, however quiet the agents are', () => {
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: true, lastAgentChangeAt: 0, now: 10_000_000 }), null);
});

test('an unfocused reduced floor pauses 30 s after the last agent state change', () => {
  const t0 = 1_000_000;
  // Just blurred, agents changed a moment ago: wait the full grace.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, lastAgentChangeAt: t0, now: t0 }), 30_000);
  // Agents changed 12 s ago: wait the remainder.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, lastAgentChangeAt: t0, now: t0 + 12_000 }), 18_000);
  // Quiet for longer than the grace already: pause now, never a negative delay.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, lastAgentChangeAt: t0, now: t0 + 90_000 }), 0);
  // The grace is injectable.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, lastAgentChangeAt: t0, now: t0, graceMs: 5_000 }), 5_000);
});

test('shouldRunTicker keeps its two gates and adds the unattended one', () => {
  // Existing behaviour, untouched: callers that pass two booleans get the same answers.
  assert.equal(shouldRunTicker({ paused: false, contextLost: false }), true);
  assert.equal(shouldRunTicker({ paused: true, contextLost: false }), false);
  assert.equal(shouldRunTicker({ paused: false, contextLost: true }), false);
  assert.equal(shouldRunTicker({ paused: true, contextLost: true }), false);
  // The new gate.
  assert.equal(shouldRunTicker({ paused: false, contextLost: false, unattended: false }), true);
  assert.equal(shouldRunTicker({ paused: false, contextLost: false, unattended: true }), false);
  assert.equal(shouldRunTicker({ paused: true, contextLost: false, unattended: false }), false);
});

// --- the mirrored setting ----------------------------------------------------------

test('the mirrored setting defaults to auto, normalises junk, and notifies on change', () => {
  assert.equal(getOfficeMotionPref(), 'auto');
  assert.equal(setOfficeMotionPref('auto'), false, 'same value is not a change');
  assert.equal(setOfficeMotionPref('reduced'), true);
  assert.equal(getOfficeMotionPref(), 'reduced');
  assert.equal(setOfficeMotionPref('bogus'), true, 'junk falls back to auto');
  assert.equal(getOfficeMotionPref(), 'auto');
  assert.equal(setOfficeMotionPref(undefined), false);

  let woke = 0;
  const unsub = subscribeOfficeMotionPref(() => { woke += 1; });
  applyOfficeMotionPref('auto');
  assert.equal(woke, 0, 'no change, no wake-up');
  applyOfficeMotionPref('full');
  assert.equal(woke, 1);
  unsub();
  applyOfficeMotionPref('auto');
  assert.equal(woke, 1, 'unsubscribed');
  assert.equal(getOfficeMotionPref(), 'auto');
});

test('the OS hint reads false with no DOM, never throws', () => {
  assert.equal(prefersReducedMotion(), false);
});

// --- wiring: the floor reads the decision; config declares the setting ------------

test('OfficeFloor builds its renderer from the decision and caps the ticker with it', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  const i = src.indexOf('const motion = currentOfficeMotion();');
  assert.ok(i > 0, 'the floor no longer asks');
  const init = src.slice(i, src.indexOf('autoDensity: true', i));
  assert.match(init, /antialias: motion\.antialias,/);
  assert.match(init, /resolution: motion\.resolution,/);
  assert.doesNotMatch(init, /devicePixelRatio/, 'the dpr rule lives in officeMotion.ts now');
  assert.match(src, /app\.ticker\.maxFPS = motion\.maxFPS;/);
  // The mode rebuilds the scene (resolution is fixed at init) …
  assert.match(src, /\}, \[officeTheme, glGeneration, i18n\.language, released, motionMode\]\);/);
  // … and every ticker start/stop decision passes the unattended gate.
  assert.match(src, /shouldRunTicker\(\{ paused, contextLost: contextLostRef\.current, unattended \}\)/);
  assert.match(src, /shouldRunTicker\(\{ paused: pausedRef\.current, contextLost: false, unattended: unattendedRef\.current \}\)/);
  assert.doesNotMatch(src, /if \(pausedRef\.current\) app\.ticker\.stop\(\);/, 'init() must honour the unattended gate too');
  // Blur/focus and the agent-change signal drive the grace timer.
  assert.match(src, /window\.addEventListener\('blur', onBlur\)/);
  assert.match(src, /unattendedPauseDelay\(\{/);
  assert.match(src, /if \(s\.agents === prev\.agents\) return;\s*lastAgentChangeAtRef\.current = Date\.now\(\);/);
});

test('the floor reuses the terminal renderer\'s probe rather than probing again', () => {
  const motion = strip(read('src/renderer/src/scene/office/officeMotion.ts'));
  assert.match(motion, /import \{ webglRendererInfo, type WebglClassification \} from '@\/components\/terminalRenderer';/);
  assert.doesNotMatch(motion, /getContext\(/, 'no second WebGL probe');
  assert.doesNotMatch(read('src/renderer/src/scene/office/OfficeFloor.tsx'), /probeWebglRenderer/);
});

test('the config default is auto and every mirror declares the setting', () => {
  assert.match(read('src/main/config.ts'), /officeMotion: 'auto',/);
  for (const f of ['src/main/config.ts', 'src/preload/index.ts', 'src/renderer/src/store/config.ts']) {
    assert.match(read(f), /officeMotion\?: 'auto' \| 'full' \| 'reduced';/, f);
  }
});

test('App mirrors the setting into the floor on load and on every change', () => {
  const app = strip(read('src/renderer/src/App.tsx'));
  const calls = app.match(/applyOfficeMotionPref\(c\.officeMotion\)/g) ?? [];
  assert.equal(calls.length, 2, 'initial load + onConfigChanged');
});

test('Settings stages the setting instead of writing it, in every locale', () => {
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(modal, /stage\(\{ officeMotion: next \}\)/);
  const keys = ['officeMotion', 'officeMotionDesc', 'officeMotionAuto', 'officeMotionFull', 'officeMotionReduced'];
  const locales = {};
  for (const l of ['en', 'ar', 'zh-CN']) {
    locales[l] = JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`)).settings.general;
    for (const k of keys) assert.equal(typeof locales[l][k], 'string', `${l}: settings.general.${k}`);
  }
  for (const k of keys) {
    assert.notEqual(locales.ar[k], locales.en[k], `ar.${k} is translated`);
    assert.notEqual(locales['zh-CN'][k], locales.en[k], `zh-CN.${k} is translated`);
  }
});

test('README documents the setting next to the terminal renderer', () => {
  const readme = read('README.md');
  const i = readme.indexOf('### Performance on WSL / software GPU');
  assert.ok(i > 0);
  const section = readme.slice(i, readme.indexOf('## Architecture', i));
  assert.match(section, /`officeMotion`/);
  assert.match(section, /15 fps/);
});
