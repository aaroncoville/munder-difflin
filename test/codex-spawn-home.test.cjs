'use strict';
/**
 * The Codex home a spawn finally runs in is the one checked and trusted.
 *
 * A resume can point CODEX_HOME at the home of the agent that owns the session,
 * after provisioning chose and checked the agent's own. Runs the real resume and
 * Codex launch blocks from spawnAgentCore (which cannot be imported on its own),
 * with findCodexHomeForSession and the computed homes real, and the CLI stubbed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');

const seat = loadTs('src/main/codexSeatHome.ts');
const { providerPreset } = loadTs('src/shared/agentProvider.ts');
const SID = '01a1d072-5747-7e83-a08f-03389a2cac3f';

function liveBlocks() {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const fn = (name) => ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  const ifWith = (cond) => {
    let found;
    const visit = (node) => {
      if (found) return;
      if (ts.isIfStatement(node) && node.expression.getText(ast) === cond) found = node;
      else ts.forEachChild(node, visit);
    };
    visit(fn('spawnAgentCore'));
    assert.ok(found, `spawnAgentCore has if (${cond})`);
    return found.getText(ast);
  };
  const finder = fn('findCodexHomeForSession');
  const recorded = fn('recordedSessionFor');
  assert.ok(finder && recorded, 'findCodexHomeForSession and recordedSessionFor');
  return ts.transpileModule(
    `${finder.getText(ast)}\n${recorded.getText(ast)}\n(async function run(opts, provider) {
      const claudeProvider = false; let resumeNotFound = false; let didResume = false; let codexResumedSession;
      ${ifWith('opts.hive && !claudeProvider')}
      ${ifWith('opts.requireResume === true && !didResume')}
      ${ifWith("provider === 'codex' && opts.hive?.id")}
      return { started: true, resumed: didResume, codexResumedSession, resumeNotFound };
    })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
}

function setup(t) {
  const base = codexTestBase(t, 'mdsp-');
  jailHome(t, base);
  const root = path.join(base, 'hive');
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  // Every agent the app provisioned has its folder under <hive>/agents, which the session finder walks.
  const homeOf = (id) => { fs.mkdirSync(path.join(root, 'agents', id), { recursive: true }); return seat.codexSeatHome(path.join(root, 'agents', id), id); };
  const calls = [];
  const rows = [];
  let trust = { ok: true, why: '' };
  const lastSession = {};
  const context = {
    console: { error() {}, warn() {}, log() {} }, Buffer, process,
    ...require('node:path'), ...require('node:fs'),
    ...seat,
    providerPreset, recordedSessionFor: () => undefined,
    resolveCliCommand: (c) => c,
    codexThreads: { resumesOnSpawn: () => true },
    hive: {
      root: () => root,
      lastSession: (id) => lastSession[id],
      appendLog: (row) => rows.push(row),
      prepareResumedCodexHome: (agentId, c, home) => calls.push(['prepare', agentId, home]),
      codexConfigWritten: () => ({ hooks: null, ownerToml: '' }),
    },
    memory: { env: () => ({}) },
    seedCodexHookTrust: async (ctx, _ms, why) => { calls.push(['trust', ctx.home]); if (!trust.ok) why(trust.why); return trust.ok; },
    enableCodexRemoteForSpawn: async (o) => { calls.push(['remote', o.env.CODEX_HOME]); return false; },
    refuseSpawn: async (ptyId, agentId, provider, refusal) => ({ ok: false, error: refusal.message, refusal }),
  };
  const run = vm.runInNewContext(liveBlocks(), context);
  const spawn = (id, env, extra = {}) => run({ id: `pty-${id}`, cwd, command: 'codex', args: ['-a', 'never', '-s', 'workspace-write', 'prompt'], env, hive: { id, name: id }, ...extra }, 'codex');
  return { base, root, cwd, homeOf, calls, rows, spawn, lastSession, trustFails: (why) => { trust = { ok: false, why }; } };
}

/** An agent home that owns session SID: its rollout and the state index naming it. */
function owning(f, id) {
  const home = f.homeOf(id);
  fs.mkdirSync(path.join(home, 'sessions', '2026', '11', '12'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', '2026', '11', '12', `rollout-2026-11-12T00-00-00-${SID}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(home, 'state_5.sqlite'), `xx${SID}xx`);
  return home;
}

test('a resume runs in the home that owns the session, and that final home is the one prepared and trusted', async (t) => {
  const f = setup(t);
  const owner = owning(f, 'owner');
  const mine = f.homeOf('resumer');
  fs.mkdirSync(mine, { recursive: true });
  const out = await f.spawn('resumer', { CODEX_HOME: mine }, { resumeSessionId: SID, args: ['prompt'] });
  assert.equal(out.started, true, out.error);
  assert.equal(out.codexResumedSession, SID);
  assert.deepEqual(f.calls, [['prepare', 'resumer', owner], ['trust', owner], ['remote', owner]]);
});

test('a final home outside the folder of computed homes, or not a real folder, refuses before trust', async (t) => {
  const f = setup(t);
  const elsewhere = path.join(f.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const linked = f.homeOf('linked');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(elsewhere, linked);
  for (const home of [elsewhere, linked]) {
    const out = await f.spawn('x', { CODEX_HOME: home });
    assert.equal(out.ok, false, home);
    assert.ok(out.error.includes(home), out.error);
  }
  assert.deepEqual(f.calls, [], 'nothing was trusted or started');
});

test('a Codex hive spawn with no CODEX_HOME refuses, saying so', async (t) => {
  const f = setup(t);
  const out = await f.spawn('nohome', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /CODEX_HOME/);
  assert.deepEqual(f.calls, []);
});

test('the trust step is timed: logged when it passes, in the reason when it refuses', async (t) => {
  const f = setup(t);
  const home = f.homeOf('timed');
  fs.mkdirSync(home, { recursive: true });
  assert.equal((await f.spawn('timed', { CODEX_HOME: home })).started, true);
  const row = f.rows.find((r) => r.kind === 'codex-hook-trust');
  assert.ok(row && row.agentId === 'timed' && row.ok === true && Number.isInteger(row.ms) && row.ms >= 0, JSON.stringify(f.rows));
  f.trustFails('a hook the app did not write is listed');
  const out = await f.spawn('timed', { CODEX_HOME: home });
  assert.equal(out.ok, false);
  assert.match(out.error, /a hook the app did not write is listed.*\d+ ms/);
});

// The app's real callers, each with the options it sends (renderer: CommandCenterPanel, useHive, useRestoreTeam, AddAgentModal).
for (const [caller, extra] of [
  ['Restart & Continue', { resume: true, requireResume: true }],
  ['auto-revive after sleep', { resume: true }],
  ['restore on app restart', { resume: true }],
]) {
  test(`${caller}: a Codex agent finds its own session in its computed home`, async (t) => {
    const f = setup(t);
    const own = owning(f, 'w1');
    f.lastSession.w1 = SID;
    const out = await f.spawn('w1', { CODEX_HOME: own }, { ...extra, args: ['prompt'] });
    assert.equal(out.started, true, out.error);
    assert.equal(out.resumed, true);
    assert.equal(out.codexResumedSession, undefined, 'resumed in place');
    assert.deepEqual(f.calls, [['trust', own], ['remote', own]]);
  });
}

test('Restart & Continue: a session recorded in another agent\'s home is resumed there', async (t) => {
  const f = setup(t);
  const owner = owning(f, 'w1');
  const mine = f.homeOf('w2');
  fs.mkdirSync(mine, { recursive: true });
  f.lastSession.w2 = SID;
  const out = await f.spawn('w2', { CODEX_HOME: mine }, { resume: true, requireResume: true, args: ['prompt'] });
  assert.equal(out.resumed, true, out.error);
  assert.deepEqual(f.calls, [['prepare', 'w2', owner], ['trust', owner], ['remote', owner]]);
});

test('Add Agent with an explicit session id: a new agent resumes it from the agent that owns it', async (t) => {
  const f = setup(t);
  const owner = owning(f, 'w1');
  const mine = f.homeOf('fresh');
  fs.mkdirSync(mine, { recursive: true });
  const out = await f.spawn('fresh', { CODEX_HOME: mine }, { resumeSessionId: SID, args: ['prompt'] });
  assert.equal(out.resumed, true);
  assert.equal(out.resumeNotFound, false, 'not reported as started fresh');
  assert.deepEqual(f.calls, [['prepare', 'fresh', owner], ['trust', owner], ['remote', owner]]);
});

test('Restart & Continue with no session anywhere is refused, not started fresh', async (t) => {
  const f = setup(t);
  const mine = f.homeOf('lost');
  fs.mkdirSync(mine, { recursive: true });
  f.lastSession.lost = SID;
  const out = await f.spawn('lost', { CODEX_HOME: mine }, { resume: true, requireResume: true, args: ['prompt'] });
  assert.equal(out.ok, false);
  assert.match(out.error, /could not be resumed/);
  assert.deepEqual(f.calls, []);
});

test('a spawn records itself (owner map, spawn record, Codex home, thread, wake state) only after every refusal point and a started terminal', () => {
  const sa = require('./source-assert.cjs');
  const src = sa.activeSource('src/main/index.ts');
  const core = src.slice(src.indexOf('async function spawnAgentCore('));
  const at = (needle) => { const i = core.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const record = at('ptyToAgent.set(opts.id, opts.hive.id);');
  for (const refusal of ['seedCodexHookTrust(', 'hive.confirmSpawn(opts.id', 'assertComputedCodexHome(home)']) {
    assert.ok(record > at(refusal), `bookkeeping comes after ${refusal}`);
  }
  assert.ok(record > at('const res = ptyManager.spawn(opts, owner);'), 'and only once the terminal has started');
});
