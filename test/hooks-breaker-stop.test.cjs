'use strict';
// The breaker's no-progress arm exempts an agent between turns, and the only
// thing that tells it a turn has ended is the hook server passing Stop on.
// The breaker's own tests cover recordStop; this covers the call, by running
// the real hook handler, because dropping it leaves every breaker unit green
// while an idle agent goes back to being tripped for usage-sample noise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

/** A breaker that accepts every call and remembers who it was told stopped. */
function recordingBreaker() {
  const stopped = [];
  const breaker = new Proxy({}, {
    get: (_, name) => (name === 'recordStop' ? (id) => { stopped.push(id); } : () => undefined)
  });
  return { breaker, stopped };
}

async function server(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hooks-breaker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const { breaker, stopped } = recordingBreaker();
  const hooks = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, breaker);
  const fire = (event) => hooks.handle({ agent_id: 'jim-1', session_id: 's1', hook_event_name: event });
  return { fire, stopped };
}

test('a Stop tells the breaker the turn is over', async (t) => {
  const { fire, stopped } = await server(t);
  await fire('Stop');
  assert.deepEqual(stopped, ['jim-1']);
});

test('a subagent Stop tells the breaker too', async (t) => {
  const { fire, stopped } = await server(t);
  await fire('SubagentStop');
  assert.deepEqual(stopped, ['jim-1']);
});

test('no other hook ends the turn', async (t) => {
  const { fire, stopped } = await server(t);
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'SessionStart']) {
    await fire(event);
  }
  assert.deepEqual(stopped, []);
});
