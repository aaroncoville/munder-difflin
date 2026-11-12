'use strict';
// The outbound analytics path (PostHog) must not be able to carry any usage-log
// or canary event: its allowlist drops unknown event names. Stubbed exactly like
// telemetry-funnel.test.cjs, so nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

globalThis.__POSTHOG_KEY__ = 'test-key';
globalThis.__POSTHOG_HOST__ = 'https://example.invalid';
delete process.env.DO_NOT_TRACK;

const captured = [];
class FakePostHog { capture(p) { captured.push(p); } async shutdown() {} }
const posthogPath = require.resolve('posthog-node');
require.cache[posthogPath] = { id: posthogPath, filename: posthogPath, loaded: true, exports: { PostHog: FakePostHog } };

const { Analytics } = loadTs('src/main/analytics.ts');

test('no usage-log, floor or canary event kind can be sent by the outbound analytics module', () => {
  const a = new Analytics();
  a.init({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-out-')), appVersion: '0.5.5', enabled: true });
  captured.length = 0;
  const kinds = ['ui-view', 'ui-view-end', 'ask-shown', 'ask-submitted', 'app-focus',
    'turn', 'card-transition', 'ask-filed', 'ask-answered', 'canary', 'agent-model'];
  for (const k of kinds) a.track(k, { view: 'settings', askKey: 'A@1' });
  assert.deepEqual(captured, []);
});
