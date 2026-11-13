'use strict';
/**
 * An agent whose restore at app start is refused (its Codex hook trust could not be established, say) must stay on
 * the floor: a stopped card that shows why, from which Restart & Continue starts it again. It used to be left only in
 * the restorable list, with no card, so the owner had no way to start it short of relaunching the app.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any renderer module: it seeds require.cache for react.
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { useRestoreTeam } = loadTs('src/renderer/src/hooks/useRestoreTeam.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const REASON = 'Codex hook trust could not be established for cx1: the Codex app server did not answer after 3 attempts (21000 ms)';
const agent = { id: 'cx1', name: 'Coder', provider: 'codex', command: 'codex -a never -s workspace-write', cwd: '/work/repo', ptyId: 'pty-cx1', status: 'idle', action: '' };

async function restoreWith(result) {
  const spawned = [];
  global.window = { cth: { spawnPty: async (opts) => { spawned.push(opts); return result; }, gitIsRepo: async () => true } };
  useStore.setState({ agents: [], restorableAgents: [agent] });
  let api;
  mount(() => { api = useRestoreTeam(null); return null; }, {});
  await api.restoreTeam();
  return { spawned, state: useStore.getState() };
}

test('a refused restore leaves a stopped card with the reason, which Restart & Continue can start', async () => {
  const { spawned, state } = await restoreWith({ ok: false, error: REASON });
  assert.equal(spawned.length, 1);
  const card = state.agents.find((a) => a.id === agent.id);
  assert.ok(card, 'the agent is on the floor');
  assert.equal(card.ptyId, agent.ptyId, 'with the terminal id Restart & Continue respawns');
  assert.equal(card.provider, 'codex');
  assert.equal(card.status, 'blocked');
  assert.ok(card.action.includes(REASON), `the card says why: ${card.action}`);
  assert.equal(state.restorableAgents.some((a) => a.id === agent.id), false, 'and it is not offered for restore twice');
});

test('a restore that starts still adds a running card', async () => {
  const { state } = await restoreWith({ ok: true });
  const card = state.agents.find((a) => a.id === agent.id);
  assert.ok(card);
  assert.notEqual(card.status, 'blocked');
});
