'use strict';

/**
 * registry() answers a failed read with an empty roster. ensureAgent then added its one agent to that and replaced the
 * file, so a transient bad read lost every other agent and god's id for good. send() read the same empty roster, could
 * deliver neither the message nor its refusal notice, and the body was gone. A failed read now refuses the write, and a
 * send fails where its caller can see.
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
const { RegistryUnreadable } = loadTs('src/main/messageTarget.ts');

async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-registry-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'One', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Two', provider: 'claude', cwd: home });
  const file = path.join(hive.root(), 'registry.json');
  const good = fs.readFileSync(file, 'utf8');
  return { hive, home, file, good, agents: path.join(hive.root(), 'agents'), repair: () => fs.writeFileSync(file, good) };
}

const BAD = {
  'not JSON': '{"agents":',
  'empty': '',
  'an array': '[]',
  'null': 'null',
  'a number': '7',
  'an object with no roster': '{}',
  'a roster that is null': '{"godId":"god-1","agents":null}',
  'a roster that is an array': '{"godId":"god-1","agents":[]}',
  'a roster that is text': '{"godId":"god-1","agents":"x"}'
};
const rows = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

for (const [label, content] of Object.entries(BAD)) {
  test(`with a registry that is ${label}, a new agent is refused and the file is left exactly as it was`, async (t) => {
    const f = await setup(t);
    fs.writeFileSync(f.file, content);

    await assert.rejects(
      f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home }),
      (e) => e instanceof RegistryUnreadable
    );

    assert.equal(fs.readFileSync(f.file, 'utf8'), content, 'the file was replaced');
    assert.equal(fs.existsSync(path.join(f.agents, 'worker-3')), false, 'no workspace either');
    assert.equal(rows(f.hive, 'registry-write-refused').length, 1);

    f.repair();
    await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
    assert.deepEqual(Object.keys(f.hive.registry().agents).sort(), ['god-1', 'worker-1', 'worker-2', 'worker-3'], 'every agent survived');
    assert.equal(f.hive.registry().godId, 'god-1');
  });
}

test('an existing agent is refused too: restoring one must not replace the roster with it alone', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  await assert.rejects(f.hive.ensureAgent({ id: 'worker-1', name: 'One', provider: 'claude', cwd: f.home }), RegistryUnreadable);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{');
});

test('the refusal says what is wrong, and names no path', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  await assert.rejects(f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home }), (e) => {
    assert.match(e.message, /registry/i);
    assert.equal(e.message.includes(f.home), false);
    return true;
  });
});

test('a first agent on a new hive, with no file yet, still provisions', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-registry-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  assert.equal(hive.registry().godId, 'god-1');
});

test('a valid empty roster is a roster: an agent can join it', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{"godId":null,"agents":{}}');
  await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
  assert.deepEqual(Object.keys(f.hive.registry().agents), ['worker-3']);
});

// These already stop at "agent not found" on a failed read. Pinned so that stays true.
for (const [label, write] of [
  ['setArchived', (h) => h.setArchived('worker-1', true)],
  ['patchAgentRole', (h) => h.patchAgentRole('worker-1', 'new role')],
  ['setAgentHold', (h) => h.setAgentHold('worker-1', true)],
  ['renameAgent', (h) => h.renameAgent('worker-1', 'New Name')],
  ['recordSession', (h) => h.recordSession('worker-1', 'session-1')]
]) {
  test(`${label} leaves a registry it cannot read exactly as it was`, async (t) => {
    const f = await setup(t);
    assert.equal(typeof f.hive[label], 'function', `no ${label} on the hive`);
    fs.writeFileSync(f.file, '{"agents":');
    write(f.hive);
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{"agents":');
  });
}

// ---- send ----
// A send has only one copy of its body, in the caller's hands. Holding it in memory would report success for something
// a restart loses, and a file under the hive root could carry any sender, so a bad read fails where the caller can see.

const message = (to, body = 'the unique body') => ({ to, act: 'inform', subject: 'subject', body });

for (const [label, content] of Object.entries(BAD)) {
  test(`with a registry that is ${label}, a send fails visibly and claims nothing`, async (t) => {
    const f = await setup(t);
    fs.writeFileSync(f.file, content);
    assert.throws(() => f.hive.send(message('worker-2', 'SECRET-BODY'), 'worker-1'), (e) => {
      assert.ok(e instanceof RegistryUnreadable);
      assert.equal(e.code, 'registry-unreadable');
      assert.equal(e.message.includes(f.home), false, 'no path');
      assert.equal(e.message.includes('SECRET-BODY'), false);
      return true;
    });
    const [row, ...others] = rows(f.hive, 'send-refused');
    assert.deepEqual(others, [], 'one row');
    assert.deepEqual([row.from, row.to], ['"worker-1"', '"worker-2"']);
    assert.ok(row.id);
    assert.equal(JSON.stringify(row).includes('SECRET-BODY'), false, 'the log does not hold the body');
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
  });
}

test('nothing is kept to go out later: a repaired registry delivers only what is sent again', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  assert.throws(() => f.hive.send(message('worker-2', 'first'), 'worker-1'), RegistryUnreadable);
  f.repair();
  f.hive.routeOnce();
  assert.deepEqual(f.hive.inbox('worker-2'), []);
  f.hive.send(message('worker-2', 'second'), 'worker-1');
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => m.body), ['second']);
});

test('with a readable registry a send goes straight out, as ever', async (t) => {
  const f = await setup(t);
  const sent = f.hive.send(message('worker-2'), 'worker-1');
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => [m.id, m.body]), [[sent.id, 'the unique body']]);
  assert.deepEqual(rows(f.hive, 'send-refused'), []);
});

test('a send to an unknown target with a readable registry still tells its sender, with the body', async (t) => {
  const f = await setup(t);
  f.hive.send(message('nobody'), 'worker-1');
  const [notice] = f.hive.inbox('worker-1');
  assert.match(notice.subject, /not delivered/);
  assert.match(notice.body, /the unique body/);
});

test('a hive with no home still takes a send without throwing', () => {
  const hive = new HiveManager(() => null);
  assert.doesNotThrow(() => hive.send(message('worker-2'), 'worker-1'));
});

// ---- one read per operation ----
// A guard that reads and a consumer that reads again can disagree. These change the file in the gap.

function changeFileAfterNextRead(f, content) {
  const read = f.hive.readableRegistry.bind(f.hive);
  f.hive.readableRegistry = () => {
    const roster = read();
    fs.writeFileSync(f.file, content);
    f.hive.readableRegistry = read;
    return roster;
  };
}

test('a send whose registry goes bad right after it is read is delivered from that read, not lost', async (t) => {
  const f = await setup(t);
  changeFileAfterNextRead(f, '{"agents":');
  const sent = f.hive.send(message('worker-2'), 'worker-1');
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => [m.id, m.body]), [[sent.id, 'the unique body']]);
  assert.deepEqual(f.hive.inbox('worker-1'), [], 'no refusal: its target was on the roster it read');
  assert.deepEqual(rows(f.hive, 'drop'), []);
});

test('a send to an unknown target in that gap still reaches its sender, from the same read', async (t) => {
  const f = await setup(t);
  changeFileAfterNextRead(f, '{"agents":');
  f.hive.send(message('nobody'), 'worker-1');
  f.repair();
  assert.match(f.hive.inbox('worker-1')[0].body, /the unique body/);
});

test('the read does not outlive the send, even one that throws', async (t) => {
  const f = await setup(t);
  const route = f.hive.routeMessage;
  f.hive.routeMessage = () => { throw new Error('disk full'); };
  assert.throws(() => f.hive.send(message('worker-2'), 'worker-1'), /disk full/);
  f.hive.routeMessage = route;
  await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
  f.hive.send(message('worker-3'), 'worker-1');
  assert.equal(f.hive.inbox('worker-3').length, 1, 'a later send sees the current roster');
});

test('a send made inside a routing pass uses the pass\'s read, and does not fail on the file', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.agents, 'worker-1', 'outbox', 'x.json'), JSON.stringify(message('worker-2', 'routed')));
  let once = false;
  f.hive.setRoutedObserver(() => {
    if (once) return;
    once = true;
    fs.writeFileSync(f.file, '{"agents":');
    f.hive.send(message('worker-1', 'from the observer'), 'god-1');
  });
  assert.equal(f.hive.routeOnce(), 1);
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-1').map((m) => m.body), ['from the observer']);
  assert.deepEqual(rows(f.hive, 'send-refused'), []);
});

test('a nested send inside a send keeps the outer read, and the outer read ends with the outer send', async (t) => {
  const f = await setup(t);
  let once = false;
  f.hive.setRoutedObserver(() => {
    if (once) return;
    once = true;
    fs.writeFileSync(f.file, '{"agents":');
    f.hive.send(message('worker-1', 'nested'), 'god-1');
  });
  f.hive.send(message('worker-2', 'outer'), 'worker-1');
  f.hive.setRoutedObserver(null);
  assert.throws(() => f.hive.send(message('worker-2', 'after'), 'worker-1'), RegistryUnreadable, 'the file is read again once the outer send is over');
  f.repair();
  assert.deepEqual(f.hive.inbox('worker-1').map((m) => m.body), ['nested']);
});

for (const [label, content] of [
  ['corrupted', '{"agents":'],
  ['replaced by another valid roster', '{"godId":"other","agents":{"other":{"id":"other"}}}'],
  ['emptied to a valid empty roster', '{"godId":null,"agents":{}}']
]) {
  test(`ensureAgent writes nothing to a registry ${label} since it read it`, async (t) => {
    const f = await setup(t);
    const read = f.hive.readableRegistry.bind(f.hive);
    f.hive.readableRegistry = () => {
      const roster = read();
      fs.writeFileSync(f.file, content);
      f.hive.readableRegistry = read;
      return roster;
    };

    await assert.rejects(f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home }), RegistryUnreadable);

    assert.equal(fs.readFileSync(f.file, 'utf8'), content, 'someone else\'s change was overwritten');
    assert.equal(rows(f.hive, 'registry-write-refused').length, 1);
  });
}

test('ensureAgent reads the registry once: its check and its write use the same roster', async (t) => {
  const f = await setup(t);
  await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
  const onDisk = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.agents).sort(), ['god-1', 'worker-1', 'worker-2', 'worker-3']);
  assert.equal(onDisk.godId, 'god-1');
});

// ---- the callers ----

function ast(file) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  return { source, tree: ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true) };
}

/** Every `<receiver>.send(` on the hive that is not inside a try block, by enclosing line text. */
function unguardedSends(file) {
  const { tree } = ast(file);
  const found = [];
  const visit = (node, guarded) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'send') {
      const receiver = node.expression.expression.getText(tree);
      if ((receiver === 'hive' || receiver === 'this.hive') && !guarded) found.push(node.getText(tree).slice(0, 60));
    }
    if (ts.isTryStatement(node)) {
      visit(node.tryBlock, true);
      if (node.catchClause) visit(node.catchClause, guarded);
      if (node.finallyBlock) visit(node.finallyBlock, guarded);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, guarded));
  };
  visit(tree, false);
  return found;
}

