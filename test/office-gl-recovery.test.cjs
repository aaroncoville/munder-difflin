/**
 * The blank-office bug.
 *
 * Chromium caps live WebGL contexts per renderer process (~16) and evicts the
 * OLDEST when a new one pushes past the cap. The office floor's context is
 * created at app startup, so it is always the oldest; every terminal xterm opens
 * takes another one (@xterm/addon-webgl). On a busy floor the office is evicted,
 * Pixi says nothing at all, and the canvas is blank until the app restarts.
 *
 * CONFIRMED against the shipped v0.3.5 build over CDP: creating 24 extra WebGL
 * contexts produced "WARNING: Too many active WebGL contexts. Oldest context will
 * be lost." and fired `webglcontextlost` on the office canvas, while the terminal
 * logged its own graceful "[terminal] webgl context lost — falling back to DOM
 * renderer". The office had no such fallback. These tests pin the one it has now.
 */
const test = require('node:test');
const assert = require('node:assert');
const load = require('./load-ts.cjs');

const {
  installContextLossRecovery, DEFAULT_MAX_REBUILDS, DEFAULT_REBUILD_DELAY_MS,
  isContextUnavailableError, planInitFailure, DEFAULT_MAX_INIT_RETRIES
} = load('src/renderer/src/scene/office/glRecovery.ts');

/** A canvas stand-in: EventTarget is all the recovery code touches. */
function fakeCanvas() { return new EventTarget(); }
function lose(canvas) {
  // cancelable so defaultPrevented actually reports whether preventDefault ran —
  // that call is what allows the browser to hand the context back at all.
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
}
/** Collect scheduled callbacks instead of waiting on real timers. */
function fakeClock() {
  const queue = [];
  return {
    schedule: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    runAll: () => { const q = queue.splice(0); q.forEach((j) => j.fn()); return q; },
    get pending() { return queue.length; },
    get delays() { return queue.map((j) => j.ms); }
  };
}

test('a lost context rebuilds the scene instead of leaving it blank', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0;
  installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {} });

  lose(canvas);
  assert.equal(rebuilds, 0, 'rebuild must be deferred, not immediate');
  assert.equal(clock.pending, 1);
  clock.runAll();
  assert.equal(rebuilds, 1, 'the scene never came back');
});

test('preventDefault is called — without it the context is gone for good', () => {
  const canvas = fakeCanvas();
  installContextLossRecovery(canvas, { onRebuild: () => {}, schedule: () => {}, log: () => {} });
  assert.equal(lose(canvas).defaultPrevented, true);
});

test('the rebuild is delayed so it does not race the eviction storm', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  installContextLossRecovery(canvas, { onRebuild: () => {}, schedule: clock.schedule, log: () => {} });
  lose(canvas);
  // Several contexts are usually created at once; claiming one straight back
  // just loses it again to the next terminal in the same burst.
  assert.ok(clock.delays[0] >= 500, `rebuild delay too short: ${clock.delays[0]}`);
  assert.equal(clock.delays[0], DEFAULT_REBUILD_DELAY_MS);
});

test('retries are capped, then it gives up LOUDLY rather than staying blank', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0, gaveUp = 0;
  const logs = [];
  installContextLossRecovery(canvas, {
    onRebuild: () => rebuilds++, onGiveUp: () => gaveUp++,
    schedule: clock.schedule, log: (m) => logs.push(m)
  });

  for (let i = 0; i < DEFAULT_MAX_REBUILDS; i++) { lose(canvas); clock.runAll(); }
  assert.equal(rebuilds, DEFAULT_MAX_REBUILDS);
  assert.equal(gaveUp, 0, 'gave up while it still had budget');

  lose(canvas);
  clock.runAll();
  assert.equal(gaveUp, 1, 'a silently blank canvas is the bug — it must surface');
  assert.equal(rebuilds, DEFAULT_MAX_REBUILDS, 'kept rebuilding past the cap');

  // And it stays given-up: no infinite fight for a context we cannot keep.
  lose(canvas); clock.runAll();
  assert.equal(gaveUp, 1);
  assert.equal(rebuilds, DEFAULT_MAX_REBUILDS);
  assert.ok(logs.some((m) => /giving up/i.test(m)), 'nothing explains the blank floor');
});

