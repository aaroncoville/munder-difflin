'use strict';

// The WebGL-vs-DOM lease decision for terminals. On a software GPU (SwiftShader
// on WSL2/WSLg, WARP on a Windows VM, llvmpipe in a Linux VM) the WebGL addon
// costs CPU cores for nothing, so the pool consults this before taking a lease.
//
// Two layers. The pure half (classification, the three-way setting) is loaded
// straight from TypeScript through test/load-ts.cjs. The behavioural half loads
// the REAL terminalPool.ts the same way, with the xterm packages replaced in
// require.cache (the house pattern study-ambiance.test.cjs uses for pixi) and a
// fake `document`/`window.cth`, so the lease, the release and the once-only
// probe are exercised rather than grepped for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const RENDERER_TS = 'src/renderer/src/components/terminalRenderer.ts';
const POOL_TS = 'src/renderer/src/components/terminalPool.ts';

// Loads with no `window`/`document` in scope: the probe must be lazy.
const {
  classifyWebglRenderer, shouldLeaseWebgl, SOFTWARE_WEBGL_RE,
  getTerminalRendererPref, setTerminalRendererPref
} = loadTs(RENDERER_TS);

// --- classification ----------------------------------------------------------

const SOFTWARE_STRINGS = [
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  'Google SwiftShader',
  'llvmpipe (LLVM 15.0.7, 256 bits)',
  'Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)',
  'softpipe',
  'Mesa OffScreen',
  'Software Rasterizer',
  'ANGLE (Mesa, Mesa Offscreen, OpenGL 4.5)',
  // WARP: Direct3D's software rasterizer, what a Windows VM / RDP session gets.
  'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Microsoft Basic Render Driver',
  'ANGLE (Microsoft, WARP Direct3D11 vs_5_0 ps_5_0, D3D11)'
];

const HARDWARE_STRINGS = [
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'NVIDIA GeForce GTX 1080/PCIe/SSE2',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
  'Mesa Intel(R) Xe Graphics (TGL GT2)',
  'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
  'Apple M2',
  'Apple M1',
  'AMD Radeon Pro 5500M OpenGL Engine',
  'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Mali-G78 MP20',
  'Adreno (TM) 740',
  // The letters of "warp" inside a longer word are not WARP.
  'Warpspeed Graphics Adapter'
];

test('software rasterizers are classified as software', () => {
  for (const s of SOFTWARE_STRINGS) assert.equal(classifyWebglRenderer(s), 'software', s);
});

test('real GPUs are classified as hardware', () => {
  for (const s of HARDWARE_STRINGS) assert.equal(classifyWebglRenderer(s), 'hardware', s);
});

test('no renderer string is unknown, never software', () => {
  assert.equal(classifyWebglRenderer(null), 'unknown');
  assert.equal(classifyWebglRenderer(''), 'unknown');
  assert.equal(classifyWebglRenderer('   '), 'unknown');
});

