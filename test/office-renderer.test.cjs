'use strict';

// Which Pixi renderer the floor asks for. Throttling the floor (office-motion)
// left the GPU process at 2.6–4.5 cores on WSLg: with no hardware GPU every GL
// draw the floor makes is rasterised by SwiftShader worker threads in that
// process, at 15 fps or 60. Pixi 8.18's Canvas2D renderer keeps the drawing on
// the renderer's own thread with no WebGL context at all, so the floor asks
// for it on a software GPU and on the reduced path, and keeps WebGL on a real
// GPU. These pin the decision, the log line, that the floor and the study's
// ambiance layer pass the preference to Pixi, and that the WebGL recovery
// code stands down for a renderer with no context to lose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { chooseRenderer, describeRendererChoice } = loadTs('src/renderer/src/scene/office/officeRenderer.ts');
const { planInitFailure, usesWebglContext } = loadTs('src/renderer/src/scene/office/glRecovery.ts');

// --- the decision ------------------------------------------------------------------

test('a software GPU gets the canvas renderer whatever the mode', () => {
  for (const mode of ['full', 'reduced']) {
    const c = chooseRenderer(mode, 'software');
    assert.equal(c.preference, 'canvas', mode);
    assert.equal(c.reason, 'software GPU');
  }
});

test('the reduced path gets the canvas renderer on any GPU; the full path keeps WebGL', () => {
  for (const cls of ['hardware', 'unknown']) {
    assert.equal(chooseRenderer('reduced', cls).preference, 'canvas', `reduced/${cls}`);
    assert.equal(chooseRenderer('reduced', cls).reason, 'reduced motion');
    assert.equal(chooseRenderer('full', cls).preference, 'webgl', `full/${cls}`);
  }
  assert.equal(chooseRenderer('full', 'hardware').reason, 'hardware GPU');
  assert.match(chooseRenderer('full', 'unknown').reason, /unknown/, "a masked renderer string must not be called hardware");
});

test('the log line names the scene, the renderer built, the mode and the reason', () => {
  assert.equal(
    describeRendererChoice('office', 'canvas', 'reduced', chooseRenderer('reduced', 'software')),
    '[office] pixi renderer: canvas (reduced, software GPU)');
  assert.equal(
    describeRendererChoice('office', 'webgl', 'full', chooseRenderer('full', 'hardware')),
    '[office] pixi renderer: webgl (full, hardware GPU)');
  // Pixi fell through its preference list: say what was asked for.
  assert.equal(
    describeRendererChoice('study', 'canvas', 'full', chooseRenderer('full', 'hardware')),
    '[study] pixi renderer: canvas (full, hardware GPU; asked for webgl)');
});

// --- recovery stands down without a WebGL context ------------------------------------

test('only a WebGL renderer has a context to lose', () => {
  assert.equal(usesWebglContext({ name: 'webgl' }), true);
  assert.equal(usesWebglContext({ name: 'canvas' }), false);
  assert.equal(usesWebglContext({ name: 'webgpu' }), false);
  assert.equal(usesWebglContext(null), false);
  assert.equal(usesWebglContext(undefined), false);
  assert.equal(usesWebglContext({}), false);
});

test('an init failure on the canvas renderer is reported, never retried as a context wait', () => {
  const contextErr = new Error('This browser does not support WebGL. Try using the canvas renderer');
  // Today's WebGL behaviour, untouched.
  assert.deepEqual(planInitFailure(contextErr, 0), { action: 'retry', delayMs: 1500, attempt: 1 });
  assert.deepEqual(planInitFailure(contextErr, 0, { renderer: 'webgl' }), { action: 'retry', delayMs: 1500, attempt: 1 });
  // No GPU process restart can be behind a Canvas2D failure: there is nothing to wait for.
  assert.deepEqual(planInitFailure(contextErr, 0, { renderer: 'canvas' }), { action: 'report' });
  assert.deepEqual(planInitFailure(new Error('No available renderer for the current environment'), 0, { renderer: 'canvas' }), { action: 'report' });
  // And it never loops: the budget is irrelevant on canvas.
  assert.deepEqual(planInitFailure(contextErr, 99, { renderer: 'canvas' }), { action: 'report' });
});

// --- wiring ------------------------------------------------------------------------------

test('OfficeFloor passes the preference to init, logs the choice once, and guards the loss listener', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  const i = src.indexOf('const renderer = chooseRenderer(motion.mode, webglRendererInfo().classification);');
  assert.ok(i > 0, 'the floor does not choose a renderer from the mode and the probe');
  const init = src.slice(i, src.indexOf('autoDensity: true', i));
  assert.match(init, /await app\.init\(\{\s*preference: renderer\.preference,/, 'preference must be an init option');
  assert.match(src, /console\.info\(describeRendererChoice\('office', app\.renderer\.name, motion\.mode, renderer\)\);/);
  assert.match(src, /if \(usesWebglContext\(app\.renderer\)\) \(app as any\)\.__glRecovery = installContextLossRecovery\(/,
    'the loss listener must be skipped on a renderer with no WebGL context');
  assert.match(src, /planInitFailure\(err, initRetriesRef\.current, \{ renderer: preference \}\)/,
    'the failure planner must know which renderer was asked for');
});
