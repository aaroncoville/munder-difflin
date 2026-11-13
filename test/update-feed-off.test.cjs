'use strict';

// The update feed is the original project's, so following it would replace this
// build with a differently named one. While it is off, nothing may poll, download,
// open the original project's releases, or offer a control that does nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** Source with comments removed, so a match can only come from live code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the updater neither polls nor fetches release pages while the feed is off', () => {
  const { UPDATE_FEED_ENABLED } = loadTs('src/shared/updateFeed.ts');
  assert.equal(UPDATE_FEED_ENABLED, false);
  const updater = code('src/main/updater.ts');
  assert.match(updater, /^\s*if \(!app\.isPackaged \|\| !UPDATE_FEED_ENABLED\) return;$/m);
  assert.match(updater, /^\s*if \(!previewPath && UPDATE_FEED_ENABLED\) \{$/m);
});

test('the gate refuses while the feed is off and never runs the action', async () => {
  const { feedGate, whenFeedOn, UPDATES_OFF } = loadTs('src/shared/updateFeed.ts');
  let ran = 0;
  const action = async (x) => { ran += 1; return { ok: true, x }; };
  assert.deepEqual(await feedGate(false)(action)(1), { ok: false, error: UPDATES_OFF });
  assert.deepEqual(await whenFeedOn(action)(1), { ok: false, error: UPDATES_OFF });
  assert.equal(ran, 0);
  assert.deepEqual(await feedGate(true)(action)(7), { ok: true, x: 7 });
  assert.equal(ran, 1);
});

// Each channel that acts on the feed or opens the releases page, in main and in
// the preload that exposes it. `update:current` and the dev-only simulate are
// read-only or fabricated and stay ungated.
const GATED = [
  ['update:restartAndInstall', 'updateRestartAndInstall'],
  ['update:checkNow', 'updateCheckNow'],
  ['update:download', 'updateDownload'],
  ['update:openRelease', 'updateOpenRelease']
];

for (const [channel, method] of GATED) {
  test(`${channel} is gated in main and in the preload`, () => {
    assert.match(code('src/main/updater.ts'), new RegExp(`ipcMain\\.handle\\('${channel}', whenFeedOn\\(`));
    assert.match(code('src/preload/index.ts'), new RegExp(`^\\s*${method}: whenFeedOn\\(`, 'm'));
  });
}

test('no update control is mounted while the feed is off', () => {
  const app = code('src/renderer/src/App.tsx');
  assert.match(app, /\{UPDATE_FEED_ENABLED && <UpdateToast \/>\}/);
  assert.doesNotMatch(app.replace(/\{UPDATE_FEED_ENABLED && <UpdateToast \/>\}/, ''), /<UpdateToast\b/);
  assert.match(app, /\{UPDATE_FEED_ENABLED \? <UpdateBadge \/> : <AppVersionLabel \/>\}/);
  const settings = code('src/renderer/src/components/SettingsModal.tsx');
  assert.match(settings, /\{UPDATE_FEED_ENABLED && \(\s*<>\s*<div style=\{\{ height: 10 \}\} \/>/, 'the auto-update switch');
  assert.match(settings, /\{UPDATE_FEED_ENABLED && \(\s*<>\s*<UpdatesSection \/>/, 'the Updates row');
  assert.equal((settings.match(/<UpdatesSection\b/g) ?? []).length, 1);
  const hero = code('src/renderer/src/components/SettingsHeroCard.tsx');
  assert.match(hero, /\{UPDATE_FEED_ENABLED && pending && \(/, 'the manual download');
  assert.match(hero, /\{UPDATE_FEED_ENABLED && \(\s*<PixelButton variant="secondary" size="sm" onClick=\{showReleaseNotes\}>/, "What's new");
});
