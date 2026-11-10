'use strict';
// The heartbeat digest names the agents whose inbox still holds mail. A message
// stays in the inbox until the agent has handled it and filed it, so an agent
// that is busy working a message is listed as well as one that never looked.
// The digest tells the two apart: mail is claimed while the agent has a turn
// open that showed a hook after the mail was delivered, and unclaimed otherwise,
// including once that turn has ended.
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
const { WorkerWakeWatchdog, WORKER_WAKE_TURN_CEILING_MS } = loadTs('src/main/workerWake.ts');
const REPO = path.resolve(__dirname, '..');
// Whole seconds, so a file's mtime lands exactly on the time it was given.
const T0 = Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000;

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
 * the given inboxes. `hooks` maps id → [event, at, message?] fed to a real
 * watchdog in order; `usage`/`spans` map id → what telemetry would report.
 */
function digestOn(inboxes, { hooks = {}, usage = {}, spans = {} } = {}) {
  const root = hiveOn(inboxes);
  const ids = Object.keys({ ...inboxes, ...hooks });
  const agents = Object.fromEntries(ids.map((id) => [id, { name: id[0].toUpperCase() + id.slice(1) }]));
  const workerWake = new WorkerWakeWatchdog();
  for (const [id, events] of Object.entries(hooks)) {
    for (const [event, at, message] of events) workerWake.noteHook(id, event, message, at);
  }
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
    workerWake,
    telemetry: {
      getAgentUsage: (id) => usage[id] ?? null,
      getSpans: (id) => spans[id] ?? []
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
const UNCLAIMED = (who) => new RegExp(`unclaimed \\(no turn open since delivery\\): ${who};`);
const CLAIMED = (who) => new RegExp(`; claimed \\(a turn open since delivery, not yet filed\\): ${who}\\.$`);

test('an agent in a turn that showed a hook after its mail arrived is listed as claimed', () => {
  const line = inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: [['UserPromptSubmit', T0 + 30_000], ['PreToolUse', T0 + 60_000]] } }));
  assert.match(line, UNCLAIMED('none'));
  assert.match(line, CLAIMED('Jc ×1'));
});

test('a turn that has ended leaves its unfiled mail unclaimed', () => {
  const ended = [['UserPromptSubmit', T0 + 30_000], ['PreToolUse', T0 + 40_000], ['Stop', T0 + 60_000]];
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: ended } })), UNCLAIMED('Jc ×1'));
  const failed = [['UserPromptSubmit', T0 + 30_000], ['StopFailure', T0 + 60_000]];
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: failed } })), UNCLAIMED('Jc ×1'));
  const waiting = [['PreToolUse', T0 + 30_000], ['Notification', T0 + 60_000, 'Claude is waiting for your input']];
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: waiting } })), UNCLAIMED('Jc ×1'));
});

test('a subagent ending after delivery, with no turn open, does not claim the mail', () => {
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: [['SubagentStop', T0 + 60_000]] } })), UNCLAIMED('Jc ×1'));
});

test('a turn whose last hook came before delivery has not claimed the mail, until it shows another', () => {
  const before = [['PreToolUse', T0 - 60_000]];
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: before } })), UNCLAIMED('Jc ×1'));
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: [...before, ['PostToolUse', T0 + 1_000]] } })), CLAIMED('Jc ×1'));
});

test('a hook at the very millisecond of delivery does not claim it', () => {
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: [['PreToolUse', T0]] } })), UNCLAIMED('Jc ×1'));
});

test('a turn silent for longer than the watchdog ceiling no longer claims mail', () => {
  const now = Date.now();
  const delivered = Math.floor((now - WORKER_WAKE_TURN_CEILING_MS - 120_000) / 1000) * 1000;
  const hooks = { jc: [['PreToolUse', delivered + 60_000]] };
  assert.match(inboxLineOf(digestOn({ jc: [delivered] }, { hooks })), UNCLAIMED('Jc ×1'));
});

test('an agent that has never taken a turn is listed as unclaimed', () => {
  assert.match(inboxLineOf(digestOn({ jc: [T0] })), UNCLAIMED('Jc ×1'));
});

test('telemetry claims nothing: not the transcript fallback stamped at read time, nor a span after delivery', () => {
  const yearAgo = Math.floor((Date.now() - 365 * 864e5) / 1000) * 1000;
  // The shape the Claude transcript fallback returns: no session id, ts = the read.
  const fallback = { agentId: 'jc', sessionId: '', ts: Date.now(), input: 10, output: 5, cacheRead: 0, cacheCreation: 0, model: '', usd: 0 };
  assert.match(inboxLineOf(digestOn({ jc: [yearAgo] }, { usage: { jc: fallback } })), UNCLAIMED('Jc ×1'));
  const ended = [['PreToolUse', T0 + 30_000], ['Stop', T0 + 60_000]];
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: ended }, spans: { jc: [{ ts: T0 + 50_000 }] } })), UNCLAIMED('Jc ×1'));
});

test('mail delivered after the turn last showed a hook is unclaimed even when older mail was claimed', () => {
  const line = inboxLineOf(digestOn({ jc: [T0, T0 + 120_000] }, { hooks: { jc: [['PreToolUse', T0 + 60_000]] } }));
  assert.match(line, UNCLAIMED('Jc ×1'));
  assert.match(line, CLAIMED('Jc ×1'));
});

test('two agents: each list names its own agents, with counts', () => {
  const line = inboxLineOf(digestOn(
    { jc: [T0, T0 + 1_000], ann: [T0] },
    { hooks: { jc: [['PreToolUse', T0 + 60_000]], ann: [['PreToolUse', T0 + 60_000], ['Stop', T0 + 70_000]] } }
  ));
  assert.equal(line, 'Undrained inbox: unclaimed (no turn open since delivery): Ann ×1; claimed (a turn open since delivery, not yet filed): Jc ×2.');
});

test('the delivery time is the file mtime, not the created_at the sender wrote', () => {
  // created_at reads an hour after the hook; the file was delivered before it.
  assert.match(inboxLineOf(digestOn({ jc: [T0] }, { hooks: { jc: [['PreToolUse', T0 + 60_000]] } })), CLAIMED('Jc ×1'));
});

test('a floor with no mail waiting still says so', () => {
  assert.equal(inboxLineOf(digestOn({ jc: [] })), 'No undrained inboxes.');
});

test('the messages counted are the ones the hive reads as mail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-claims-'));
  try {
    const dir = path.join(root, 'agents', 'worker-a.1', 'inbox');
    fs.mkdirSync(path.join(dir, '.done'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.done', 'old.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    fs.writeFileSync(path.join(dir, 'new.json.tmp'), '{}');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'new.json'), '{}');
    fs.writeFileSync(path.join(root, 'elsewhere.json'), '{}');
    fs.symlinkSync(path.join(root, 'elsewhere.json'), path.join(dir, 'linked.json'));
    // An id with a dot is a valid roster id; new.json and the linked message count.
    assert.equal(claims.inboxDeliveredAt(root, 'worker-a.1').length, 2);
    assert.deepEqual(claims.inboxDeliveredAt(root, 'nobody'), []);
    assert.deepEqual(claims.inboxDeliveredAt(null, 'worker-a.1'), []);
    assert.deepEqual(claims.inboxDeliveredAt(root, '../agents/worker-a.1'), []);
    assert.deepEqual(claims.inboxDeliveredAt(root, '..'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
