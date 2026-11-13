'use strict';

// The update feed is the original project's, so following it would replace this
// build with a differently named one. While it is off, nothing may poll, download
// or offer a switch that does nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** Source with comments removed, so a match can only come from live code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the updater neither polls nor offers downloads while the feed is off', () => {
  const { UPDATE_FEED_ENABLED } = loadTs('src/shared/updateFeed.ts');
  assert.equal(UPDATE_FEED_ENABLED, false);
  const updater = code('src/main/updater.ts');
  assert.match(updater, /^\s*if \(!app\.isPackaged \|\| !UPDATE_FEED_ENABLED\) return;$/m);
  assert.match(updater, /^\s*if \(!previewPath && UPDATE_FEED_ENABLED\) \{$/m);
  for (const channel of ['update:checkNow', 'update:download']) {
    const at = updater.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at >= 0, `${channel} handler is gone`);
    assert.match(updater.slice(at, at + 200), /if \(!UPDATE_FEED_ENABLED\) return \{ ok: false/);
  }
  assert.match(code('src/renderer/src/components/SettingsModal.tsx'), /\{UPDATE_FEED_ENABLED && \(\s*<>\s*<div style=\{\{ height: 10 \}\} \/>/);
});
