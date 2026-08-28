'use strict';
/**
 * Pressing closing time on the floor asks; it does not quit.
 *
 * The hearth in the Study's parlour (and the clock on the office wall it was
 * modelled on) called `window.close()`, on the assumption that the main
 * process would intercept it and raise the quit dialog. It only does that on
 * the PRIMARY window and only while a terminal is alive — on a floor window
 * `close` closes that floor, and with nothing running the interceptor has
 * nothing to warn about and the window simply goes. Either way the app ended
 * on one click of a painted prop, with no confirmation and no closing time.
 *
 * So the prop asks the main process for the dialog instead, and that is what
 * is pinned here: the click reaches `requestQuit`, and NOTHING on that path
 * closes a window or confirms a quit by itself.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const scenes = [];
test.afterEach(() => { while (scenes.length) for (const s of scenes.pop().cleanups) s?.(); });
const settle = () => new Promise((r) => setImmediate(r));

const all = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) all(k, pred, out); return out; }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) all(n.props.children, pred, out);
  if (typeof n.type === 'function') {
    let r; try { r = n.type(n.props); } catch { return out; }
    all(r, pred, out);
  }
  return out;
};

/** The house, standing, with every way out of the app recorded. */
async function house() {
  const calls = { closed: 0, requested: 0, confirmed: 0, tabs: [] };
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => { calls.closed++; },
    cth: {
      hiveTasks: async () => ({ tasks: [] }),
      requestQuit: async () => { calls.requested++; },
      confirmClose: async () => { calls.confirmed++; }
    }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.setState({
    requestCommandCenterTab: (tab) => calls.tabs.push(tab),
    select: () => {},
    openTaskDetail: () => {}
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  scenes.push(view);
  await settle();
  view.render();
  return { view, calls };
}

/** The closing-time prop, wherever the floor plan put it — a room of its own
 *  or a fireplace standing in the parlour. */
const hearthIn = (view) => all(view.tree, (n) =>
  n.props?.['data-study-kind'] === 'hearth')[0];

test('pressing closing time opens the confirmation instead of ending the app', async () => {
  const { view, calls } = await house();
  const hearth = hearthIn(view);
  assert.ok(hearth, 'the house has no closing-time prop to press');

  hearth.props.onClick({ stopPropagation: () => {} });
  await settle();

  assert.equal(calls.requested, 1, 'the press never asked for the quit dialog');
  assert.equal(calls.closed, 0,
    'the press closed the window itself — on a floor window that is not a quit, '
    + 'and with no terminal alive it is a quit with nothing asked');
  assert.equal(calls.confirmed, 0, 'the press confirmed the quit on the user\'s behalf');
});

test('the keyboard reaches it the same way the pointer does', async () => {
  const { view, calls } = await house();
  const hearth = hearthIn(view);
  const press = (key) => hearth.props.onKeyDown({
    key, target: 1, currentTarget: 1,
    preventDefault: () => {}, stopPropagation: () => {}
  });
  press('Enter');
  press(' ');
  await settle();
  assert.equal(calls.requested, 2, 'Enter and Space do not open closing time');
  assert.equal(calls.closed, 0, 'the keyboard path still closes the window');
  press('a');
  await settle();
  assert.equal(calls.requested, 2, 'any key at all opened closing time');
});

test('nothing else in the house quits the app on a click', async () => {
  // The prop that quits has to be the ONLY one: the archive, the almanac, the
  // petitions and the table are all one press away from it on the same floor.
  const { view, calls } = await house();
  const props = all(view.tree, (n) => n.props?.['data-study-kind'] !== undefined
    && n.props['data-study-kind'] !== 'hearth' && typeof n.props.onClick === 'function');
  assert.ok(props.length > 0, 'the house has no other props to check');
  for (const p of props) p.props.onClick({ stopPropagation: () => {} });
  await settle();
  assert.equal(calls.requested, 0, 'another prop in the house asks to quit');
  assert.equal(calls.closed, 0, 'another prop in the house closes the window');
});

// ─── What the dialog then says ──────────────────────────────────────────────

/**
 * The dialog is now reachable with nothing running, which it never was before:
 * every other route to it is gated on a live terminal. Its copy was written for
 * that gate — "0 AGENTS STILL RUNNING", "terminate all 0 running claude
 * sessions", "kill all & quit" — and a dialog that miscounts what it is about
 * to destroy is worse than no dialog.
 */
const { QuitWarningModal } = loadTs('src/renderer/src/components/QuitWarningModal.tsx');
const { text } = require('./render-hooks.cjs');

const dialogText = (ptyCount) => {
  const inst = mount(QuitWarningModal, {
    ptyCount, onCancel: () => {}, onConfirm: async () => {}, onClosingTime: () => {}
  });
  scenes.push(inst);
  return text(inst.tree).join(' ');
};

test('with nothing running the dialog does not claim to be killing nothing', () => {
  const said = dialogText(0);
  assert.doesNotMatch(said, /\b0\b/, `the dialog counts an empty floor: ${said}`);
  assert.doesNotMatch(said, /kill/i, 'the dialog offers to kill what is not there');
  assert.match(said, /closing time/i, 'closing time is not offered');
});

test('with terminals alive it still says exactly how many are about to die', () => {
  assert.match(dialogText(1), /1 AGENT STILL RUNNING/);
  assert.match(dialogText(1), /kill it & quit/);
  assert.match(dialogText(3), /3 AGENTS STILL RUNNING/);
  assert.match(dialogText(3), /kill all & quit/);
});
