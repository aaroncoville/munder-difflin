'use strict';
// The heartbeat digest names the agents whose inbox still holds mail. A message
// stays in the inbox until the agent has handled it and filed it, so an agent
// that is busy working a message is listed as well as one that never looked.
// The digest tells the two apart: an agent that has taken a turn since a
// message was delivered has claimed it; one that has not, has not.
//
// The delivery time is the file's mtime, written by the router when it
// delivers. created_at is not used: a sender can put any time there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const claims = loadTs('src/main/inboxClaims.ts');
const REPO = path.resolve(__dirname, '..');
const T0 = Date.parse('2026-11-10T12:00:00Z');

/** A hive root on disk; `inboxes` maps agent id → delivery times (ms). */
function hiveOn(inboxes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-claims-'));
  for (const [id, times] of Object.entries(inboxes)) {
    const dir = path.join(root, 'agents', id, 'inbox');
    fs.mkdirSync(path.join(dir, '.done'), { recursive: true });
    times.forEach((t, i) => {
      const file = path.join(dir, `m${i}.json`);
      // A created_at far from the delivery time: only the mtime may count.
      fs.writeFileSync(file, JSON.stringify({ id: `m${i}`, created_at: new Date(t + 3_600_000).toISOString() }));
      fs.utimesSync(file, new Date(t), new Date(t));
    });
  }
  return root;
}

function digestSource() {
  const src = fs.readFileSync(path.join(REPO, 'src/main/index.ts'), 'utf8');
  const start = src.indexOf('function buildHeartbeatDigest(');
  const end = src.indexOf('/** Senders whose mail', start);
  assert.ok(start >= 0 && end > start, 'buildHeartbeatDigest located in index.ts');
  return ts.transpileModule(src.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

/**
 * The real digest builder, cut out of index.ts, on a floor whose agents have
 * the given inboxes and last turns. `turns` maps id → { hook, usage, spans }.
 */
function digestOn(inboxes, turns = {}) {
  const root = hiveOn(inboxes);
  const agents = Object.fromEntries(Object.keys({ ...inboxes, ...turns }).map((id) => [id, { name: id[0].toUpperCase() + id.slice(1) }]));
  const ctx = vm.createContext({
    Date, Math, JSON,
    join: path.join,
    hive: {
      root: () => root,
      registry: () => ({ godId: 'god', agents }),
      board: () => '',
      logTail: () => [],
      inbox: (id) => (inboxes[id] ?? []).map((_, i) => ({ id: `m${i}` }))
    },
    workerWake: { turnHookAt: (id) => turns[id]?.hook ?? 0 },
    telemetry: {
      getAgentUsage: (id) => turns[id]?.usage ?? null,
      getSpans: (id) => turns[id]?.spans ?? []
    },
    ...claims
  });
  vm.runInContext(digestSource(), ctx);
  try {
    return ctx.buildHeartbeatDigest(600_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const inboxLineOf = (digest) => digest.split('\n').find((l) => /inbox/i.test(l) && !/^Floor heartbeat/.test(l));

test('an agent that has taken a turn since its mail arrived is listed as claimed, not as unclaimed', () => {
  const line = inboxLineOf(digestOn({ jc: [T0] }, { jc: { hook: T0 + 60_000 } }));
  assert.match(line, /claimed[^:]*: Jc ×1/);
  assert.match(line, /unclaimed[^:]*: none/);
});

test('an agent with no turn since its mail arrived is listed as unclaimed', () => {
  const line = inboxLineOf(digestOn({ jc: [T0] }, { jc: { hook: T0 - 60_000 } }));
  assert.match(line, /unclaimed[^:]*: Jc ×1/);
  assert.match(line, /; claimed[^:]*: none/);
});

test('an agent that has never taken a turn is listed as unclaimed', () => {
  assert.match(inboxLineOf(digestOn({ jc: [T0] })), /unclaimed[^:]*: Jc ×1/);
});

test('telemetry counts as a turn: a tool span, or a usage sample with tokens', () => {
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { jc: { spans: [{ ts: T0 + 1_000 }] } })), /; claimed[^:]*: Jc ×1/);
  const worked = { ts: T0 + 1_000, input: 10, output: 5 };
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { jc: { usage: worked } })), /; claimed[^:]*: Jc ×1/);
  // The zero-token sample stamped when a session starts is not a turn.
  const idle = { ts: T0 + 1_000, input: 0, output: 0 };
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { jc: { usage: idle } })), /unclaimed[^:]*: Jc ×1/);
});

test('mail delivered after the last turn is unclaimed even when older mail was claimed', () => {
  const line = inboxLineOf(digestOn({ jc: [T0, T0 + 120_000] }, { jc: { hook: T0 + 60_000 } }));
  assert.match(line, /unclaimed[^:]*: Jc ×1/);
  assert.match(line, /; claimed[^:]*: Jc ×1/);
});

test('the delivery time is the file mtime, not the created_at the sender wrote', () => {
  // created_at reads an hour after the turn; the file was delivered before it.
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { jc: { hook: T0 + 60_000 } })), /; claimed[^:]*: Jc ×1/);
});

test('a floor with no mail waiting still says so', () => {
  assert.equal(inboxLineOf(digestOn({ jc: [] })), 'No undrained inboxes.');
});

test('only delivered messages count: filed mail, other files and a missing inbox do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-claims-'));
  try {
    const dir = path.join(root, 'agents', 'jc', 'inbox');
    fs.mkdirSync(path.join(dir, '.done'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.done', 'old.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    fs.writeFileSync(path.join(dir, 'new.json.tmp'), '{}');
    fs.writeFileSync(path.join(dir, 'new.json'), '{}');
    assert.equal(claims.inboxDeliveredAt(root, 'jc').length, 1);
    assert.deepEqual(claims.inboxDeliveredAt(root, 'nobody'), []);
    assert.deepEqual(claims.inboxDeliveredAt(null, 'jc'), []);
    assert.deepEqual(claims.inboxDeliveredAt(root, '../jc'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
