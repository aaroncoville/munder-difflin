'use strict';

/**
 * The Study is a projection of the store, and this file exercises the
 * projection against the REAL store and the REAL task ledger shape — seeding
 * agents through the store's own setters and tasks through the same bridge call
 * the kanban makes, then reading what the hook hands the scene.
 *
 * Testing the mapping as a pure function would go green on a hook that stopped
 * calling it, so the hook is mounted in a probe component instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { useSceneState } = loadTs('src/renderer/src/scene/study/useSceneState.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { studyRoom } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');
const { deskBerths, godBerth } = loadTs('src/renderer/src/scene/study/roomManifest.ts');

/** The reading berths, in the order the house seats people into them. */
const DESKS = deskBerths(studyRoom);

const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];

/** An agent with only the fields the projection is allowed to look at. */
const agent = (id, over = {}) => ({
  id,
  name: id.toUpperCase(),
  character: 'jim',
  accent: 'sky',
  description: '',
  project: 'p',
  tmuxTarget: '',
  cwd: '/tmp',
  status: 'idle',
  action: '',
  progress: 0,
  ...over
});

const task = (over = {}) => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  title: 'a card',
  status: 'todo',
  dependsOn: [],
  priority: 3,
  createdAt: '2026-08-27T00:00:00.000Z',
  ...over
});

/** Seed the world, mount the hook, and return what it projected. */
async function project({ agents = [], tasks = [] }) {
  global.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    cth: { hiveTasks: async () => ({ tasks }) }
  };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  for (const a of agents) useStore.getState().addAgent(a);

  let seen = null;
  const Probe = () => { seen = useSceneState(); return null; };
  const view = mount(Probe, {});
  mounted.push(view);
  await settle();
  view.render(); // the first poll of the ledger has landed
  return seen;
}

test.afterEach(() => {
  // The hook polls the ledger; an unmounted probe would keep the runner alive.
  while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.();
});

test('the god takes the god berth and the workers take desks in roster order', async () => {
  const state = await project({
    agents: [agent('w-1'), agent('god-1', { isGod: true }), agent('w-2')]
  });
  const berthOf = (id) => state.agents.find((a) => a.id === id)?.berthId;
  assert.equal(berthOf('god-1'), godBerth(studyRoom).id, 'the god sits at his own desk');
  assert.equal(berthOf('w-1'), DESKS[0].id);
  assert.equal(berthOf('w-2'), DESKS[1].id,
    'the god does not consume a reading desk on his way past');
});

test('reseating is stable: an unrelated agent arriving does not move everyone', async () => {
  const first = await project({ agents: [agent('w-1'), agent('w-2')] });
  const second = await project({ agents: [agent('w-1'), agent('w-2'), agent('w-3')] });
  for (const id of ['w-1', 'w-2']) {
    assert.equal(
      second.agents.find((a) => a.id === id).berthId,
      first.agents.find((a) => a.id === id).berthId,
      `${id} keeps its seat`
    );
  }
});

test('more assistants than desks gives everyone their own place at a desk', async () => {
  const many = Array.from({ length: DESKS.length + 3 }, (_, i) => agent(`w-${i}`));
  const state = await project({ agents: many });
  assert.equal(state.agents.length, many.length, 'nobody is dropped on the floor');

  // Everyone who fits gets their own desk, in order...
  DESKS.forEach((berth, i) => {
    assert.equal(state.agents[i].berthId, berth.id, `seat ${i}`);
    assert.equal(state.agents[i].stackIndex, 0, `seat ${i} is the first at its desk`);
  });

  // ...and everyone past that shares a desk with a place of their own on it.
  // A berth alone is not a place: two assistants handed the same berth and
  // nothing else are drawn at identical coordinates, which is one card as far
  // as the eye and the pointer are both concerned.
  const places = state.agents.map((a) => `${a.berthId}#${a.stackIndex}`);
  assert.equal(new Set(places).size, places.length,
    `no two assistants share a place: ${places.join(' ')}`);
  for (const a of state.agents) {
    assert.ok(Number.isInteger(a.stackIndex) && a.stackIndex >= 0,
      `${a.id} has a place at its desk`);
  }

  // The places are dealt out in order, so nobody moves when somebody new
  // arrives after them.
  const again = await project({ agents: many });
  assert.deepEqual(again.agents.map((a) => `${a.berthId}#${a.stackIndex}`), places,
    'seating the same roster twice seats it the same way');
});

test('an assistant holding both a stuck card and a live one reads as stuck', async () => {
  // Which of the two books lands on the desk is the whole point: a sealed book
  // is what is worth noticing from across the room, and an open one beside it
  // says the work is fine.
  const state = await project({
    agents: [agent('w-1')],
    tasks: [
      task({ assignee: 'w-1', status: 'doing', title: 'Port the loader' }),
      task({ assignee: 'w-1', status: 'blocked', title: 'Which key?' })
    ]
  });
  assert.equal(state.agents[0].bookState, 'sealed');
  assert.equal(state.agents[0].bookTitle, 'Which key?');
});

