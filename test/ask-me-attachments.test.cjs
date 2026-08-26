'use strict';

/**
 * Wiring coverage for images attached to an ASK ME answer.
 *
 * test/ask-attachments.test.cjs proves the main-process store refuses a
 * non-image, and test/attached-images.test.cjs proves the block is formatted
 * one way. Neither notices if AskMeTab stops CALLING them: delete the
 * withAttachedImages() call and the answer silently loses its images while both
 * of those files stay green. A path written to disk that nothing is ever told
 * to read is the bug this file exists to catch, so it mounts the real
 * component, pastes a real screenshot, clicks the real send button, and reads
 * what actually crossed the bridge.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { AskMeTab } = loadTs('src/renderer/src/components/AskMeTab.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A pasted/dropped file, with just the surface the component touches. */
const fakeFile = (bytes) => ({
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
});

/** The clipboard/drag payload shape: `items`, each with a kind and a getter. */
const transfer = (files) => ({ items: files.map((f) => ({ kind: 'file', getAsFile: () => f })) });

const task = (id) => ({
  id, title: `card ${id}`, status: 'blocked',
  humanQA: [{ q: 'does it render?' }]
});

/**
 * Stand in for the preload bridge. `stored` is what the main process would have
 * written; `patches` and `sends` are what the component hands back to it.
 */
function fakeBridge({ tasks, stored }) {
  const calls = { attach: [], patches: [], sends: [] };
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks }),
      askAttachImage: async (taskId, bytes) => {
        calls.attach.push({ taskId, bytes });
        return stored;
      },
      hivePatchTask: async (id, patch) => { calls.patches.push({ id, patch }); return { ok: true }; },
      hiveSend: async (msg) => { calls.sends.push(msg); return { ok: true }; }
    }
  };
  return calls;
}

class FakeFileReader {
  readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onload(); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Every view mounted by a test, so its polling timer is stopped afterwards. */
const mounted = [];

/** Mount the tab with one card already loaded from the fake ledger. */
async function open(calls) {
  global.FileReader = FakeFileReader;
  const view = mount(AskMeTab, {});
  mounted.push(view);
  await settle();
  view.render(); // the first poll has landed
  return { view, calls };
}

const find = (tree, predicate) => flatten(tree).map((e) => e.node).find(predicate);
const textarea = (tree) => find(tree, (n) => n.type === 'textarea');
const labelled = (tree, label) => find(tree, (n) => n.props && n.props.children === label);
/** The send button whatever it currently says — its LABEL is the state under
 *  test in the wedge case below, so it cannot also be how the button is found. */
const sendButton = (tree) =>
  find(tree, (n) => n.props && ['respond & unblock', 'sending…', 'attaching…'].includes(n.props.children));

test.afterEach(() => {
  // The tab polls the ledger every few seconds; an unmounted test would keep
  // the runner alive forever.
  while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.();
  for (const id of Object.keys(useStore.getState().answerAttachments)) {
    useStore.getState().clearAnswerAttachments(id);
    useStore.getState().setAnswerDraft(id, '');
  }
});

test('a pasted screenshot is stored and shown as a removable chip', async () => {
  const calls = fakeBridge({ tasks: [task('T-1')], stored: { ok: true, path: '/hive/asks/attachments/T-1/shot.png' } });
  const { view } = await open(calls);

  let prevented = false;
  await textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(PNG_BYTES)]),
    preventDefault: () => { prevented = true; }
  });
  await settle(); // onPaste fires the store off and returns; let it land
  view.render();

  assert.equal(prevented, true, 'a pasted image must not also land as text');
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.attach[0].taskId, 'T-1');
  assert.deepEqual([...calls.attach[0].bytes], [...PNG_BYTES], 'the raw bytes go to main, nothing else');

  const chip = find(view.tree, (n) => n.type === 'img');
  assert.ok(chip, 'the attached image should show as a thumbnail');
  assert.match(chip.props.src, /^data:image\/png/);

  const remove = find(view.tree, (n) => n.props && n.props['aria-label'] === 'remove this image from the answer');
  assert.ok(remove, 'a chip must be removable before sending');
  remove.props.onClick();
  view.render();
  assert.equal(find(view.tree, (n) => n.type === 'img'), undefined);
});

