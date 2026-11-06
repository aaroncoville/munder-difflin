'use strict';

/**
 * A routing pass reads the registry once. Sender admission used that read, but routing read the file again for each
 * message and treated a failed read as an empty roster, so a registry corrupted between those reads refused valid mail
 * as an unknown recipient and set it aside with no notice. One read now governs the whole pass.
 *
 * The file is corrupted at exact points in a real pass: right after the pass's read, or from the routed observer
 * between two messages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { CodexThreads } = loadTs('src/main/codexThread.ts');

async function setup(t, emit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-routing-snapshot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home, emit);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'One', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Two', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  const file = path.join(hive.root(), 'registry.json');
  const good = fs.readFileSync(file, 'utf8');
  const corrupt = () => fs.writeFileSync(file, '{"agents":');
  const repair = () => fs.writeFileSync(file, good);
  /** Corrupts the file the moment the pass has its read. */
  const corruptAfterPassRead = () => {
    const read = hive.readableRegistry.bind(hive);
    hive.readableRegistry = () => {
      const roster = read();
      corrupt();
      return roster;
    };
  };
  const write = (name, to, from = 'worker-1', extra = {}) => fs.writeFileSync(
    path.join(agents, from, 'outbox', name),
    JSON.stringify({ to, act: 'inform', subject: name, body: `body of ${name}`, ...extra })
  );
  const sentDir = (from = 'worker-1') => fs.readdirSync(path.join(agents, from, 'outbox', '.sent'));
  const dropped = () => hive.logTail(500).filter((e) => e.kind === 'drop' || e.kind === 'outbox-error');
  return { hive, home, agents, file, good, corrupt, repair, corruptAfterPassRead, write, sentDir, dropped };
}

test('a registry corrupted right after the pass reads it does not set valid mail aside', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'worker-2');
  f.corruptAfterPassRead();

  assert.equal(f.hive.routeOnce(), 1);

  assert.deepEqual(f.sentDir(), ['x.json'], 'filed as sent, not bad-x.json');
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => m.body), ['body of x.json']);
  assert.deepEqual(f.dropped(), []);
});

test('a registry corrupted between two messages does not affect the second', async (t) => {
  const f = await setup(t);
  f.write('a.json', 'worker-2');
  f.write('b.json', 'worker-2');
  f.hive.setRoutedObserver(() => f.corrupt());

  assert.equal(f.hive.routeOnce(), 2);

  assert.deepEqual(f.sentDir().sort(), ['a.json', 'b.json']);
  f.repair();
  assert.equal(f.hive.inbox('worker-2').length, 2);
});

for (const [label, to, check] of [
  ['god by name', 'god', (f) => assert.equal(f.hive.inbox('god-1').length, 1)],
  ['human', 'human', (f) => assert.equal(f.hive.inbox('god-1').length, 1)],
  ['a near spelling of an agent', 'WORKER-2', (f) => assert.equal(f.hive.inbox('worker-2').length, 1)],
  ['an app sender, which surfaces to god', 'heartbeat', (f) => assert.equal(f.hive.inbox('god-1').length, 1)],
  ['a broadcast', 'broadcast', (f) => assert.equal(f.hive.inbox('worker-2').length, 1)]
]) {
  test(`mid-pass corruption leaves mail to ${label} delivered`, async (t) => {
    const f = await setup(t);
    f.write('x.json', to);
    f.corruptAfterPassRead();
    assert.equal(f.hive.routeOnce(), 1);
    assert.deepEqual(f.sentDir(), ['x.json']);
    f.repair();
    check(f);
  });
}

test('mid-pass corruption does not stop a real refusal, or lose its notice', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'nobody');
  f.corruptAfterPassRead();
  assert.equal(f.hive.routeOnce(), 0);
  assert.deepEqual(f.sentDir(), ['bad-x.json']);
  assert.ok(f.dropped().some((e) => e.kind === 'outbox-error' && e.stage === 'recipient'), 'classified from the same read');
  f.repair();
  const notices = f.hive.inbox('worker-1');
  assert.equal(notices.length, 1, 'the sender is still told');
  assert.match(notices[0].body, /recipient/);
});

