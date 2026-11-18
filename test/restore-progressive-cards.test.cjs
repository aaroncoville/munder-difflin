'use strict';
/**
 * Restoring a team shows each agent's card as soon as that agent has started, in roster order.
 *
 * The restore starts every agent at once but used to add the cards only after the last spawn had answered. One slow
 * agent (a Codex app server taking its full trust budget, say) held back every card, healthy ones included, for as
 * long as it took. The cards must still land in the order the user arranged, because that order is persisted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any renderer module: it seeds require.cache for react.
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { useRestoreTeam } = loadTs('src/renderer/src/hooks/useRestoreTeam.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const seat = (id) => ({ id, name: id, provider: 'claude', command: 'claude', cwd: '/work/repo', ptyId: `pty-${id}`, status: 'idle', action: '' });
const ids = () => useStore.getState().agents.map((a) => a.id);
const settle = () => new Promise((r) => setImmediate(r));
/** The invariant every restore keeps: no agent is both on the floor (or archived) and offered for restore. */
function assertNeverBoth() {
  const st = useStore.getState();
  const taken = new Set([...st.agents, ...st.archivedAgents].map((a) => a.id));
  const both = st.restorableAgents.map((a) => a.id).filter((id) => taken.has(id));
  assert.deepEqual(both, [], `on the floor or archived, and still restorable: ${both.join(', ')}`);
}

function restoring(t, roster) {
  const gates = new Map();
  for (const a of roster) {
    let open;
    const answer = new Promise((r) => { open = r; });
    gates.set(a.ptyId, { answer, open });
  }
  global.window = { cth: { spawnPty: (opts) => gates.get(opts.id).answer, gitIsRepo: async () => true } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: roster });
  let api;
  mount(() => { api = useRestoreTeam(null); return null; }, {});
  const done = api.restoreTeam();
  // Whatever the test asserts, finish this restore, or the next test's restore would not run at all.
  t.after(async () => {
    for (const g of gates.values()) g.open({ ok: true });
    await done.catch(() => {});
    assertNeverBoth();
  });
  return { done, answer: (id, res) => gates.get(`pty-${id}`).open(res) };
}

test('a started agent gets its card while a slower one is still starting', async (t) => {
  const r = restoring(t, [seat('slow'), seat('fast')]);
  r.answer('fast', { ok: true });
  await settle();
  assert.deepEqual(ids(), ['fast'], 'the fast agent is on the floor before the slow one answers');
  r.answer('slow', { ok: false, error: 'trust refused' });
  await r.done;
  assert.deepEqual(ids(), ['slow', 'fast'], 'and the cards end in roster order');
  assert.equal(useStore.getState().agents[0].status, 'blocked');
});

test('cards that arrive out of order are placed in roster order', async (t) => {
  const r = restoring(t, [seat('a'), seat('b'), seat('c'), seat('d')]);
  r.answer('d', { ok: true }); await settle();
  r.answer('b', { ok: true }); await settle();
  assert.deepEqual(ids(), ['b', 'd']);
  r.answer('c', { ok: true }); await settle();
  assert.deepEqual(ids(), ['b', 'c', 'd']);
  r.answer('a', { ok: true });
  await r.done;
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd']);
});

test('cards restored next to agents already on the floor keep those agents where they are', async (t) => {
  useStore.setState({ agents: [] });
  const r = restoring(t, [seat('x'), seat('y')]);
  useStore.setState({ agents: [{ ...seat('boss'), isGod: true }] });
  r.answer('y', { ok: true }); await settle();
  r.answer('x', { ok: true });
  await r.done;
  assert.deepEqual(ids(), ['boss', 'x', 'y']);
});

test('an agent that is already on the floor is not moved by its restore', async (t) => {
  const r = restoring(t, [seat('a'), seat('b')]);
  // Both are already live (started by another path) in an order the user chose.
  useStore.setState({ agents: [seat('b'), seat('a')] });
  r.answer('a', { ok: true }); await settle();
  r.answer('b', { ok: true });
  await r.done;
  assert.deepEqual(ids(), ['b', 'a']);
});

// The roster order is persisted in two slices: the cards on the floor and the agents still to restore. A restore that
// is interrupted, or leaves an agent behind, must not let the next launch or a later restore reorder the roster.
const relaunch = () => useStore.getState().reconcileWithLivePtys([]);
const restorableIds = () => useStore.getState().restorableAgents.map((a) => a.id);

test('quitting while one agent is still starting keeps the roster order for the next launch', async (t) => {
  const r = restoring(t, [seat('a'), seat('b'), seat('c')]);
  r.answer('a', { ok: true }); await settle();
  r.answer('b', { ok: true }); await settle();
  // The app quits here, with c still starting; at the next launch no terminal survives.
  relaunch();
  assert.deepEqual(restorableIds(), ['a', 'b', 'c']);
});

test('an agent that never answers does not move ahead of the ones that did', async (t) => {
  const r = restoring(t, [seat('a'), seat('b')]);
  r.answer('a', { ok: true }); await settle();
  relaunch();
  assert.deepEqual(restorableIds(), ['a', 'b']);
});

