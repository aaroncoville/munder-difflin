'use strict';

/**
 * terminalInputSource.ts: which of the pane's writes are a person's. A fake
 * xterm emits onData with and without a preceding onKey, the way the real one
 * does for a keystroke versus an automated DA/DSR/cursor-position reply.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { attachInputSourceTracker, createInputSourceTracker, KEYBOARD_FLAG_MS, PASTE_FLAG_MS } =
  loadTs('src/renderer/src/components/terminalInputSource.ts');

/** The slice of xterm the tracker and the pane use: onKey fires just before
 *  the onData of the same keyboard event; a terminal reply has no onKey. */
function fakeXterm() {
  const keyListeners = [];
  const dataListeners = [];
  return {
    onKey: (cb) => { keyListeners.push(cb); return { dispose() {} }; },
    onData: (cb) => { dataListeners.push(cb); return { dispose() {} }; },
    /** A keyboard event: onKey, then onData, like xterm's _keyDown. */
    press: (data) => { for (const k of keyListeners) k({ key: data }); for (const d of dataListeners) d(data); },
    /** The terminal answering a query from the CLI: onData only. */
    reply: (data) => { for (const d of dataListeners) d(data); }
  };
}

/** Wire a tracker the way terminalPool does and collect the classified writes. */
function pane() {
  const term = fakeXterm();
  const tracker = attachInputSourceTracker(term);
  const writes = [];
  term.onData((data) => writes.push({ data, source: tracker.consume(data) }));
  return { term, tracker, writes };
}

test('a keystroke (onKey then onData) is a person', () => {
  const { term, writes } = pane();
  term.press('a');
  term.press('\r');
  assert.deepEqual(writes.map((w) => w.source), ['user', 'user']);
});

test('the terminal answering a startup probe (onData with no onKey) is automation', () => {
  const { term, writes } = pane();
  term.reply('\x1b[?1;2c');        // DA1 reply
  term.reply('\x1b[24;80R');       // cursor position report
  term.reply('\x1b[?997;1n');      // DSR theme reply
  assert.deepEqual(writes.map((w) => w.source), ['auto', 'auto', 'auto']);
});

test('a keyboard flag is consumed by exactly one onData', () => {
  const { term, writes } = pane();
  term.press('y');
  term.reply('\x1b[?1;2c'); // a reply right after a keystroke is still a reply
  assert.deepEqual(writes.map((w) => w.source), ['user', 'auto']);
});

test('the pane\'s paste paths flag the paste, and bracketed paste is a person even without a flag', () => {
  const { term, tracker, writes } = pane();
  tracker.notePaste();
  term.reply('plain pasted text');           // what term.paste delivers with bracketing off
  term.reply('\x1b[200~pasted\x1b[201~');    // the browser's own Ctrl+V, no flag set
  term.reply('\x1b[?1;2c');
  assert.deepEqual(writes.map((w) => w.source), ['user', 'user', 'auto']);
});

test('a stale keyboard flag does not leak onto a later reply; a paste flag survives an async clipboard read', () => {
  const tracker = createInputSourceTracker();
  tracker.noteKeyboard(1_000);
  assert.equal(tracker.consume('\x1b[?1;2c', 1_000 + KEYBOARD_FLAG_MS + 1), 'auto');
  tracker.noteKeyboard(1_000);
  assert.equal(tracker.consume('a', 1_000 + KEYBOARD_FLAG_MS), 'user');
  tracker.notePaste(5_000);
  assert.equal(tracker.consume('text', 5_000 + PASTE_FLAG_MS), 'user');
  tracker.notePaste(5_000);
  assert.equal(tracker.consume('text', 5_000 + PASTE_FLAG_MS + 1), 'auto');
});

test('IME composition (onData with no onKey, no paste wrapper) is accepted as automation', () => {
  const { term, writes } = pane();
  term.reply('日本語');
  assert.deepEqual(writes.map((w) => w.source), ['auto']);
});