test('mid-pass corruption does not stop a folder off the roster being refused, or god being told', async (t) => {
  const f = await setup(t);
  const stray = path.join(f.agents, 'stray', 'outbox');
  fs.mkdirSync(path.join(stray, '.sent'), { recursive: true });
  fs.writeFileSync(path.join(stray, 'x.json'), JSON.stringify({ to: 'worker-2', act: 'inform', subject: 's', body: 'b' }));
  f.corruptAfterPassRead();
  assert.equal(f.hive.routeOnce(), 0);
  assert.equal(fs.existsSync(path.join(stray, '.sent', 'bad-x.json')), true);
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-2'), []);
  assert.equal(f.hive.inbox('god-1').length, 1);
});

test('mid-pass corruption leaves a hookless agent its terminal handoff, an archived agent its filing, and a notice its way', async (t) => {
  const handoffs = [];
  const f = await setup(t, (channel, payload) => { if (channel === 'hive:terminalHandoff') handoffs.push(payload.to); return true; });
  const reg = JSON.parse(f.good);
  reg.agents['worker-2'].archived = true;
  reg.agents.hookless = { id: 'hookless', name: 'H', provider: 'custom', cwd: '.' };
  fs.writeFileSync(f.file, JSON.stringify(reg));
  const after = JSON.stringify(reg);
  f.write('a.json', 'hookless');
  f.write('b.json', 'worker-2', 'worker-1', { act: 'request', requires_reply: true });
  f.corruptAfterPassRead();

  assert.equal(f.hive.routeOnce(), 2);

  assert.deepEqual(handoffs, ['hookless']);
  fs.writeFileSync(f.file, after);
  assert.equal(f.hive.inbox('worker-2').length, 1, 'filed for the archived agent');
  assert.match(f.hive.inbox('worker-1')[0].subject, /no one is there to answer/, 'and its sender is told');
});

test('a send from the routed observer during a pass uses the same read', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'worker-2');
  let sent = false;
  f.hive.setRoutedObserver(() => {
    if (sent) return;
    sent = true;
    f.corrupt();
    f.hive.send({ to: 'worker-1', act: 'inform', subject: 'from the observer', body: 'b' }, 'god-1');
  });
  f.hive.routeOnce();
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-1').map((m) => m.subject), ['from the observer']);
  assert.deepEqual(f.dropped(), []);
});

test('an observer send to an unknown target during a pass still tells its sender', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'worker-2');
  let sent = false;
  f.hive.setRoutedObserver(() => {
    if (sent) return;
    sent = true;
    f.corrupt();
    f.hive.send({ to: 'nobody', act: 'inform', subject: 'lost', body: 'b' }, 'worker-1');
  });
  f.hive.routeOnce();
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-1').map((m) => m.subject), ['[not delivered] lost'], 'a fresh read would not know this sender');
  assert.deepEqual(f.hive.inbox('god-1'), []);
});

// Removing both inboxes makes delivery and its bounce fail, which is the one way a known target can come back false.
test('an observer send to a known target that cannot be delivered is not reported as an unknown one', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'worker-2');
  let sent = false;
  f.hive.setRoutedObserver(() => {
    if (sent) return;
    sent = true;
    fs.rmSync(path.join(f.agents, 'worker-2', 'inbox'), { recursive: true });
    fs.rmSync(path.join(f.agents, 'god-1', 'inbox'), { recursive: true });
    f.corrupt();
    f.hive.send({ to: 'worker-2', act: 'inform', subject: 'undeliverable', body: 'b' }, 'worker-1');
  });
  f.hive.routeOnce();
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-1'), [], 'its recipient is on the roster, so "not on the roster" would be false');
});

test('mail to a known target that cannot be delivered is classified from the pass\'s read, not as a bad recipient', async (t) => {
  const f = await setup(t);
  fs.rmSync(path.join(f.agents, 'worker-2', 'inbox'), { recursive: true });
  fs.rmSync(path.join(f.agents, 'god-1', 'inbox'), { recursive: true });
  f.write('x.json', 'worker-2');
  f.corruptAfterPassRead();
  assert.equal(f.hive.routeOnce(), 0);
  assert.ok(f.dropped().some((e) => e.kind === 'outbox-error' && e.stage === 'not-delivered'), JSON.stringify(f.dropped()));
  assert.equal(f.dropped().some((e) => e.kind === 'outbox-error' && e.stage === 'recipient'), false);
});

