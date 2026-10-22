'use strict';

// Is anyone looking at the window? (scene/attention.ts) Two hooks the scenes'
// ambient effects gate on: the page visible and shown, and the window attended
// — focused, or blurred for less than the office's unattended grace. The
// planning is unattendedPauseDelay (office-motion tests); this pins the
// attended hook's wiring against a fake window and document.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { mount } = require('./render-hooks.cjs');

test('useWindowAttended: focused is attended; blurred becomes unattended after the grace; focus restores at once', () => {
  const listeners = new Map();
  let focused = true;
  const win = { addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
  const doc = { hidden: false, hasFocus: () => focused, addEventListener() {}, removeEventListener() {} };
  const timers = [];
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, window: globalThis.window, document: globalThis.document, now: Date.now };
  let now = 100_000;
  globalThis.setTimeout = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  globalThis.clearTimeout = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  globalThis.window = win; globalThis.document = doc; Date.now = () => now;
  try {
    const { useWindowAttended } = loadTs('src/renderer/src/scene/attention.ts');
    let seen;
    const Probe = () => { seen = useWindowAttended(30_000); return null; };
    // mount() runs the effects once; running them again would register a
    // second closure whose timer the mount-time cleanups cannot see.
    const m = mount(Probe, {});
    m.render?.();
    assert.equal(seen, true, 'focused at mount');
    assert.equal(timers.length, 0, 'no timer while focused');
    focused = false; now += 10; listeners.get('blur')(); m.render?.();
    assert.equal(seen, true, 'just blurred: still attended, inside the grace');
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms > 29_000 && timers[0].ms <= 30_000, `grace timer ${timers[0].ms}`);
    now += 30_000; timers.shift().fn(); m.render?.();
    assert.equal(seen, false, 'grace over: unattended');
    focused = true; listeners.get('focus')(); m.render?.();
    assert.equal(seen, true, 'focus restores attention at once');
    assert.equal(timers.length, 0);
    // Unmount mid-grace: the timer and both listeners go with the hook.
    focused = false; listeners.get('blur')();
    assert.equal(timers.length, 1);
    for (const fn of m.cleanups) fn && fn();
    assert.equal(timers.length, 0, 'the grace timer outlived the hook');
    assert.equal(listeners.size, 0, 'a listener outlived the hook');
  } finally {
    globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout;
    globalThis.window = real.window; globalThis.document = real.document; Date.now = real.now;
  }
});
