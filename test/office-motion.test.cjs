'use strict';

// How hard the office floor animates. On a software GPU (SwiftShader on WSL2/
// WSLg, llvmpipe in a VM) the Pixi scene's uncapped ticker and >=2x canvas are
// pure CPU — ~5.9 cores of rasterizer threads for people sitting at desks — so
// the floor consults this before it builds its renderer, and the gate keeps the
// live application in step afterwards. These pin the decision (setting ×
// classification × reduced-motion → fps/resolution), the unattended pause as
// behaviour against a fake window/clock/app, that the gate lets go of
// everything on dispose, and that the floor and config actually wire it up.

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
const M = loadTs('src/renderer/src/scene/office/officeMotion.ts');
const {
  decideOfficeMotion, resolveOfficeMotionMode, fullMotionResolution, unattendedPauseDelay,
  getOfficeMotionPref, setOfficeMotionPref, applyOfficeMotionPref, subscribeOfficeMotionPref,
  officeMotionPrefListenerCount, prefersReducedMotion, createOfficeMotionGate,
  REDUCED_MOTION_MAX_FPS, REDUCED_MOTION_RESOLUTION, FULL_MOTION_MIN_RESOLUTION, UNATTENDED_GRACE_MS
} = M;
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

// --- the unattended planner ---------------------------------------------------------

test('the full path never pauses for focus — today\'s behaviour on a real GPU', () => {
  assert.equal(unattendedPauseDelay({ mode: 'full', focused: false, blurredAt: 0, now: 10_000_000 }), null);
});

test('a focused window never pauses', () => {
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: true, blurredAt: 0, now: 10_000_000 }), null);
});

test('the grace counts from the blur and nothing else', () => {
  const t0 = 1_000_000;
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, blurredAt: t0, now: t0 }), 30_000);
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, blurredAt: t0, now: t0 + 20_000 }), 10_000);
  // Blurred for longer than the grace already: pause now, never a negative delay.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, blurredAt: t0, now: t0 + 90_000 }), 0);
  // The grace is injectable.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, blurredAt: t0, now: t0, graceMs: 5_000 }), 5_000);
  // The agents are not an input. A busy floor's store changes several times a
  // second for as long as anyone works; counting from the last change meant
  // the pause never came and an unfocused window drew all afternoon.
  assert.equal(unattendedPauseDelay({ mode: 'reduced', focused: false, blurredAt: t0, lastAgentChangeAt: t0 + 29_000, now: t0 + 30_000 }), 0,
    'an agent change re-armed the grace');
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
  assert.equal(officeMotionPrefListenerCount(), 0);
});

test('the OS hint reads false with no DOM, never throws', () => {
  assert.equal(prefersReducedMotion(), false);
});

// --- the gate, as behaviour ------------------------------------------------------------
//
// A fake window that counts its listeners, a fake reduced-motion query, a
// clock whose timers only fire when the test advances it, and a Pixi
// application that only writes down what it was told. The decision is computed
// from the REAL setting (so applyOfficeMotionPref is the thing under test) with
// the probe stubbed.

function fakeClock(start = 0) {
  let t = start;
  const pending = [];
  return {
    now: () => t,
    schedule(fn, ms) { const h = { at: t + ms, fn }; pending.push(h); return h; },
    cancel(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    /** Fire everything due up to `target`, in order, then land there. */
    advanceTo(target) {
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;
        pending.shift();
        t = next.at;
        next.fn();
      }
      t = target;
    },
    get pendingCount() { return pending.length; }
  };
}

function fakeTarget() {
  const handlers = { focus: new Set(), blur: new Set() };
  return {
    addEventListener(type, fn) { handlers[type].add(fn); },
    removeEventListener(type, fn) { handlers[type].delete(fn); },
    fire(type) { for (const fn of [...handlers[type]]) fn(); },
    get listenerCount() { return handlers.focus.size + handlers.blur.size; }
  };
}

function fakeQuery() {
  const subs = new Set();
  return {
    matches: false,
    addEventListener(_type, fn) { subs.add(fn); },
    removeEventListener(_type, fn) { subs.delete(fn); },
    set(matches) { this.matches = matches; for (const fn of [...subs]) fn(); },
    get listenerCount() { return subs.size; }
  };
}

function fakeApp(resolution) {
  const app = {
    initCalls: 0,
    resizes: [],
    ticker: { maxFPS: 0 },
    screen: { width: 1600, height: 900 },
    renderer: {
      resolution,
      resize(w, h, r) { app.resizes.push([w, h, r]); if (r !== undefined) this.resolution = r; }
    },
    async init() { app.initCalls += 1; }
  };
  return app;
}