// The reason the pass's read is private to routing: a writer using it would put back whatever changed since.
test('a registry write during a pass starts from the file, so it cannot undo a change made since the pass read it', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'worker-2');
  let done = false;
  f.hive.setRoutedObserver(() => {
    if (done) return;
    done = true;
    const reg = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    reg.agents['added-mid-pass'] = { id: 'added-mid-pass', name: 'A', provider: 'claude', cwd: '.' };
    fs.writeFileSync(f.file, JSON.stringify(reg));
    f.hive.setArchived('worker-2', true);
  });
  f.hive.routeOnce();
  const onDisk = JSON.parse(fs.readFileSync(f.file, 'utf8')).agents;
  assert.ok(onDisk['added-mid-pass'], 'the write put back a stale copy of the roster');
  assert.equal(onDisk['worker-2'].archived, true);
});

// ---- the production observer, with real thread records ----

const WORKER = 'reviewer';

/** The real observer statement from index.ts, on a real hive and real thread records. */
async function codexFloor(t) {
  let corruptNextMessage = false;
  let hive;
  const f = await setup(t, (channel) => {
    // After delivery, before the observer: the point the observer's own reads are exposed.
    if (channel === 'hive:message' && corruptNextMessage) {
      corruptNextMessage = false;
      fs.writeFileSync(path.join(hive.root(), 'registry.json'), '{"agents":');
    }
    return true;
  });
  hive = f.hive;
  const reg = JSON.parse(f.good);
  reg.agents[WORKER] = { id: WORKER, name: 'Reviewer', provider: 'codex', cwd: '.' };
  const roster = JSON.stringify(reg);
  fs.writeFileSync(f.file, roster);
  for (const dir of ['inbox/.done', 'outbox/.sent']) fs.mkdirSync(path.join(f.agents, WORKER, dir), { recursive: true });

  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const statement = ast.statements.find((n) => ts.isExpressionStatement(n) && n.getText(ast).startsWith('hive.setRoutedObserver('));
  assert.ok(statement, 'the routed observer is registered at the top level of index.ts');
  const js = ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const threads = new CodexThreads((id) => path.join(f.agents, id, 'hive-thread.json'));
  vm.runInNewContext(js, { hive, closingTime: { onRouted() {} }, codexThreads: threads });
  threads.spawned(WORKER, false);

  const fromFolder = (from, name, msg) => fs.writeFileSync(path.join(f.agents, from, 'outbox', `${name}.json`), JSON.stringify({ id: name, ...msg }));
  const isAgent = (id) => Object.hasOwn(reg.agents, id);
  return {
    ...f, threads, isAgent, fromFolder,
    repair: () => fs.writeFileSync(f.file, roster),
    corruptOnNextDelivery: () => { corruptNextMessage = true; }
  };
}

test('corruption before the observer leaves a Codex worker\'s outgoing id on its thread, and a reply continues it', async (t) => {
  const f = await codexFloor(t);
  f.fromFolder('god-1', 'review-1', { to: WORKER, act: 'request', subject: 's', body: 'b' });
  f.hive.routeOnce();
  assert.ok(f.threads.get(WORKER).ids.includes('review-1'));

  f.fromFolder(WORKER, 'report-1', { to: 'god', act: 'done', in_reply_to: 'review-1', subject: 's', body: 'b' });
  f.corruptOnNextDelivery();
  f.hive.routeOnce();
  f.repair();

  assert.ok(f.threads.get(WORKER).ids.includes('report-1'), 'the outgoing id went unrecorded');
  f.fromFolder('god-1', 'fix-1', { to: WORKER, act: 'request', in_reply_to: 'report-1', subject: 's', body: 'b' });
  f.hive.routeOnce();
  const pending = f.hive.inbox(WORKER).filter((m) => m.id === 'fix-1');
  assert.equal(pending.length, 1);
  assert.deepEqual(f.threads.due(WORKER, pending, f.isAgent), [], 'the reply would open a new thread and lose its context');
});

test('corruption before the observer still lets a request join the thread whose mail is pending', async (t) => {
  const f = await codexFloor(t);
  f.fromFolder('god-1', 'review-1', { to: WORKER, act: 'request', subject: 's', body: 'b' });
  f.hive.routeOnce();
  f.fromFolder(WORKER, 'report-1', { to: 'god', act: 'done', in_reply_to: 'review-1', subject: 's', body: 'b' });
  f.hive.routeOnce();

  f.fromFolder('god-1', 'review-2', { to: WORKER, act: 'request', subject: 's', body: 'b' });
  f.corruptOnNextDelivery();
  f.hive.routeOnce();
  f.repair();

  assert.ok(f.threads.get(WORKER).ids.includes('review-2'), 'the inbox read during the observer saw nothing pending');
});