test('every hive.send in the main process is guarded, so a failed send cannot escape a timer', () => {
  assert.deepEqual(unguardedSends('src/main/index.ts').filter((c) => !c.startsWith('hive.send(partial, from)')), [],
    'the realtime dependency is the one exception: its callers are inside the action handler\'s own try');
  // closing time's conclusion runs from the routed observer, inside a pass, which never fails on a read.
  // Its first message is guarded by start(), around begin(), so that is not a try at the call site either.
  assert.deepEqual(unguardedSends('src/main/closingTime.ts').map((c) => c.split('\n')[0]), ['this.hive.send({', 'this.hive.send({']);
});

function statement(file, startsWith) {
  const { tree } = ast(file);
  const node = tree.statements.find((n) => n.getText(tree).startsWith(startsWith));
  assert.ok(node, `${startsWith} in ${file}`);
  return ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test('the hive:send handler answers ok:false with the code, and counts nothing as sent', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  let handler;
  let counted = 0;
  vm.runInNewContext(statement('src/main/index.ts', "ipcMain.handle('hive:send'"), {
    hive: { enabled: () => true, send: (...a) => f.hive.send(...a) },
    analytics: { trackMessageSent: () => { counted += 1; } },
    RegistryUnreadable,
    ipcMain: { handle: (_c, fn) => { handler = fn; } }
  });
  const result = await handler({}, message('worker-2'), 'human');
  assert.deepEqual({ ...result }, { ok: false, code: 'registry-unreadable', error: result.error });
  assert.match(result.error, /registry/i);
  assert.equal(counted, 0, 'a refused message is never counted');
});