test('uninstalling stops recovery — a torn-down scene must not resurrect itself', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0;
  const off = installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {} });

  // Loss already in flight when the component unmounts: the queued rebuild must
  // not fire against a destroyed Pixi app.
  lose(canvas);
  off();
  clock.runAll();
  assert.equal(rebuilds, 0, 'rebuilt after teardown');

  lose(canvas);
  assert.equal(clock.pending, 0, 'still listening after uninstall');
});

/**
 * The blank-office bug, second half: losing the context is survivable, but
 * NOT GETTING ONE IN THE FIRST PLACE was fatal.
 *
 * installContextLossRecovery() is wired up AFTER `app.init()` resolves, so it
 * never sees the case where the REBUILD it schedules cannot get a context
 * either. When the GPU process dies (a driver reset, a TDR, a Chromium GPU
 * crash) the floor loses its context, the rebuild fires 1500ms later, and the
 * GPU process is still coming back. getContext() returns null and Pixi throws
 *
 *   Error: This browser does not support WebGL. Try using the canvas renderer
 *       at _GlContextSystem.createContext (WebGLRenderer...)
 *       at async _Application.init (index...)
 *
 * which OfficeFloor painted onto the floor as a wall of minified frames, where
 * it stayed until the whole app was restarted. The browser supports WebGL
 * perfectly well; it just asked a second too early.
 *
 * CONFIRMED against the shipped v0.4.5 build over CDP on Windows/Intel UHD by
 * killing the app's --type=gpu-process out from under a live floor: it logged
 * the rebuild, and the rebuild produced exactly the stack above.
 *
 * Eviction pressure alone does NOT get here, which is why this is a separate
 * failure and not the one above: a getContext() that pushes past the ~16-context
 * cap evicts somebody else and succeeds, so the rebuild always wins its slot
 * back. Verified the same way — 24 held contexts plus a steady drip produced
 * eviction, a rebuild, and a healthy floor.
 */

test('Pixi\'s "does not support WebGL" is read as a busy GPU, not a dead browser', () => {
  // The verbatim message Pixi 8 throws out of GlContextSystem.createContext.
  assert.equal(isContextUnavailableError(
    new Error('This browser does not support WebGL. Try using the canvas renderer')), true);
  // Wording varies across Pixi/Chromium versions, so match the family.
  assert.equal(isContextUnavailableError(new Error('WebGL not supported')), true);
  assert.equal(isContextUnavailableError(new Error('WebGPU is not available')), true);
  assert.equal(isContextUnavailableError(new Error('Unable to create a WebGL context')), true);
  assert.equal(isContextUnavailableError(new Error('Failed to get rendering context')), true);
  // Wrapped by a caller that added its own framing.
  assert.equal(isContextUnavailableError(
    new Error('renderer boot failed', { cause: new Error('WebGL not supported') })), true);
});

test('a broken theme or texture is NOT mistaken for a busy GPU', () => {
  // Retrying these would just hide a real bug behind a 6-second delay.
  assert.equal(isContextUnavailableError(new Error('failed to load tileset office.png')), false);
  assert.equal(isContextUnavailableError(new Error('theme bundle is malformed')), false);
  assert.equal(isContextUnavailableError(new TypeError('map.tilesets is not iterable')), false);
  assert.equal(isContextUnavailableError(undefined), false);
  assert.equal(isContextUnavailableError(null), false);
});

test('an init that could not get a context retries instead of printing a stack', () => {
  const err = new Error('This browser does not support WebGL. Try using the canvas renderer');
  const plan = planInitFailure(err, 0);
  assert.equal(plan.action, 'retry', 'a stack trace on the floor is the bug');
  assert.equal(plan.attempt, 1);
  // Same reasoning as the rebuild delay: contexts free up as terminals close,
  // and asking again inside the same burst just fails again.
  assert.ok(plan.delayMs >= 500, `init retry delay too short: ${plan.delayMs}`);
  assert.equal(plan.delayMs, DEFAULT_REBUILD_DELAY_MS);
});

test('init retries are capped, then it says something a human can act on', () => {
  const err = new Error('This browser does not support WebGL. Try using the canvas renderer');
  for (let used = 0; used < DEFAULT_MAX_INIT_RETRIES; used++) {
    assert.equal(planInitFailure(err, used).action, 'retry', `gave up with budget left (used ${used})`);
    assert.equal(planInitFailure(err, used).attempt, used + 1);
  }
  assert.equal(planInitFailure(err, DEFAULT_MAX_INIT_RETRIES).action, 'give-up');
  assert.equal(planInitFailure(err, DEFAULT_MAX_INIT_RETRIES + 9).action, 'give-up');
});