test('an agent whose start throws keeps its place, and restoring again after a relaunch keeps the roster order', async () => {
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [seat('a'), seat('b')] });
  global.window = { cth: { spawnPty: async (opts) => { if (opts.id === 'pty-a') throw new Error('ipc gone'); return { ok: true }; }, gitIsRepo: async () => true } };
  let api;
  mount(() => { api = useRestoreTeam(null); return null; }, {});
  await api.restoreTeam();
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(useStore.getState().agents[0].status, 'blocked');
  assert.match(useStore.getState().agents[0].action, /not started: ipc gone/);
  assertNeverBoth();
  // The next launch: no terminal survived, so both are offered again, in roster order, and this time both start.
  relaunch();
  assert.deepEqual(restorableIds(), ['a', 'b']);
  const started = [];
  global.window = { cth: { spawnPty: async (opts) => { started.push(opts.id); return { ok: true }; }, gitIsRepo: async () => true } };
  await api.restoreTeam();
  assert.deepEqual(started.sort(), ['pty-a', 'pty-b'], 'the earlier agent really is started again');
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(useStore.getState().agents[0].status, 'idle');
  assertNeverBoth();
});

test('a card the owner selects during the restore stays selected when it ends', async (t) => {
  useStore.setState({ agents: [{ ...seat('boss'), isGod: true }], selectedId: 'boss' });
  const r = restoring(t, [seat('a'), seat('b'), seat('c'), seat('d')]);
  useStore.setState({ agents: [{ ...seat('boss'), isGod: true }], selectedId: 'boss' });
  r.answer('a', { ok: true }); await settle();
  r.answer('b', { ok: true }); await settle();
  // b took the selection when it arrived; the owner picks a, then c arrives while d is still starting.
  useStore.getState().select('a');
  r.answer('c', { ok: true }); await settle();
  assert.equal(useStore.getState().selectedId, 'a', 'a later card does not take the owner\'s selection');
  r.answer('d', { ok: true });
  await r.done;
  assert.equal(useStore.getState().selectedId, 'a');
});

test('with no choice made during the restore, the earlier selection comes back', async (t) => {
  const r = restoring(t, [seat('a'), seat('b')]);
  useStore.setState({ agents: [{ ...seat('boss'), isGod: true }], selectedId: 'boss' });
  r.answer('a', { ok: true }); await settle();
  r.answer('b', { ok: true });
  await r.done;
  assert.equal(useStore.getState().selectedId, 'boss');
});

test('after a reload mid-restore, an agent whose terminal is still alive is not also offered for restore', async (t) => {
  const r = restoring(t, [seat('a'), seat('b'), seat('c')]);
  r.answer('a', { ok: true }); await settle();
  r.answer('b', { ok: true }); await settle();
  // The window reloads: a's terminal is still running, b's is gone, c never started.
  useStore.getState().reconcileWithLivePtys(['pty-a']);
  assert.deepEqual(ids(), ['a']);
  assert.deepEqual(restorableIds(), ['b', 'c']);
});

test('an agent archived while the restore is still running is not offered for restore again', async (t) => {
  const r = restoring(t, [seat('a'), seat('b')]);
  r.answer('a', { ok: true }); await settle();
  useStore.getState().archiveAgent('a');
  assert.deepEqual(restorableIds(), ['b'], 'archiving drops its restorable entry at once');
  r.answer('b', { ok: true });
  await r.done;
  assert.deepEqual(restorableIds(), []);
});

test('an agent removed while the restore is still running is not offered for restore again', async (t) => {
  const r = restoring(t, [seat('a'), seat('b')]);
  r.answer('a', { ok: true }); await settle();
  useStore.getState().removeAgent('a');
  assert.deepEqual(restorableIds(), ['b'], 'removing drops its restorable entry at once');
  r.answer('b', { ok: true });
  await r.done;
  assert.deepEqual(restorableIds(), []);
});

test('a restore that throws part-way still stops offering the agents it placed', async (t) => {
  const real = useStore.getState().addAgent;
  t.after(() => useStore.setState({ addAgent: real }));
  const r = restoring(t, [seat('a'), seat('b')]);
  r.answer('a', { ok: true }); await settle();
  useStore.setState({ addAgent: (agent, opts) => { if (agent.id === 'b') throw new Error('store failed'); return real(agent, opts); } });
  r.answer('b', { ok: true });
  await assert.rejects(r.done, /store failed/);
  useStore.setState({ addAgent: real });
  assert.deepEqual(ids(), ['a']);
  assert.deepEqual(restorableIds(), ['b'], 'a was placed and is no longer restorable; b never was placed');
});

test('a reload mid-restore with every terminal alive drops the restorable entries of the live agents', async (t) => {
  const r = restoring(t, [seat('a'), seat('b'), seat('c')]);
  r.answer('a', { ok: true }); await settle();
  r.answer('b', { ok: true }); await settle();
  useStore.getState().reconcileWithLivePtys(['pty-a', 'pty-b']);
  assert.deepEqual(ids(), ['a', 'b']);
  assert.deepEqual(restorableIds(), ['c']);
});