test('the hive:send handler does not disguise any other failure as an unreadable registry', async () => {
  let handler;
  vm.runInNewContext(statement('src/main/index.ts', "ipcMain.handle('hive:send'"), {
    hive: { enabled: () => true, send: () => { throw new Error('disk full'); } },
    analytics: { trackMessageSent() {} },
    RegistryUnreadable,
    ipcMain: { handle: (_c, fn) => { handler = fn; } }
  });
  assert.throws(() => handler({}, message('worker-2'), 'human'), /disk full/);
});

test('sendOrLog logs a failed send instead of throwing into its timer', () => {
  const errors = [];
  const js = ts.transpileModule(`${ast('src/main/index.ts').tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'sendOrLog').getFullText()}\n;sendOrLog`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sendOrLog = vm.runInNewContext(js, {
    hive: { send: () => { throw new RegistryUnreadable('The registry could not be read.'); } },
    console: { error: (...a) => errors.push(a.join(' ')) }
  });
  assert.doesNotThrow(() => sendOrLog({ subject: 'Heartbeat' }, 'heartbeat'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Heartbeat/);
  assert.match(errors[0], /could not be read/);
});

test('closing time does not start, or stay stuck active, when its first message cannot be sent', async (t) => {
  const f = await setup(t);
  const { ClosingTimeController } = loadTs('src/main/closingTime.ts');
  const closing = new ClosingTimeController({
    registry: () => f.hive.registry(),
    send: () => { throw new RegistryUnreadable('The registry could not be read.'); }
  }, () => ['god-1', 'worker-1'], () => null, () => {});
  t.after(() => closing.cancel());
  const result = closing.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be read/);
  assert.equal(closing.isActive(), false);
});
