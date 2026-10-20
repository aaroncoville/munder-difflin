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

const { WINDOW_VISIBILITY_CHANNEL, windowShown } = loadTs('src/shared/windowVisibility.ts');
const { installWindowVisibility, WINDOW_VISIBILITY_EVENTS } = loadTs('src/main/windowVisibility.ts');
const {
  getWindowShown, setWindowShown, applyWindowVisibility, subscribeWindowShown, windowShownListenerCount
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
  assert.equal(win.listenerCount, 4);
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
});

test('wiring: main installs it per window, preload exposes it on the channel, App feeds the mirror', () => {
  const main = strip(read('src/main/index.ts'));
  const i = main.indexOf('const win = new BrowserWindow({');
  assert.ok(i > 0);
  const after = main.slice(i, main.indexOf("win.once('ready-to-show'", i));
  assert.match(after, /installWindowVisibility\(win\);/, 'every window, floors included, must report its visibility');

  const preload = strip(read('src/preload/index.ts'));
  const j = preload.indexOf('onWindowVisibility:');
  assert.ok(j > 0, 'preload does not expose onWindowVisibility');
  const api = preload.slice(j, preload.indexOf('},', j));
  assert.match(api, /ipcRenderer\.on\(WINDOW_VISIBILITY_CHANNEL, listener\);/);
  assert.match(api, /ipcRenderer\.removeListener\(WINDOW_VISIBILITY_CHANNEL, listener\)/);

  const app = strip(read('src/renderer/src/App.tsx'));
  assert.match(app, /window\.cth\.onWindowVisibility\(applyWindowVisibility\)/);
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