test('the regex is the documented one', () => {
  assert.equal(SOFTWARE_WEBGL_RE.source,
    'swiftshader|llvmpipe|softpipe|software|mesa offscreen|microsoft basic render|\\bwarp\\b');
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

// --- the probe, against a fake canvas ------------------------------------------

/** A `document` whose canvases hand out the WebGL you describe.
 *  mode: 'none' (no WebGL), 'masked' (no debug extension), 'throws'
 *  (getParameter explodes), or a renderer string. */
function fakeDocument(mode) {
  const stats = { canvases: 0, loseContext: 0, getParameter: 0 };
  const gl = {
    RENDERER: 0x1f01,
    getExtension(name) {
      if (name === 'WEBGL_lose_context') return { loseContext: () => { stats.loseContext++; } };
      if (name === 'WEBGL_debug_renderer_info') {
        return (mode === 'masked' || mode === 'none') ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return null;
    },
    getParameter(p) {
      stats.getParameter++;
      if (mode === 'throws') throw new Error('context lost mid-probe');
      if (p === 0x9246) return mode;
      if (p === 0x9245) return 'Vendor';
      if (p === 0x1f01) return 'WebKit WebGL'; // Chromium's masked RENDERER
      return null;
    }
  };
  return {
    stats,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      stats.canvases++;
      return { getContext: () => (mode === 'none' ? null : gl) };
    }
  };
}

/** A FRESH terminalRenderer module probing against `doc`. */
function freshRenderer(doc) {
  globalThis.document = doc;
  const mod = loadTs.fresh(RENDERER_TS);
  return mod;
}

test('the probe runs once per process and caches its answer', () => {
  const doc = fakeDocument('Google SwiftShader');
  const mod = freshRenderer(doc);
  const a = mod.webglRendererInfo();
  const b = mod.webglRendererInfo();
  assert.equal(a, b, 'the cached object is returned, not re-probed');
  assert.equal(doc.stats.canvases, 1, 'exactly one probe canvas');
  assert.deepEqual(a, { classification: 'software', renderer: 'Google SwiftShader', vendor: 'Vendor' });
  // And the decision follows it.
  assert.equal(mod.wantsWebglRenderer(), false);
  assert.equal(doc.stats.canvases, 1, 'wantsWebglRenderer does not probe again');
});

test('the probe context is released on every path', () => {
  // Success.
  let doc = fakeDocument('Apple M2');
  assert.equal(freshRenderer(doc).webglRendererInfo().classification, 'hardware');
  assert.equal(doc.stats.loseContext, 1, 'success path releases the context');
  // Debug extension masked: unknown, still released.
  doc = fakeDocument('masked');
  assert.deepEqual(freshRenderer(doc).webglRendererInfo(),
    { classification: 'unknown', renderer: null, vendor: null });
  assert.equal(doc.stats.loseContext, 1, 'masked path releases the context');
  // getParameter throws: unknown, still released, nothing escapes.
  doc = fakeDocument('throws');
  assert.equal(freshRenderer(doc).webglRendererInfo().classification, 'unknown');
  assert.equal(doc.stats.loseContext, 1, 'exception path releases the context');
});

test('no WebGL at all is unknown, and unknown keeps the lease', () => {
  const doc = fakeDocument('none');
  const mod = freshRenderer(doc);
  assert.deepEqual(mod.webglRendererInfo(), { classification: 'unknown', renderer: null, vendor: null });
  assert.equal(doc.stats.loseContext, 0, 'nothing to release');
  assert.equal(mod.wantsWebglRenderer(), true, "'auto' on unknown leases as before");
});

test('the software skip is logged once, with the renderer string', () => {
  const mod = freshRenderer(fakeDocument('llvmpipe (LLVM 15.0.7, 256 bits)'));
  const lines = [];
  const orig = console.info;
  console.info = (msg) => lines.push(msg);
  try {
    assert.equal(mod.wantsWebglRenderer(), false);
    assert.equal(mod.wantsWebglRenderer(), false);
    assert.equal(mod.wantsWebglRenderer(), false);
  } finally { console.info = orig; }
  assert.equal(lines.length, 1);
  assert.equal(lines[0],
    '[terminal] webgl renderer skipped: software GPU (llvmpipe (LLVM 15.0.7, 256 bits)) — using DOM renderer');
});

// --- the pool: lease, release and switch, with the real terminalPool.ts --------

/** Stand an npm package in with `exports`, the way study-ambiance does for pixi. */
function stubPackage(request, exports) {
  const file = require.resolve(request);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

/** What the pool creates per terminal. Everything it calls is a no-op unless
 *  listed, so an unrelated refactor of the pool does not break the lease tests
 *  by calling something new on the terminal. */
function fakeTerminal() {
  const addons = [];
  const target = {
    addons,
    options: { fontFamily: 'JetBrains Mono', fontSize: 14 },
    rows: 24,
    cols: 80,
    element: null,
    unicode: { activeVersion: '6' },
    buffer: { active: { viewportY: 0, baseY: 0, getLine: () => null } },
    parser: {
      registerOscHandler: () => ({ dispose() {} }),
      registerCsiHandler: () => ({ dispose() {} }),
      registerDcsHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} })
    },
    loadAddon(a) { addons.push(a); a.activate?.(this); },
    open(host) { this.element = host; },
    registerCharacterJoiner: () => 1,
    hasSelection: () => false,
    getSelection: () => ''
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return () => ({ dispose() {} });
    }
  });
}

