'use strict';

/**
 * A message id written by an agent becomes the name of a file in the recipient's
 * inbox. A valid, unused id is kept, because agents thread replies on their own
 * ids. Anything else must not reach the filesystem as written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-message-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  const inbox = path.join(agents, 'god-1', 'inbox');
  const route = (id, body = 'b') => {
    const msg = { to: 'god', act: 'inform', subject: 's', body };
    if (id !== undefined) msg.id = id;
    fs.writeFileSync(path.join(agents, 'worker-1', 'outbox', `m-${Math.random()}.json`), JSON.stringify(msg));
    return hive.routeOnce();
  };
  const files = () => fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
  return { hive, home, agents, inbox, route, files };
}

/** Every file under `dir`, so anything written outside the inbox shows up. */
function tree(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

const UNSAFE = [
  '../../x',
  '../x',
  '..',
  '.',
  'a/b',
  'a\\b',
  '..\\..\\x',
  '/tmp/x',
  '',
  ' ',
  '.hidden',
  'a\u0000b',
  'a\nb',
  'con',
  'NUL',
  'com1',
  'x'.repeat(129),
  42,
  null,
  ['a'],
  { toString: 'x' }
];

for (const id of UNSAFE) {
  test(`an id of ${JSON.stringify(id)?.slice(0, 24)} does not become a file name`, async (t) => {
    const { hive, inbox, route, files } = await floor(t);

    assert.equal(route(id), 1);

    const names = files();
    assert.equal(names.length, 1, 'delivered, and into the inbox');
    assert.match(names[0], /^\d{4}-\d{2}-\d{2}T[\w-]+\.json$/, 'under a minted name');
    const stored = JSON.parse(fs.readFileSync(path.join(inbox, names[0]), 'utf8'));
    assert.equal(`${stored.id}.json`, names[0], 'the message names its own file');
    assert.equal(hive.inbox('god-1')[0].body, 'b');
  });
}

test('an id of ../../x writes nothing outside the inbox', async (t) => {
  const { home, route, inbox } = await floor(t);
  const watched = (f) => !f.includes(`${path.sep}outbox${path.sep}`) && !f.endsWith('log.jsonl') && !f.split(path.sep).includes('.git');
  const before = tree(home).filter(watched);

  route('../../x');

  const added = tree(home).filter(watched).filter((f) => !before.includes(f));
  assert.equal(added.length, 1);
  assert.ok(path.join(home, added[0]).startsWith(inbox + path.sep));
});

for (const id of ['2026-11-06T04-55-07-088Z-abc123', 'worker.done_1', 'A', 'x'.repeat(128)]) {
  test(`a valid unused id is kept: ${id.slice(0, 32)}`, async (t) => {
    const { hive, route, files } = await floor(t);

    route(id);

    assert.deepEqual(files(), [`${id}.json`]);
    assert.equal(hive.inbox('god-1')[0].id, id);
  });
}

test('a message with no id gets one', async (t) => {
  const { route, files } = await floor(t);

  route(undefined);

  assert.equal(files().length, 1);
});

test('a duplicate id does not overwrite the unread message', async (t) => {
  const { hive, route, files } = await floor(t);

  route('same', 'first');
  route('same', 'second');

  assert.equal(files().length, 2);
  assert.deepEqual(hive.inbox('god-1').map((m) => m.body).sort(), ['first', 'second']);
  assert.ok(files().includes('same.json'), 'the first keeps its id');
});

test('an id already filed under inbox/.done is not reused', async (t) => {
  const { inbox, route, files } = await floor(t);
  route('same', 'first');
  fs.renameSync(path.join(inbox, 'same.json'), path.join(inbox, '.done', 'same.json'));

  route('same', 'second');

  assert.equal(files().length, 1);
  assert.notEqual(files()[0], 'same.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox, '.done', 'same.json'), 'utf8')).body, 'first');
});

test('ids differing only in case do not overwrite on a case-insensitive disk', async (t) => {
  const { hive, route } = await floor(t);

  route('Same', 'first');
  route('same', 'second');

  assert.equal(hive.inbox('god-1').length, 2);
});

test('the same id reaches two recipients under its own name in each inbox', async (t) => {
  const { hive, agents } = await floor(t);
  await hive.ensureAgent({ id: 'worker-2', name: 'Other', provider: 'claude', cwd: path.dirname(agents) });
  hive.send({ id: 'shared', to: 'god-1', act: 'inform', subject: 's', body: 'b' }, 'worker-1');
  hive.send({ id: 'shared', to: 'worker-2', act: 'inform', subject: 's', body: 'b' }, 'worker-1');

  assert.equal(hive.inbox('god-1')[0].id, 'shared');
  assert.equal(hive.inbox('worker-2')[0].id, 'shared');
});

test('in_reply_to and the rest of a message survive a replaced id', async (t) => {
  const { hive, agents } = await floor(t);
  fs.writeFileSync(path.join(agents, 'worker-1', 'outbox', 'r.json'), JSON.stringify({
    id: '../x', in_reply_to: 'earlier', conversation: 'c1', to: 'god', act: 'inform', subject: 's', body: 'b'
  }));

  hive.routeOnce();

  const [m] = hive.inbox('god-1');
  assert.equal(m.in_reply_to, 'earlier');
  assert.equal(m.conversation, 'c1');
});

test('a replaced id is logged, without the id as it was written', async (t) => {
  const { hive, route } = await floor(t);

  route('../../secret-looking-id');

  const rows = hive.logTail(100).filter((r) => r.kind === 'message-id-replaced');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'invalid');
  assert.equal(JSON.stringify(rows[0]).includes('secret-looking-id'), false);
});

test('a replaced duplicate is logged as a duplicate', async (t) => {
  const { hive, route } = await floor(t);

  route('same');
  route('same');

  const rows = hive.logTail(100).filter((r) => r.kind === 'message-id-replaced');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'duplicate');
});