test('a real init bug is reported immediately and never retried', () => {
  const bug = new TypeError('map.tilesets is not iterable');
  assert.equal(planInitFailure(bug, 0).action, 'report');
  // Still 'report' deep into the budget: retry count must not turn a bug into a
  // "close some terminals" message that sends the user chasing the wrong thing.
  assert.equal(planInitFailure(bug, DEFAULT_MAX_INIT_RETRIES).action, 'report');
});

test('recovery survives repeated losses across rebuilds, one budget per install', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let rebuilds = 0;
  installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {}, maxRebuilds: 1 });
  lose(canvas); clock.runAll();
  assert.equal(rebuilds, 1);
  // A fresh install (what the next mount does) gets its own budget.
  const canvas2 = fakeCanvas();
  installContextLossRecovery(canvas2, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {}, maxRebuilds: 1 });
  lose(canvas2); clock.runAll();
  assert.equal(rebuilds, 2);
});

/* ── Drawing into a context that is gone ──────────────────────────────────────
 *
 * Cancelling the loss and rebuilding 1500ms later leaves a gap, and the render
 * loop went on running across it: every frame issued GL calls against a context
 * the GPU process no longer backs, which Chromium answers one error per call —
 *
 *   GL_INVALID_OPERATION: Invalid mailbox / texture is not a shared image
 *   SharedImageManager::ProduceGLTexturePassthrough: non-existent mailbox
 *
 * The gap is unbounded once the retry budget is spent: the recovery stops
 * rebuilding but nothing ever stopped the loop, so a floor that has given up
 * spams for as long as the app is open. Observed on v0.4.6 as an apparent hang,
 * with two hours of that logging behind it.
 */

const { shouldRunTicker } = load('src/renderer/src/scene/office/glRecovery.ts');

test('the render loop is halted the moment the context is lost, not when the rebuild lands', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  const calls = [];
  installContextLossRecovery(canvas, {
    onRebuild: () => calls.push('rebuild'),
    onSuspend: () => calls.push('suspend'),
    schedule: clock.schedule, log: () => {}
  });

  lose(canvas);
  assert.deepEqual(calls, ['suspend'],
    'drawing must stop synchronously — the debounce is 1500ms of GL calls otherwise');
  clock.runAll();
  assert.deepEqual(calls, ['suspend', 'rebuild']);
});

test('giving up still halts the loop — that is the unbounded case', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let suspends = 0, gaveUp = false;
  installContextLossRecovery(canvas, {
    onRebuild: () => {}, onSuspend: () => suspends++,
    onGiveUp: () => { gaveUp = true; },
    maxRebuilds: 1, schedule: clock.schedule, log: () => {}
  });

  lose(canvas); clock.runAll();   // first loss: rebuilds
  lose(canvas);                   // second: budget spent, recovery stands down
  assert.equal(gaveUp, true, 'the fixture must reach the give-up branch');

  // THE case. Once the budget is spent the recovery stops acting on losses, and
  // it is precisely then that nothing else will ever stop the loop — so a loss
  // arriving after we have given up still has to halt drawing. Asserting only
  // the count above passes just as well when the suspend sits behind the
  // stood-down guard, which is the bug.
  lose(canvas);
  assert.equal(suspends, 3, 'a floor that has given up must still stop drawing');
});

test('every loss halts the loop, not just the first', () => {
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let suspends = 0;
  installContextLossRecovery(canvas, {
    onRebuild: () => {}, onSuspend: () => suspends++, schedule: clock.schedule, log: () => {}
  });

  lose(canvas); clock.runAll();
  lose(canvas); clock.runAll();
  assert.equal(suspends, 2);
});

test('a floor whose context is dead does not resume when it is uncovered', () => {
  // The floor also stops its ticker while a fullscreen terminal or the editor
  // covers it, and starts it again when they close. That switch runs on its own
  // and knew nothing about a lost context, so leaving focus mode would restart
  // the loop over a dead context and the spam would come back.
  assert.equal(shouldRunTicker({ paused: false, contextLost: false }), true);
  assert.equal(shouldRunTicker({ paused: true, contextLost: false }), false);
  assert.equal(shouldRunTicker({ paused: false, contextLost: true }), false,
    'uncovering the floor must not restart drawing into a context that is gone');
  assert.equal(shouldRunTicker({ paused: true, contextLost: true }), false);
});