/** The one addon under test. Each instance records whether it was loaded and
 *  disposed, and keeps the context-loss handler so a test could fire it. */
class FakeWebglAddon {
  static instances = [];
  constructor() { this.loaded = false; this.disposed = 0; this.lossHandler = null; FakeWebglAddon.instances.push(this); }
  onContextLoss(cb) { this.lossHandler = cb; }
  activate() { this.loaded = true; }
  dispose() { this.disposed++; }
}

/** Enough of an element for the pool: parenting, `isConnected`, a size, and the
 *  canvas query the lease teardown runs. Sized 0×0 so repaint-after-switch
 *  takes its "not laid out yet" branch, which is the honest state in node. */
function fakeElement() {
  return {
    style: {}, parentElement: null, children: [], connectedRoot: false,
    classList: { add() {}, remove() {} },
    get isConnected() { return this.connectedRoot || !!this.parentElement?.isConnected; },
    clientWidth: 0, clientHeight: 0,
    appendChild(c) { c.parentElement = this; this.children.push(c); },
    removeChild(c) { c.parentElement = null; this.children = this.children.filter((x) => x !== c); },
    remove() { this.parentElement?.removeChild(this); },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => []
  };
}

function fakeCth() {
  const noop = () => {};
  const unsub = () => noop;
  return {
    onPtyData: unsub, onPtyExit: unsub, onPtyRelaunch: unsub,
    writePty: async () => {}, redrawPty: async () => {}, resizePty: async () => {},
    copyToClipboard: async () => {}, readClipboard: async () => '', trackMessageSent: async () => {}
  };
}

/** Load a fresh pool + renderer pair against a document whose WebGL reports
 *  `renderer`. The xterm packages are replaced for the process (they cannot
 *  load in node anyway — addon-fit needs `self`), the Arabic modules are stubbed
 *  so the Arabic gate stays off, and `document`/`window` are the fakes above. */
function bootPool(renderer) {
  loadTs.reset();
  FakeWebglAddon.instances = [];
  stubPackage('@xterm/xterm', { Terminal: function Terminal() { return fakeTerminal(); } });
  stubPackage('@xterm/addon-fit', { FitAddon: class { fit() {} activate() {} } });
  stubPackage('@xterm/addon-unicode11', { Unicode11Addon: class { activate() {} } });
  stubPackage('@xterm/addon-webgl', { WebglAddon: FakeWebglAddon });
  stubPackage('@xterm/xterm/css/xterm.css', {});
  loadTs.stub('src/renderer/src/terminal/arabicSetting.ts', { isArabicTerminalEnabled: () => false });
  loadTs.stub('src/renderer/src/terminal/arabicJoiner.ts', { arabicJoinRanges: () => [] });
  loadTs.stub('src/renderer/src/terminal/arabicSpacingFix.ts', { attachArabicSpacingFix: () => () => {} });
  const doc = fakeDocument(renderer);
  doc.createElement = ((orig) => (tag) => (tag === 'canvas' ? orig.call(doc, tag) : fakeElement()))(doc.createElement);
  globalThis.document = doc;
  globalThis.window = { cth: fakeCth() };
  globalThis.requestAnimationFrame = (cb) => { setTimeout(cb, 0); return 1; };
  const rendererMod = loadTs(RENDERER_TS);
  const pool = loadTs(POOL_TS);
  const container = fakeElement();
  container.connectedRoot = true;
  return { pool, rendererMod, doc, container, addons: FakeWebglAddon.instances };
}

test('on a real GPU, attach leases WebGL once and detach releases it', () => {
  const { pool, container, addons } = bootPool('Apple M2');
  const a = pool.acquireTerminal('pty-a');
  assert.equal(a.webgl, undefined, 'no lease before attach');
  pool.attachTerminal(a, container);
  assert.equal(addons.length, 1, 'one addon constructed');
  assert.equal(a.webgl, addons[0]);
  assert.equal(addons[0].loaded, true, 'and loaded into the terminal');
  pool.attachTerminal(a, container);
  assert.equal(addons.length, 1, 're-attach does not double-lease');
  pool.detachTerminal(a, container);
  assert.equal(a.webgl, undefined, 'detach drops the lease');
  assert.equal(addons[0].disposed, 1, 'and disposes the addon exactly once');
});

