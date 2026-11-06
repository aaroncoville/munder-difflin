'use strict';

/**
 * registry() answers a failed read with an empty roster. ensureAgent then added its one agent to that and replaced the
 * file, so a transient bad read lost every other agent and god's id for good. send() read the same empty roster, could
 * deliver neither the message nor its refusal notice, and the body was gone. A failed read now refuses the write, and a
 * send waits for a pass that can read the registry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