test('an assistant at work has an open book named after the card', async () => {
  const state = await project({
    agents: [agent('w-1'), agent('w-2')],
    tasks: [task({ assignee: 'w-1', status: 'doing', title: 'Port the loader' })]
  });
  const one = state.agents.find((a) => a.id === 'w-1');
  assert.equal(one.bookState, 'open');
  assert.equal(one.bookTitle, 'Port the loader');
  assert.equal(state.agents.find((a) => a.id === 'w-2').bookState, undefined,
    'an assistant with no card has no book on the desk');
});

test('impeded work is a sealed book, and an open question is a petition', async () => {
  const state = await project({
    agents: [agent('w-1', { status: 'blocked' })],
    tasks: [task({
      assignee: 'w-1', status: 'blocked', title: 'Which key?',
      humanQA: [{ q: 'which api key?' }]
    })]
  });
  const one = state.agents[0];
  assert.equal(one.bookState, 'sealed');
  assert.equal(one.status, 'blocked');
  assert.equal(state.openAskCount, 1, 'the writing desk shows the waiting letter');
});

test('an answered question is no longer waiting on anyone', async () => {
  const state = await project({
    agents: [agent('w-1')],
    tasks: [task({
      assignee: 'w-1', status: 'blocked',
      humanQA: [{ q: 'which api key?', a: 'the staging one' }]
    })]
  });
  assert.equal(state.openAskCount, 0);
});

test('the kanban counts mirror the ledger', async () => {
  const state = await project({
    agents: [agent('w-1')],
    tasks: [
      task({ status: 'todo' }), task({ status: 'todo' }),
      task({ status: 'doing' }),
      task({ status: 'blocked' }),
      task({ status: 'done' }), task({ status: 'done' }), task({ status: 'done' })
    ]
  });
  assert.deepEqual(state.kanbanCounts, { todo: 2, doing: 1, blocked: 1, done: 3 });
});

test('an empty ledger is a quiet room, not a crash', async () => {
  const state = await project({ agents: [agent('w-1')] });
  assert.deepEqual(state.kanbanCounts, { todo: 0, doing: 0, blocked: 0, done: 0 });
  assert.equal(state.openAskCount, 0);
  assert.equal(state.agents[0].speech, '');
});

test('a bridge that is not there at all leaves the room standing', async () => {
  global.window = { localStorage: { getItem: () => null, setItem: () => {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent(agent('w-1'));
  let seen = null;
  const Probe = () => { seen = useSceneState(); return null; };
  const view = mount(Probe, {});
  mounted.push(view);
  await settle();
  view.render();
  assert.equal(seen.agents.length, 1);
  assert.deepEqual(seen.kanbanCounts, { todo: 0, doing: 0, blocked: 0, done: 0 });
});

test('speech is what the assistant is doing, then what it was last asked', async () => {
  const state = await project({
    agents: [
      agent('w-1', { action: 'Reading the seventh folio' }),
      agent('w-2', { lastPrompt: 'please rewrite the loader in terms of the manifest' }),
      agent('w-3')
    ]
  });
  const speechOf = (id) => state.agents.find((a) => a.id === id).speech;
  assert.equal(speechOf('w-1'), 'Reading the seventh folio');
  assert.match(speechOf('w-2'), /please rewrite the loader/);
  assert.equal(speechOf('w-3'), '', 'silence renders nothing');
});

test('the ten store statuses collapse onto the four the card can draw', async () => {
  const cases = {
    idle: 'idle', success: 'idle',
    working: 'working', thinking: 'working', compacting: 'working',
    looping: 'working', typing: 'working',
    blocked: 'blocked', waiting: 'blocked',
    ghost: 'archived'
  };
  const state = await project({
    agents: Object.keys(cases).map((s) => agent(`w-${s}`, { status: s }))
  });
  for (const [store, card] of Object.entries(cases)) {
    assert.equal(state.agents.find((a) => a.id === `w-${store}`).status, card,
      `${store} draws as ${card}`);
  }
});

test('archived assistants have left the room', async () => {
  global.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    cth: { hiveTasks: async () => ({ tasks: [] }) }
  };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent(agent('w-1'));
  useStore.getState().addAgent(agent('w-2'));
  useStore.getState().archiveAgent('w-2');
  let seen = null;
  const Probe = () => { seen = useSceneState(); return null; };
  const view = mount(Probe, {});
  mounted.push(view);
  await settle();
  view.render();
  assert.deepEqual(seen.agents.map((a) => a.id), ['w-1'],
    'the Study seats the live roster, same as the office floor');
});

test('the role on the card is the hire line, not the live status', async () => {
  const state = await project({
    agents: [agent('w-1', { description: 'Keeper of the almanac', action: 'reading' })]
  });
  assert.equal(state.agents[0].role, 'Keeper of the almanac');
});