/** Stand a gate up over fakes. `classification` is what the probe "found". */
function gateUnderTest({ classification = 'software', focused = true, dpr = 2 } = {}) {
  const clock = fakeClock(1_000_000);
  const target = fakeTarget();
  const query = fakeQuery();
  const verdicts = [];
  let isFocused = focused;
  const gate = createOfficeMotionGate({
    target,
    hasFocus: () => isFocused,
    onUnattendedChange: (v) => verdicts.push(v),
    reducedMotionQuery: query,
    decide: () => decideOfficeMotion(getOfficeMotionPref(), classification, query.matches, dpr),
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel
  });
  return {
    gate, clock, target, query, verdicts,
    focus() { isFocused = true; target.fire('focus'); },
    blur() { isFocused = false; target.fire('blur'); }
  };
}

test('unattended: blur, 30 s, pause; focus resumes; blur again, 30 s, pause again', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const f = gateUnderTest({ classification: 'software' });
  assert.equal(f.gate.decision.mode, 'reduced');
  assert.equal(f.gate.unattended, false, 'a focused floor is attended');

  f.blur();
  f.clock.advanceTo(1_000_000 + 29_999);
  assert.equal(f.gate.unattended, false, 'paused before the grace was up');
  assert.deepEqual(f.verdicts, [], 'no verdict should have been reported yet');
  f.clock.advanceTo(1_000_000 + 30_000);
  assert.equal(f.gate.unattended, true, 'not paused at the grace');
  assert.deepEqual(f.verdicts, [true]);

  f.focus();
  assert.equal(f.gate.unattended, false, 'focus did not resume');
  assert.deepEqual(f.verdicts, [true, false]);
  assert.equal(f.clock.pendingCount, 0, 'a focused floor keeps a timer armed');

  f.clock.advanceTo(1_100_000);
  f.blur();
  f.clock.advanceTo(1_129_999);
  assert.equal(f.gate.unattended, false);
  f.clock.advanceTo(1_130_000);
  assert.equal(f.gate.unattended, true, 'not paused 30 s after the second blur');
  assert.deepEqual(f.verdicts, [true, false, true]);
  f.gate.dispose();
});

test('unattended: the gate has no agents input, so a busy floor pauses like a quiet one', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  // The gate is built over a window, a query and the setting — nothing else.
  // If it took a store subscription it would show up as a listener below.
  const f = gateUnderTest({ classification: 'software' });
  f.blur();
  f.clock.advanceTo(1_000_000 + 30_000);
  assert.equal(f.gate.unattended, true);
  assert.equal(f.target.listenerCount, 2, 'the window is the only focus source');
  f.gate.dispose();
  const motion = strip(read('src/renderer/src/scene/office/officeMotion.ts'));
  assert.doesNotMatch(motion, /lastAgentChangeAt|onAgentsChange/, 'the agents slice must not keep an unfocused floor awake');
});

test('unattended: a window quiet for an hour while focused still gets 30 s after blur', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const f = gateUnderTest({ classification: 'software' });
  // Nothing happens for an hour. Then the user looks away.
  f.clock.advanceTo(1_000_000 + 3_600_000);
  f.blur();
  assert.equal(f.gate.unattended, false, 'paused the instant focus left');
  f.clock.advanceTo(1_000_000 + 3_600_000 + 29_999);
  assert.equal(f.gate.unattended, false);
  f.clock.advanceTo(1_000_000 + 3_600_000 + 30_000);
  assert.equal(f.gate.unattended, true);
  f.gate.dispose();
});

test('unattended: a floor born unfocused waits the whole grace too', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const f = gateUnderTest({ classification: 'software', focused: false });
  assert.equal(f.gate.unattended, false);
  f.clock.advanceTo(1_000_000 + 30_000);
  assert.equal(f.gate.unattended, true);
  f.gate.dispose();
});

test('unattended: the full path never pauses on blur, and switching to reduced plans from the inputs', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const f = gateUnderTest({ classification: 'hardware' });
  assert.equal(f.gate.decision.mode, 'full');
  f.blur();
  f.clock.advanceTo(1_000_000 + 600_000);
  assert.equal(f.gate.unattended, false, "'full' paused for focus — that is not today's behaviour");
  assert.equal(f.clock.pendingCount, 0, "'full' armed a grace timer it will never use");
  // Ten minutes blurred and quiet, then the user forces 'reduced': nobody is
  // watching, so it pauses straight away.
  applyOfficeMotionPref('reduced');
  assert.equal(f.gate.decision.mode, 'reduced');
  assert.equal(f.gate.unattended, true);
  // Back to 'auto' on hardware: full again, resumed.
  applyOfficeMotionPref('auto');
  assert.equal(f.gate.decision.mode, 'full');
  assert.equal(f.gate.unattended, false);
  f.gate.dispose();
});