test('the answer sent to the card AND to the agent both carry the image path', async () => {
  const path = '/hive/asks/attachments/T-2/2026-01-02T03-04-05-678Z-1.png';
  const calls = fakeBridge({ tasks: [task('T-2')], stored: { ok: true, path } });
  const { view } = await open(calls);

  textarea(view.tree).props.onChange({ target: { value: 'looks like this' } });
  await textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(PNG_BYTES)]),
    preventDefault: () => {}
  });
  await settle(); // onPaste fires the store off and returns; let it land
  view.render();

  labelled(view.tree, 'respond & unblock').props.onClick();
  await settle();

  const expected = `looks like this\n\nAttached images:\n- ${path}`;
  assert.equal(calls.patches.length, 1);
  assert.equal(calls.patches[0].patch.humanQA[0].a, expected, 'the card must document the images');
  assert.equal(calls.sends.length, 1);
  assert.ok(
    calls.sends[0].body.includes(expected),
    `the agent must be told where the images are — got:\n${calls.sends[0].body}`
  );
});

test('a refused file is reported to the human and attaches nothing', async () => {
  const calls = fakeBridge({
    tasks: [task('T-3')],
    stored: { ok: false, error: 'attachment is not an image (PNG, JPEG, GIF or WebP only)' }
  });
  const { view } = await open(calls);

  await textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(Buffer.from('not an image'))]),
    preventDefault: () => {}
  });
  await settle(); // onPaste fires the store off and returns; let it land
  view.render();

  assert.equal(find(view.tree, (n) => n.type === 'img'), undefined, 'nothing should be attached');
  const shown = find(view.tree, (n) => typeof n.props?.children === 'string' && n.props.children.startsWith('attachment is not an image'));
  assert.ok(shown, 'the main process’s reason must be on screen, not swallowed');
});

test('an image on its own is a complete answer', async () => {
  const path = '/hive/asks/attachments/T-4/shot.png';
  const calls = fakeBridge({ tasks: [task('T-4')], stored: { ok: true, path } });
  const { view } = await open(calls);

  assert.equal(labelled(view.tree, 'respond & unblock').props.disabled, true, 'an empty answer cannot be sent');
  await textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(PNG_BYTES)]),
    preventDefault: () => {}
  });
  await settle(); // onPaste fires the store off and returns; let it land
  view.render();

  const send = labelled(view.tree, 'respond & unblock');
  assert.equal(send.props.disabled, false, 'an attached image should be sendable on its own');
  send.props.onClick();
  await settle();
  assert.equal(calls.patches[0].patch.humanQA[0].a, `\n\nAttached images:\n- ${path}`);
});

/**
 * Storing an image is an IPC round trip, and the human does not wait for it.
 *
 * Paste a screenshot and hit send in the same second — or paste and press
 * Ctrl+Enter, which is the FAST path and the one a disabled button cannot
 * cover — and the answer used to be assembled from whatever had already come
 * back. The image was written to the hive, then cleared with the rest of the
 * draft when the pending call landed after the send: stored on disk, named in
 * neither the card nor the message to the agent, and no error anywhere. Sending
 * has to wait for the attachment it is going to describe.
 */