test('on a software GPU, attach keeps the DOM renderer and leases nothing', () => {
  const { pool, container, addons, doc } = bootPool('Google SwiftShader');
  const a = pool.acquireTerminal('pty-a');
  const b = pool.acquireTerminal('pty-b');
  pool.attachTerminal(a, container);
  pool.attachTerminal(b, container);
  assert.equal(addons.length, 0, 'no WebglAddon was ever constructed');
  assert.equal(a.webgl, undefined);
  assert.equal(b.webgl, undefined);
  assert.equal(doc.stats.canvases, 1, 'the probe ran once for both terminals');
});

test('with no WebGL available, the lease is attempted as before', () => {
  const { pool, container, addons } = bootPool('none');
  const a = pool.acquireTerminal('pty-a');
  pool.attachTerminal(a, container);
  assert.equal(addons.length, 1, "unknown classification leases under 'auto'");
  assert.equal(a.webgl, addons[0]);
});

test('switching the setting moves an on-screen terminal DOM<->WebGL exactly once', () => {
  const { pool, container, addons } = bootPool('Apple M2');
  const onScreen = pool.acquireTerminal('pty-on');
  const offScreen = pool.acquireTerminal('pty-off');
  pool.attachTerminal(onScreen, container);
  pool.attachTerminal(offScreen, container);
  pool.detachTerminal(offScreen, container); // opened once, now off screen
  assert.equal(addons.length, 2);
  assert.ok(onScreen.webgl, 'on-screen terminal holds a lease');
  assert.equal(offScreen.webgl, undefined, 'off-screen terminal released its lease on detach');

  // -> dom: the on-screen lease is released, exactly once.
  pool.applyTerminalRendererPref('dom');
  assert.equal(onScreen.webgl, undefined, "'dom' releases the lease");
  assert.equal(addons[0].disposed, 1, 'disposed once');
  assert.equal(addons.length, 2, 'nothing new constructed');
  pool.applyTerminalRendererPref('dom');
  assert.equal(addons[0].disposed, 1, 'repeating the same setting is a no-op');

  // -> webgl: the on-screen terminal gets ONE new lease; the detached one none.
  pool.applyTerminalRendererPref('webgl');
  assert.equal(addons.length, 3, 'one addon constructed for the one on-screen terminal');
  assert.equal(onScreen.webgl, addons[2]);
  assert.equal(addons[2].loaded, true);
  assert.equal(offScreen.webgl, undefined, 'a detached terminal is not leased');
  pool.applyTerminalRendererPref('webgl');
  pool.notifyTerminalRendererChangeAll();
  assert.equal(addons.length, 3, 'neither a repeat nor a direct notify double-leases');
  assert.equal(onScreen.webgl, addons[2], 'the existing lease is kept');

  // And the detached terminal takes its lease the normal way, on attach.
  pool.attachTerminal(offScreen, container);
  assert.equal(addons.length, 4);
  assert.equal(offScreen.webgl, addons[3]);
});

test("'webgl' overrides a software GPU, and 'auto' takes it back", () => {
  const { pool, container, addons } = bootPool('Google SwiftShader');
  const a = pool.acquireTerminal('pty-a');
  pool.attachTerminal(a, container);
  assert.equal(addons.length, 0);
  pool.applyTerminalRendererPref('webgl');
  assert.equal(addons.length, 1, 'forced on: leased');
  assert.equal(a.webgl, addons[0]);
  pool.applyTerminalRendererPref('auto');
  assert.equal(a.webgl, undefined, 'back to auto on a software GPU: released');
  assert.equal(addons[0].disposed, 1);
  assert.equal(addons.length, 1);
});

// --- wiring that the behavioural tests cannot see ---------------------------------

test('the config default is auto and every mirror declares the setting', () => {
  assert.match(read('src/main/config.ts'), /terminalRenderer: 'auto',/);
  for (const f of ['src/main/config.ts', 'src/preload/index.ts', 'src/renderer/src/store/config.ts']) {
    assert.match(read(f), /terminalRenderer\?: 'auto' \| 'dom' \| 'webgl';/, f);
  }
});

test('App mirrors the setting into the pool on load and on every change', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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