test('a mode change applies to the LIVE application; it never inits again', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const f = gateUnderTest({ classification: 'hardware', dpr: 2 });
  const app = fakeApp(2);
  // What the floor does: init once with the decision's knobs, then attach.
  app.init();
  app.ticker.maxFPS = f.gate.decision.maxFPS;
  f.gate.attach(app);
  assert.equal(app.initCalls, 1);
  assert.equal(app.ticker.maxFPS, 0);
  assert.deepEqual(app.resizes, [], 'attach resized a canvas already at the right resolution');

  applyOfficeMotionPref('reduced');
  assert.equal(app.ticker.maxFPS, 15);
  assert.equal(app.renderer.resolution, 1);
  assert.deepEqual(app.resizes, [[1600, 900, 1]], 'resolution must go through renderer.resize at the logical size');
  assert.equal(app.initCalls, 1, 'a settings change rebuilt the application');

  applyOfficeMotionPref('full');
  assert.equal(app.ticker.maxFPS, 0);
  assert.equal(app.renderer.resolution, 2);
  assert.deepEqual(app.resizes, [[1600, 900, 1], [1600, 900, 2]]);
  assert.equal(app.initCalls, 1);

  // The OS hint is live too, under 'auto'.
  applyOfficeMotionPref('auto');
  f.query.set(true);
  assert.equal(app.ticker.maxFPS, 15);
  assert.equal(app.renderer.resolution, 1);
  f.query.set(false);
  assert.equal(app.ticker.maxFPS, 0);
  assert.equal(app.renderer.resolution, 2);
  assert.equal(app.initCalls, 1);

  // Detached (the scene is being torn down), the app is left alone.
  f.gate.detach();
  applyOfficeMotionPref('reduced');
  assert.equal(app.ticker.maxFPS, 0);
  assert.equal(app.renderer.resolution, 2);
  f.gate.dispose();
});

test('a context-loss rebuild attaches a fresh app at the decision in force', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const f = gateUnderTest({ classification: 'hardware' });
  applyOfficeMotionPref('reduced');
  // The floor builds the replacement with gate.decision, so it is born at 1x.
  const rebuilt = fakeApp(f.gate.decision.resolution);
  rebuilt.ticker.maxFPS = f.gate.decision.maxFPS;
  f.gate.attach(rebuilt);
  assert.equal(rebuilt.ticker.maxFPS, 15);
  assert.deepEqual(rebuilt.resizes, []);
  f.gate.dispose();
});

test('dispose lets go of every listener and the timer', (t) => {
  t.after(() => applyOfficeMotionPref('auto'));
  const before = officeMotionPrefListenerCount();
  const f = gateUnderTest({ classification: 'software' });
  assert.equal(f.target.listenerCount, 2);
  assert.equal(f.query.listenerCount, 1);
  assert.equal(officeMotionPrefListenerCount(), before + 1);
  f.blur();
  assert.equal(f.clock.pendingCount, 1, 'blur on the reduced path should arm the grace');

  f.gate.dispose();
  assert.equal(f.target.listenerCount, 0);
  assert.equal(f.query.listenerCount, 0);
  assert.equal(officeMotionPrefListenerCount(), before);
  assert.equal(f.clock.pendingCount, 0, 'the grace timer outlived the gate');

  // Nothing after dispose reaches the verdict, whatever happens.
  const seen = f.verdicts.length;
  f.clock.advanceTo(1_000_000 + 600_000);
  applyOfficeMotionPref('reduced');
  f.query.set(true);
  assert.equal(f.verdicts.length, seen);
  f.gate.dispose(); // idempotent
});

// --- wiring: the floor reads the decision; config declares the setting ------------

test('OfficeFloor builds its renderer from the decision, attaches the gate, and never rebuilds for it', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  const i = src.indexOf('const motion = gateRef.current?.decision ?? currentOfficeMotion();');
  assert.ok(i > 0, 'the floor no longer asks the gate');
  const init = src.slice(i, src.indexOf('autoDensity: true', i));
  assert.match(init, /antialias: motion\.antialias,/);
  assert.match(init, /resolution: motion\.resolution,/);
  assert.doesNotMatch(init, /devicePixelRatio/, 'the dpr rule lives in officeMotion.ts now');
  assert.match(src, /app\.ticker\.maxFPS = motion\.maxFPS;/);
  assert.match(src, /gateRef\.current\?\.attach\(app\);/);
  assert.match(src, /gateRef\.current\?\.detach\(\);/);
  // A mode change is applied live, never by re-running the mount effect.
  assert.match(src, /\}, \[officeTheme, glGeneration, i18n\.language, released\]\);/);
  assert.doesNotMatch(src, /motionMode/, 'the mode is back in React state and a dep of the mount effect');
  // The gate is built once, over the real window/store, and wakes syncTicker.
  const g = src.indexOf('createOfficeMotionGate({');
  assert.ok(g > 0);
  const gateCall = src.slice(g, src.indexOf('});', g));
  assert.match(gateCall, /target: window,/);
  assert.match(gateCall, /hasFocus: \(\) => document\.hasFocus\(\),/);
  assert.doesNotMatch(gateCall, /agents/, 'the store must not be an input to the unattended pause');
  assert.match(gateCall, /onUnattendedChange: syncTicker/);
  assert.match(src, /gate\.dispose\(\);/);
  // Every ticker start/stop decision passes the unattended gate.
  assert.match(src, /unattended: gateRef\.current\?\.unattended \?\? false/);
  assert.doesNotMatch(src, /if \(pausedRef\.current\) app\.ticker\.stop\(\);/, 'init() must honour the unattended gate too');
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