test('an attachment still in flight at send time is waited for, not dropped', async () => {
  const path = '/hive/asks/attachments/T-5/2026-01-02T03-04-05-678Z-1.png';
  let release;
  const inFlight = new Promise((resolve) => { release = () => resolve({ ok: true, path }); });
  const calls = { attach: [], patches: [], sends: [] };
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [task('T-5')] }),
      askAttachImage: async (taskId, bytes) => { calls.attach.push({ taskId, bytes }); return inFlight; },
      hivePatchTask: async (id, patch) => { calls.patches.push({ id, patch }); return { ok: true }; },
      hiveSend: async (msg) => { calls.sends.push(msg); return { ok: true }; }
    }
  };
  const { view } = await open(calls);

  textarea(view.tree).props.onChange({ target: { value: 'here you go' } });
  void textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(PNG_BYTES)]),
    preventDefault: () => {}
  });
  await settle();
  view.render();
  assert.equal(calls.attach.length, 1, 'the upload is under way');
  assert.equal(calls.patches.length, 0, 'and has not come back yet');

  // Ctrl+Enter — the keyboard path, which no `disabled` prop can intercept.
  const sent = textarea(view.tree).props.onKeyDown({ key: 'Enter', metaKey: true });
  await settle();
  assert.equal(calls.patches.length, 0, 'the answer must not be written without the image');

  release();
  await settle(); await settle(); await settle();
  await sent;
  view.render();

  const expected = `here you go\n\nAttached images:\n- ${path}`;
  assert.equal(calls.patches.length, 1, 'the answer is sent once the image has landed');
  assert.equal(calls.patches[0].patch.humanQA[0].a, expected, 'the card must carry the image that was still uploading');
  assert.ok(calls.sends[0].body.includes(expected), 'so must the message to the agent');
});

/**
 * The wait added above hands `sendAnswer` a way to leave without finishing, and
 * an early return past `setSending(null)` does not merely abandon one answer: a
 * truthy `sending` is what rejects the NEXT send, so the card — and with it
 * every other card on the board, which shares the state — stays wedged until
 * the view is remounted.
 *
 * The path there is the ordinary one, not an exotic failure: an image-only
 * answer, sent with Ctrl+Enter while the upload is still going, and the upload
 * comes back refused. There is then nothing to send, which is correct — but the
 * card has to be usable afterwards, because being told "not an image" and
 * retrying with a real one is exactly what happens next.
 */
test('an in-flight attachment that comes back REFUSED releases the card instead of wedging it', async () => {
  const path = '/hive/asks/attachments/T-6/2026-01-02T03-04-05-678Z-1.png';
  let settleAttach;
  let answer = { ok: false, error: 'attachment is not an image (PNG, JPEG, GIF or WebP only)' };
  const calls = { attach: [], patches: [], sends: [] };
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [task('T-6')] }),
      askAttachImage: async (taskId, bytes) => {
        calls.attach.push({ taskId, bytes });
        // The FIRST upload is held open so the send can overtake it; later ones
        // resolve immediately, standing in for the human's successful retry.
        if (calls.attach.length > 1) return answer;
        return new Promise((resolve) => { settleAttach = () => resolve(answer); });
      },
      hivePatchTask: async (id, patch) => { calls.patches.push({ id, patch }); return { ok: true }; },
      hiveSend: async (msg) => { calls.sends.push(msg); return { ok: true }; }
    }
  };
  const { view } = await open(calls);

  // Image-only answer: no text to fall back on once the upload is refused.
  void textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(Buffer.from('not an image'))]),
    preventDefault: () => {}
  });
  await settle();
  const sent = textarea(view.tree).props.onKeyDown({ key: 'Enter', metaKey: true });
  await settle();

  settleAttach();
  await settle(); await settle(); await settle();
  await sent;
  view.render();

  assert.equal(calls.patches.length, 0, 'a refused image is not an answer — nothing should be sent');
  const send = sendButton(view.tree);
  assert.ok(send, 'the send button is still on screen');
  assert.notEqual(send.props.children, 'sending…', 'the card must not be stuck mid-send');

  // (b) and the card still works: a real answer typed afterwards goes through.
  answer = { ok: true, path };
  textarea(view.tree).props.onChange({ target: { value: 'sorry, here it is' } });
  view.render();
  await textarea(view.tree).props.onPaste({
    clipboardData: transfer([fakeFile(PNG_BYTES)]),
    preventDefault: () => {}
  });
  await settle();
  view.render();
  await sendButton(view.tree).props.onClick();
  await settle(); await settle();

  assert.equal(calls.patches.length, 1, 'the next valid answer must send — the card was wedged if it does not');
  assert.equal(calls.patches[0].patch.humanQA[0].a, `sorry, here it is\n\nAttached images:\n- ${path}`);
});
