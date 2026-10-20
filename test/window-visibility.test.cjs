'use strict';

// A minimised window on WSLg keeps drawing. The office floor paused on
// document.hidden, and Chromium never flips it for a minimised or occluded
// Wayland window (backgroundThrottling is off besides): with the app
// minimised for a minute the GPU process stayed at the same 4.3 cores as with
// the window up. The main process knows — BrowserWindow fires minimize /
// restore and hide / show — and now tells the window's renderer over IPC,
// independent of document.hidden. These pin the main-side wiring against a
// fake window, the renderer's mirror, and that both scenes and the app read it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { WINDOW_VISIBILITY_CHANNEL, WINDOW_VISIBILITY_GET_CHANNEL, windowShown } = loadTs('src/shared/windowVisibility.ts');
const { installWindowVisibility, registerWindowVisibilityQuery, WINDOW_VISIBILITY_EVENTS } = loadTs('src/main/windowVisibility.ts');
const {
  getWindowShown, setWindowShown, applyWindowVisibility, seedWindowVisibility, resetWindowShown,
  subscribeWindowShown, windowShownListenerCount
} = loadTs('src/renderer/src/scene/windowShown.ts');

/** A BrowserWindow that records its listeners and what it sent. */
function fakeWindow({ visible = true, minimized = false } = {}) {
  const handlers = new Map();
  const sent = [];
  const win = {
    visible, minimized, destroyed: false,
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isDestroyed() { return this.destroyed; },
    on(ev, fn) { (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)).add(fn); },
    removeListener(ev, fn) { handlers.get(ev)?.delete(fn); },
    webContents: { send(channel, payload) { sent.push([channel, payload]); } },
    fire(ev) { for (const fn of [...(handlers.get(ev) ?? [])]) fn(); },
    get listenerCount() { let n = 0; for (const s of handlers.values()) n += s.size; return n; },
    sent
  };
  return win;
}

test('shown means visible and not minimised', () => {
  assert.equal(windowShown({ isVisible: () => true, isMinimized: () => false }), true);
  assert.equal(windowShown({ isVisible: () => true, isMinimized: () => true }), false, 'a minimised window can still report visible');
  assert.equal(windowShown({ isVisible: () => false, isMinimized: () => false }), false);
  assert.equal(WINDOW_VISIBILITY_CHANNEL, 'window:visibility');
});

test('main tells the renderer on minimise, restore, hide and show, with the state at that moment', () => {
  assert.deepEqual([...WINDOW_VISIBILITY_EVENTS], ['minimize', 'restore', 'hide', 'show']);
  const win = fakeWindow();
  const uninstall = installWindowVisibility(win);
  assert.equal(win.listenerCount, 5, 'four visibility events plus closed');
  win.minimized = true; win.fire('minimize');
  win.minimized = false; win.fire('restore');
  win.visible = false; win.fire('hide');
  win.visible = true; win.fire('show');
  assert.deepEqual(win.sent, [
    ['window:visibility', { shown: false }],
    ['window:visibility', { shown: true }],
    ['window:visibility', { shown: false }],
    ['window:visibility', { shown: true }]
  ]);
  // A destroyed window is left alone; an uninstalled one hears nothing.
  win.destroyed = true; win.fire('minimize');
  assert.equal(win.sent.length, 4);
  uninstall();
  assert.equal(win.listenerCount, 0);
});

test("'closed' uninstalls: no listener outlives the window", () => {
  const win = fakeWindow();
  installWindowVisibility(win);
  assert.equal(win.listenerCount, 5, 'four visibility events plus closed');
  win.fire('closed');
  assert.equal(win.listenerCount, 0);
});

/** An ipcMain that records its handlers and lets a test invoke them. */
function fakeIpc() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    invoke(channel, sender) { return handlers.get(channel)({ sender }); }
  };
}

test('a renderer subscribing while its window is already minimised is told so at once', () => {
  resetWindowShown();
  const win = fakeWindow({ minimized: true });
  const ipc = fakeIpc();
  const windows = new Map([['wc-1', win]]);
  registerWindowVisibilityQuery(ipc, (sender) => windows.get(sender) ?? null);
  installWindowVisibility(win);
  // What App.tsx does: subscribe, then ask. The answer seeds the mirror.
  let woke = 0;
  const off = subscribeWindowShown(() => { woke += 1; });
  assert.equal(getWindowShown(), true, 'the mirror starts shown');
  seedWindowVisibility(ipc.invoke(WINDOW_VISIBILITY_GET_CHANNEL, 'wc-1'));
  assert.equal(getWindowShown(), false, 'a renderer under a minimised window must start paused');
  assert.equal(woke, 1);
  // Restore reaches it as a push.
  win.minimized = false; win.fire('restore');
  applyWindowVisibility(win.sent.at(-1)[1]);
  assert.equal(getWindowShown(), true);
  assert.equal(woke, 2);
  off();
  resetWindowShown();
});

