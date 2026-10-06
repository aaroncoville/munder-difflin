'use strict';
// This fork carries upstream's public 0.5.5 plus its own changes, labelled
// 0.5.5-sixth.N. The updater compares major.minor.patch only, so the label must
// read as 0.5.5 there: upstream's 0.5.5 release is not offered as an update
// over it, and anything upstream ships after it still is.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { isNewer, parseVersion, shouldShowReleaseDrop } = loadTs('src/shared/updateState.ts');
const { version } = require(path.resolve(__dirname, '..', 'package.json'));

test('the fork labels itself as a build of 0.5.5', () => {
  assert.match(version, /^0\.5\.5-sixth\.\d+$/);
  assert.deepEqual(parseVersion(version), [0, 5, 5]);
});

test('upstream\'s 0.5.5 release is not offered as an update over the fork', () => {
  // The releases/latest notifier offers a tag when isNewer(tag, running).
  assert.equal(isNewer('v0.5.5', version), false);
  assert.equal(isNewer('v0.5.3', version), false);
});

test('a later upstream release is still offered', () => {
  assert.equal(isNewer('v0.5.6', version), true);
  assert.equal(isNewer('v0.6.0', version), true);
});

test('moving from 0.4.6 to the fork label opens the release notes once', () => {
  assert.equal(shouldShowReleaseDrop('0.4.6', version), true);
  assert.equal(shouldShowReleaseDrop(version, version), false);
});
