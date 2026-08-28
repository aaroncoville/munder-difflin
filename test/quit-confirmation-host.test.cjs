'use strict';
/**
 * A quit asked for from inside the floor is never granted without the ask.
 *
 * The clock on the office wall and the hearth in the Study's parlour are
 * painted props: a click on one has no undo behind it and nothing tells it
 * apart from any other click, so it must always land on the shared quit
 * confirmation. `app:requestQuit` did that only while the primary window was
 * alive — when it was gone or its webContents destroyed it called
 * `teardownAndQuit()` outright, so on a secondary floor whose primary had been
 * closed the prop ended the app with nothing asked and nothing saved. It also
 * dropped the IPC event, so it could not even see the live floor that had just
 * asked it.
 *
 * Being unable to show the confirmation is not permission to quit. What is
 * pinned here is that the ask is routed to whatever live renderer there is —
 * the primary, else the floor that asked, else any other floor — and that with
 * no renderer at all the request is REFUSED rather than honoured.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const sourceAssert = require('./source-assert.cjs');

const { askToConfirmQuit } = loadTs('src/main/quitRequest.ts');

/** A renderer that can be sent to, recording what it was sent. */
const contents = (alive = true) => {
  const wc = {
    sent: [],
    isDestroyed: () => !alive,
    send: (channel, payload) => wc.sent.push({ channel, payload })
  };
  return wc;
};

/** A window standing on the floor, recording whether it was brought forward. */
const windowOf = (wc, alive = true) => {
  const w = {
    focused: 0,
    isDestroyed: () => !alive,
    focus: () => { w.focused++; },
    webContents: wc
  };
  return w;
};

const asked = (wc) => wc.sent.filter((s) => s.channel === 'app:closeRequested');

test('the primary window is still the one that shows the confirmation', () => {
  const primaryWc = contents();
  const primary = windowOf(primaryWc);
  const sender = contents();

  assert.equal(askToConfirmQuit({ primary, sender, windows: [primary], ptyCount: 2 }), true);
  assert.deepEqual(asked(primaryWc).map((s) => s.payload), [{ ptyCount: 2 }]);
  assert.equal(primary.focused, 1, 'the window that renders the dialog was not brought forward');
  assert.equal(asked(sender).length, 0, 'the floor that asked was made to show it as well');
});

test('with the primary gone, the floor that asked shows the confirmation', () => {
  // The branch that used to quit outright. A live sender is right there.
  const sender = contents();
  assert.equal(askToConfirmQuit({ primary: null, sender, windows: [], ptyCount: 3 }), true);
  assert.deepEqual(asked(sender).map((s) => s.payload), [{ ptyCount: 3 }]);
});

test('a destroyed primary is treated as gone, not as consent', () => {
  const primary = windowOf(contents(false), false);
  const sender = contents();
  assert.equal(askToConfirmQuit({ primary, sender, windows: [primary], ptyCount: 0 }), true);
  assert.deepEqual(asked(sender).map((s) => s.payload), [{ ptyCount: 0 }]);
});

test('a primary whose webContents died still routes the ask elsewhere', () => {
  // The window object survives its renderer often enough to matter: isDestroyed()
  // is false and send() throws. Nothing here may read that as a quit.
  const primary = windowOf(contents(false));
  const sender = contents();
  assert.equal(askToConfirmQuit({ primary, sender, windows: [primary], ptyCount: 1 }), true);
  assert.deepEqual(asked(sender).map((s) => s.payload), [{ ptyCount: 1 }]);
});

test('with no sender either, any other live floor is asked', () => {
  // The app menu and the tray have no sender at all, and a dead sender is the
  // same case: some other window is still standing and can carry the dialog.
  const otherWc = contents();
  const other = windowOf(otherWc);
  assert.equal(
    askToConfirmQuit({ primary: null, sender: contents(false), windows: [other], ptyCount: 4 }),
    true
  );
  assert.deepEqual(asked(otherWc).map((s) => s.payload), [{ ptyCount: 4 }]);
  assert.equal(other.focused, 1, 'the floor showing the dialog was not brought forward');
});

test('with nothing alive to ask, the request is refused rather than granted', () => {
  // The whole point. There is no third outcome here and no way to reach one:
  // this function is not given anything that can end the app.
  const dead = windowOf(contents(false), false);
  assert.equal(askToConfirmQuit({ primary: dead, sender: null, windows: [dead], ptyCount: 9 }), false);
  assert.equal(asked(dead.webContents).length, 0);
});

test('the quit handler routes the ask and cannot quit on its own', () => {
  const src = sourceAssert.activeSource('src/main/index.ts');
  const body = sourceAssert.boundedSlice(src, "ipcMain.handle('app:requestQuit'", '\n});');
  assert.ok(body.includes('askToConfirmQuit('),
    'the handler must route through the shared host resolution, or the branch that '
    + 'quits without asking comes back the moment the primary is gone');
  assert.ok(/\(\s*event\s*[,)]/.test(body),
    'the handler must take the IPC event: the floor that asked is the fallback '
    + 'confirmation host, and a discarded event cannot be one');
  assert.ok(!/teardownAndQuit\(|app\.quit\(/.test(body),
    'nothing on the request path may end the app — a request is an ask, and being '
    + 'unable to ask is not permission');
  assert.match(src, /import \{ askToConfirmQuit \} from '\.\/quitRequest';/,
    'index.ts must import the shared host resolution');
});
