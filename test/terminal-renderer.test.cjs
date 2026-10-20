'use strict';

// The WebGL-vs-DOM lease decision for terminals. On a software GPU (SwiftShader
// on WSL2/WSLg, llvmpipe in a VM) the WebGL addon costs CPU cores for nothing,
// so the pool consults this before taking a lease. These pin the classification
// rule, the three-way setting, and the fact that the pool actually asks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// Loads with no `window`/`document` in scope: the probe must be lazy.
const {
  classifyWebglRenderer, shouldLeaseWebgl, SOFTWARE_WEBGL_RE,
  getTerminalRendererPref, setTerminalRendererPref
} = loadTs('src/renderer/src/components/terminalRenderer.ts');

// --- classification ----------------------------------------------------------

test('software rasterizers are classified as software', () => {
  for (const s of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)',
    'softpipe',
    'Mesa OffScreen',
    'Software Rasterizer',
    'ANGLE (Mesa, Mesa Offscreen, OpenGL 4.5)'
  ]) {
    assert.equal(classifyWebglRenderer(s), 'software', s);
  }
});

test('real GPUs are classified as hardware', () => {
  for (const s of [
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
    'Apple M1',
    'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
    'AMD Radeon Pro 5500M OpenGL Engine',
    'Mali-G78 MP20',
    'Adreno (TM) 740'
  ]) {
    assert.equal(classifyWebglRenderer(s), 'hardware', s);
  }
});

test('no renderer string is unknown, never software', () => {
  assert.equal(classifyWebglRenderer(null), 'unknown');
  assert.equal(classifyWebglRenderer(''), 'unknown');
  assert.equal(classifyWebglRenderer('   '), 'unknown');
});

test('the regex is the documented one', () => {
  assert.equal(SOFTWARE_WEBGL_RE.source, 'swiftshader|llvmpipe|softpipe|software|mesa offscreen');
  assert.ok(SOFTWARE_WEBGL_RE.flags.includes('i'));
});

// --- the setting ---------------------------------------------------------------

test("'auto' leases on hardware and on unknown, and skips only on software", () => {
  assert.equal(shouldLeaseWebgl('auto', 'hardware'), true);
  assert.equal(shouldLeaseWebgl('auto', 'unknown'), true, 'unknown must preserve today\'s behaviour');
  assert.equal(shouldLeaseWebgl('auto', 'software'), false);
  // An absent setting (older config.json) is 'auto'.
  assert.equal(shouldLeaseWebgl(undefined, 'software'), false);
  assert.equal(shouldLeaseWebgl(undefined, 'hardware'), true);
});

test("'dom' never leases, 'webgl' always does, whatever the probe said", () => {
  for (const c of ['hardware', 'software', 'unknown']) {
    assert.equal(shouldLeaseWebgl('dom', c), false, `dom/${c}`);
    assert.equal(shouldLeaseWebgl('webgl', c), true, `webgl/${c}`);
  }
});

test('the mirrored setting defaults to auto, normalises junk, and reports change', () => {
  assert.equal(getTerminalRendererPref(), 'auto');
  assert.equal(setTerminalRendererPref('auto'), false, 'same value is not a change');
  assert.equal(setTerminalRendererPref('dom'), true);
  assert.equal(getTerminalRendererPref(), 'dom');
  assert.equal(setTerminalRendererPref('bogus'), true, 'junk falls back to auto');
  assert.equal(getTerminalRendererPref(), 'auto');
  assert.equal(setTerminalRendererPref(undefined), false);
  assert.equal(getTerminalRendererPref(), 'auto');
});

// --- wiring: the pool asks before it leases -----------------------------------

test('leaseWebglRenderer consults the decision before constructing the addon', () => {
  const src = strip(read('src/renderer/src/components/terminalPool.ts'));
  const i = src.indexOf('function leaseWebglRenderer(');
  assert.ok(i > 0, 'leaseWebglRenderer is gone');
  const body = src.slice(i, src.indexOf('new WebglAddon()', i));
  assert.match(body, /if \(!wantsWebglRenderer\(\)\) return;/, 'the lease no longer asks');
});

test('the config default is auto and every mirror declares the setting', () => {
  assert.match(read('src/main/config.ts'), /terminalRenderer: 'auto',/);
  for (const f of ['src/main/config.ts', 'src/preload/index.ts', 'src/renderer/src/store/config.ts']) {
    assert.match(read(f), /terminalRenderer\?: 'auto' \| 'dom' \| 'webgl';/, f);
  }
});

test('App mirrors the setting into the pool on load and on every change', () => {
  const app = strip(read('src/renderer/src/App.tsx'));
  const calls = app.match(/applyTerminalRendererPref\(c\.terminalRenderer\)/g) ?? [];
  assert.equal(calls.length, 2, 'initial load + onConfigChanged');
});

test('Settings stages the setting instead of writing it', () => {
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(modal, /stage\(\{ terminalRenderer: next \}\)/);
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  for (const k of ['terminalRenderer', 'terminalRendererDesc', 'terminalRendererAuto',
                   'terminalRendererDom', 'terminalRendererWebgl']) {
    assert.equal(typeof en.settings.general[k], 'string', `en: settings.general.${k}`);
  }
});