test('corruption during a pass does not make an archived worker look live and hold up closing time', async (t) => {
  let corruptOnMessage = false;
  let hive;
  const f = await setup(t, (channel) => {
    if (channel === 'hive:message' && corruptOnMessage) {
      corruptOnMessage = false;
      fs.writeFileSync(path.join(hive.root(), 'registry.json'), '{"agents":');
    }
    return true;
  });
  hive = f.hive;
  const { ClosingTimeController } = loadTs('src/main/closingTime.ts');
  const closing = new ClosingTimeController(hive, () => ['god-1', 'worker-1', 'worker-2'], () => null, () => {});
  t.after(() => closing.cancel());
  hive.setRoutedObserver((msg, targets) => closing.onRouted(msg, targets));
  assert.equal(closing.start().ok, true);
  f.write('ack.json', 'god', 'worker-1', { subject: 'CLOSING-TIME-ACK' });
  hive.routeOnce();
  hive.setArchived('worker-2', true);
  fs.writeFileSync(path.join(f.agents, 'god-1', 'outbox', 'complete.json'), JSON.stringify({ to: 'human', act: 'inform', subject: 'CLOSING-TIME-COMPLETE', body: 'b' }));
  corruptOnMessage = true;

  hive.routeOnce();

  f.repair();
  const rejected = hive.inbox('god-1').filter((m) => m.subject.includes('conclusion rejected'));
  assert.deepEqual(rejected.map((m) => m.body.split('\n')[0]), [], 'worker-2 is archived on the roster this pass read, so its ACK is excused');
});

test('outside a pass, a caller\'s id is still checked against the file', async (t) => {
  const f = await setup(t);
  f.hive.routeOnce();
  fs.writeFileSync(f.file, '{"agents":');
  assert.throws(() => f.hive.checkAgentId('worker-1'), /unknown/);
  assert.deepEqual(f.hive.inbox('worker-1'), []);
});

test('the next pass reads again: mail waits while the file is bad and goes once it is repaired', async (t) => {
  const f = await setup(t);
  f.write('a.json', 'worker-2');
  f.hive.setRoutedObserver(() => f.corrupt());
  assert.equal(f.hive.routeOnce(), 1);
  f.hive.setRoutedObserver(null);

  f.write('b.json', 'worker-2');
  assert.equal(f.hive.routeOnce(), 0, 'the bad file is seen on the next pass');
  assert.equal(fs.existsSync(path.join(f.agents, 'worker-1', 'outbox', 'b.json')), true);
  f.repair();
  assert.equal(f.hive.routeOnce(), 1);
});

test('the read does not outlive its pass, even a pass that throws', async (t) => {
  const f = await setup(t);
  f.write('a.json', 'worker-2');
  const commit = f.hive.commit;
  f.hive.commit = () => { throw new Error('commit failed'); };
  assert.throws(() => f.hive.routeOnce(), /commit failed/);
  f.hive.commit = commit;

  await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
  f.hive.send({ to: 'worker-3', act: 'inform', subject: 's', body: 'b' }, 'god-1');
  assert.equal(f.hive.inbox('worker-3').length, 1, 'a send after the pass sees the current roster');
  f.write('b.json', 'worker-3');
  assert.equal(f.hive.routeOnce(), 1, 'and so does the next pass');
});

test('a registry change between passes is seen, and a send outside a pass reads the file itself', async (t) => {
  const f = await setup(t);
  f.hive.routeOnce();
  await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
  f.write('x.json', 'worker-3');
  assert.equal(f.hive.routeOnce(), 1);
  f.hive.send({ to: 'worker-3', act: 'inform', subject: 's', body: 'b' }, 'god-1');
  assert.equal(f.hive.inbox('worker-3').length, 2);
});

test('an agent\'s own registry write during a pass still lands on the file, not on the pass\'s read', async (t) => {
  const f = await setup(t);
  f.write('x.json', 'worker-2');
  f.hive.setRoutedObserver(() => f.hive.setArchived('worker-2', true));
  f.hive.routeOnce();
  assert.equal(f.hive.registry().agents['worker-2'].archived, true);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).agents['worker-2'].archived, true);
});
