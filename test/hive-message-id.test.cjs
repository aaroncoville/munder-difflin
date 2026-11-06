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
const { isSafeMessageId, publishMessage } = loadTs('src/main/messageId.ts');

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

/** Whether names differing only in case are the same file in `dir`. */
function caseInsensitive(dir) {
  const probe = path.join(dir, 'CaseProbe');
  fs.writeFileSync(probe, '');
  const same = fs.existsSync(path.join(dir, 'caseprobe'));
  fs.rmSync(probe);
  return same;
}

test('ids differing only in case both arrive, on whichever kind of disk this is', async (t) => {
  const { hive, inbox, route, files } = await floor(t);
  const insensitive = caseInsensitive(inbox);
  t.diagnostic(`case-insensitive disk: ${insensitive}`);

  route('Same', 'first');
  route('same', 'second');

  assert.deepEqual(hive.inbox('god-1').map((m) => m.body).sort(), ['first', 'second']);
  assert.ok(files().includes('Same.json'));
  assert.equal(files().includes('same.json'), !insensitive, 'the second keeps its id only where the names are distinct');
});

test('a message that appears between choosing a name and publishing is not replaced', async (t) => {
  const { hive, inbox, route, files } = await floor(t);
  const rival = path.join(inbox, 'race.json');
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (to === rival && !fs.existsSync(rival)) fs.writeFileSync(rival, JSON.stringify({ id: 'race', body: 'rival' }));
    return link(from, to);
  });

  assert.equal(route('race', 'mine'), 1);

  assert.equal(JSON.parse(fs.readFileSync(rival, 'utf8')).body, 'rival');
  assert.deepEqual(hive.inbox('god-1').map((m) => m.body).sort(), ['mine', 'rival']);
  assert.equal(files().length, 2);
  const [mine] = hive.inbox('god-1').filter((m) => m.body === 'mine');
  assert.ok(files().includes(`${mine.id}.json`), 'the stored id names the file it ended up in');
  assert.equal(fs.readdirSync(inbox).filter((f) => f.includes('.publish-')).length, 0, 'no temporary file is left');
});

function inboxDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a minted id that collides is minted again', (t) => {
  const dir = inboxDir(t);
  fs.writeFileSync(path.join(dir, 'minted.json'), 'keep');
  fs.writeFileSync(path.join(dir, 'given.json'), 'keep');
  const mints = ['minted', 'minted', 'free'];

  const id = publishMessage(dir, { id: 'given', body: 'b' }, () => mints.shift());

  assert.equal(id, 'free');
  assert.equal(fs.readFileSync(path.join(dir, 'minted.json'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(dir, 'given.json'), 'utf8'), 'keep');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'free.json'), 'utf8')).id, 'free');
});

test('publishing gives up rather than overwrite when every minted id is taken', (t) => {
  const dir = inboxDir(t);
  fs.writeFileSync(path.join(dir, 'taken.json'), 'keep');

  assert.throws(() => publishMessage(dir, { id: 'taken' }, () => 'taken'), /free message id/);

  assert.equal(fs.readFileSync(path.join(dir, 'taken.json'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(dir), ['taken.json']);
});

test('a disk without hard links still publishes without overwriting', (t) => {
  const dir = inboxDir(t);
  fs.writeFileSync(path.join(dir, 'given.json'), 'keep');
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }); });

  const mints = ['free'];
  const id = publishMessage(dir, { id: 'given', body: 'b' }, () => mints.shift());

  assert.equal(id, 'free');
  assert.equal(fs.readFileSync(path.join(dir, 'given.json'), 'utf8'), 'keep');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'free.json'), 'utf8')).body, 'b');
});

test('a failure other than a taken name is reported, and leaves no temporary file', (t) => {
  const dir = inboxDir(t);
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }); });
  t.mock.method(fs, 'copyFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });

  assert.throws(() => publishMessage(dir, { id: 'given' }, () => 'minted'), /disk full/);

  assert.deepEqual(fs.readdirSync(dir), []);
});

const REJECTED = {
  'an empty id': '',
  'a NUL byte': 'a\u0000b',
  'a newline': 'a\nb',
  'a trailing space': 'a ',
  'a leading space': ' a',
  'parent traversal': '../x',
  'traversal inside a path': 'a/../b',
  'exactly two dots': '..',
  'exactly one dot': '.',
  'a hidden name': '.hidden',
  'only a suffix': '.json',
  'an absolute POSIX path': '/etc/passwd',
  'an absolute Windows path': 'C:\\x',
  'a drive-relative path': 'C:x',
  'a UNC path': '\\\\server\\share',
  'a backslash': 'a\\b',
  'a forward slash': 'a/b',
  'a colon, as in an alternate data stream': 'a:b',
  'one character past the limit': 'x'.repeat(129),
  'a non-ASCII letter': 'caf\u00e9',
  'a full-width dot': '\uff0e\uff0e',
  'a reserved Windows name': 'CON',
  'a reserved Windows name in lower case': 'nul',
  'a reserved Windows name with a suffix': 'lpt1.txt',
  'a reserved Windows name with .json': 'aux.json',
  'a number': 7,
  'null': null,
  'undefined': undefined,
  'an object': {},
  'an array': ['a']
};

for (const [label, id] of Object.entries(REJECTED)) {
  test(`rejected as a file name: ${label}`, () => assert.equal(isSafeMessageId(id), false));
}

// Accepted on purpose. Every id gets ".json" appended, so none of these can be more than one plain file name.
const ACCEPTED = {
  'a trailing dot, which becomes a..json': 'a.',
  'two dots inside a name, which is not a path step': 'a..b',
  'a .json suffix, which becomes x.json.json': 'x.json',
  'exactly the limit': 'x'.repeat(128),
  'a name that only starts like a reserved one': 'console',
  'a reserved name inside a longer one': 'my-con',
  'the generated form': '2026-11-06T04-55-07-088Z-abc123'
};

for (const [label, id] of Object.entries(ACCEPTED)) {
  test(`accepted as a file name: ${label}`, () => assert.equal(isSafeMessageId(id), true));
}

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