test('the query answers shown for a sender with no window, and never overrides a push that came first', () => {
  const ipc = fakeIpc();
  registerWindowVisibilityQuery(ipc, () => null);
  assert.deepEqual(ipc.invoke(WINDOW_VISIBILITY_GET_CHANNEL, 'stranger'), { shown: true });
  const gone = fakeWindow({ minimized: true }); gone.destroyed = true;
  registerWindowVisibilityQuery(ipc, () => gone);
  assert.deepEqual(ipc.invoke(WINDOW_VISIBILITY_GET_CHANNEL, 'x'), { shown: true }, 'a destroyed window reads as shown');

  resetWindowShown();
  applyWindowVisibility({ shown: true });   // main pushed 'restored' while the query was in flight
  seedWindowVisibility({ shown: false });   // the stale answer lands
  assert.equal(getWindowShown(), true, 'a stale query answer overrode a newer push');
  resetWindowShown();
  seedWindowVisibility({ shown: false });
  assert.equal(getWindowShown(), false, 'with no push yet, the answer seeds the state');
  resetWindowShown();
});

test('a renderer whose webContents throws does not take the event handler down', () => {
  const win = fakeWindow();
  win.webContents.send = () => { throw new Error('Object has been destroyed'); };
  installWindowVisibility(win);
  assert.doesNotThrow(() => win.fire('minimize'));
});

test('the renderer mirror starts shown, notifies on change only, and treats a bad payload as shown', () => {
  assert.equal(getWindowShown(), true);
  let woke = 0;
  const off = subscribeWindowShown(() => { woke += 1; });
  applyWindowVisibility({ shown: true });
  assert.equal(woke, 0, 'no change, no wake-up');
  applyWindowVisibility({ shown: false });
  assert.equal(getWindowShown(), false);
  assert.equal(woke, 1);
  applyWindowVisibility({ shown: false });
  assert.equal(woke, 1);
  applyWindowVisibility({});
  assert.equal(getWindowShown(), true, 'anything but an explicit false is shown');
  assert.equal(woke, 2);
  off();
  applyWindowVisibility({ shown: false });
  assert.equal(woke, 2, 'unsubscribed');
  assert.equal(windowShownListenerCount(), 0);
  setWindowShown(true);
  resetWindowShown();
});

test('wiring: main installs it per window, preload exposes it on the channel, App feeds the mirror', () => {
  const main = strip(read('src/main/index.ts'));
  const i = main.indexOf('const win = new BrowserWindow({');
  assert.ok(i > 0);
  const after = main.slice(i, main.indexOf("win.once('ready-to-show'", i));
  assert.match(after, /installWindowVisibility\(win\);/, 'every window, floors included, must report its visibility');
  assert.match(main, /registerWindowVisibilityQuery\(ipcMain, \(sender\) => BrowserWindow\.fromWebContents\(/,
    'main must answer the query with the SENDER\'s window');

  const preload = strip(read('src/preload/index.ts'));
  const j = preload.indexOf('onWindowVisibility:');
  assert.ok(j > 0, 'preload does not expose onWindowVisibility');
  const api = preload.slice(j, preload.indexOf('},', j));
  assert.match(api, /ipcRenderer\.on\(WINDOW_VISIBILITY_CHANNEL, listener\);/);
  assert.match(api, /ipcRenderer\.removeListener\(WINDOW_VISIBILITY_CHANNEL, listener\)/);
  assert.match(preload, /getWindowVisibility: \(\): Promise<WindowVisibility> =>\s*ipcRenderer\.invoke\(WINDOW_VISIBILITY_GET_CHANNEL\)/);

  const app = strip(read('src/renderer/src/App.tsx'));
  const k = app.indexOf('window.cth.onWindowVisibility(applyWindowVisibility)');
  assert.ok(k > 0);
  const effect = app.slice(k, app.indexOf('return off;', k));
  assert.match(effect, /window\.cth\.getWindowVisibility\(\)\.then\(seedWindowVisibility\)/,
    'App must subscribe first, then ask for the state now');
});

test('the office floor pauses on it next to document.hidden; the study ambiance folds it into visibility', () => {
  const floor = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  assert.match(floor, /const windowShown = useWindowShown\(\);/);
  assert.match(floor, /const paused = !!fullscreenAgentId \|\| ideOpen \|\| docHidden \|\| !windowShown;/,
    'a minimised window must stop the ticker like a hidden document does');

  const study = strip(read('src/renderer/src/scene/study/AmbianceLayer.tsx'));
  assert.match(study, /setVisible\(!document\.hidden && getWindowShown\(\)\)/);
  assert.match(study, /subscribeWindowShown\(read\)/, 'the layer must re-read when main reports a change');
});
