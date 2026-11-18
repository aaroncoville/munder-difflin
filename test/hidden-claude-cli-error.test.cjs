'use strict';

// When the CLI cannot reach the model (signed out, login expired, an API
// error), it still writes an assistant record to the transcript: a synthetic
// one, marked isApiErrorMessage, whose text is the CLI's own message. Read as
// a model reply, a memory condense rejected it as "no parseable summary",
// which hid the real cause. These hold that such a record comes back as an
// error naming the CLI's message, and that a real reply is still text.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

loadTs.stub('node-pty', { spawn: () => { throw new Error('not used by this test'); } });
const { lastAssistantReply } = loadTs('src/main/hiddenClaude.ts');

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = { type: 'user', message: { role: 'user', content: 'You are compacting one AI agent\'s long-term memory file.' } };

// The shape a helper session wrote while its sign-in had lapsed.
const loginExpired = {
  type: 'assistant',
  error: 'authentication_failed',
  isApiErrorMessage: true,
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] }
};

test("the CLI's own error message comes back as an error, not as a reply", () => {
  const out = lastAssistantReply(jsonl(user, loginExpired));
  assert.equal(out.text, undefined);
  assert.match(out.error, /authentication_failed/);
  assert.match(out.error, /Login expired · Please run \/login/);
});

test('a real model reply is returned as text', () => {
  const reply = { type: 'assistant', message: { model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: '===CONDENSED===\nkept' }] } };
  assert.deepEqual(lastAssistantReply(jsonl(user, reply)), { text: '===CONDENSED===\nkept' });
});

test('an error record is reported even without an error code', () => {
  const { error: _drop, ...noCode } = loginExpired;
  const out = lastAssistantReply(jsonl(user, noCode));
  assert.match(out.error, /Login expired/);
});

test('no assistant record at all is null, so the transcript race can still be retried', () => {
  assert.equal(lastAssistantReply(jsonl(user)), null);
  assert.equal(lastAssistantReply(''), null);
});
