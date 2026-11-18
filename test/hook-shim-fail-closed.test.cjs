'use strict';
/**
 * Under scoped roots, the hook shim refuses a protected file write it cannot get checked.
 *
 * The shim pipes each hook to the app's socket and relays the answer. When it cannot (no socket, a connect error, no
 * answer in time, an answer that is not a JSON object) it exits 0 with nothing on stdout, which the CLI reads as
 * "allow": with the app's PreToolUse check out of reach, a seat's file writes would go through unchecked. With scoped
 * roots on for the seat (an environment value the app sets per spawn), a PreToolUse for one of the protected tools
 * (Claude's Edit, Write, MultiEdit, NotebookEdit; Codex's apply_patch) is denied instead, in the reply shape both CLIs
 * read. Every other event and tool keeps the exit 0. Each refusal is counted in the app's private hook runtime folder,
 * which the app turns into a count-only usage row and resets, so a dead socket shows up as a number. Off (the
 * default), the shim behaves as before.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome, removeDir } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { sanitize } = loadTs('src/main/usageLog.ts');

const PROSE = 'the quick brown fox jumps over a lazy dog near the riverbank at dusk';

function floor(t) {
  const base = codexTestBase(t, 'mdfc-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const rows = [];
  hive.setUsageSink((row) => rows.push(row));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdfc-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  // Sockets need a short path.
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  t.after(async () => removeDir(short));
  return { base, work, hive, rows, runtime, short, shim: path.join(runtime, 'cth-hook.cjs'), counts: path.join(runtime, 'fail-closed') };
}

/** A socket that answers every frame with `reply` (null: accepts and never answers). */
async function server(t, f, name, reply) {
  const sock = path.join(f.short, name);
  const conns = [];
  const srv = net.createServer((c) => {
    conns.push(c);
    c.on('error', () => {});
    c.on('data', () => { if (reply !== null) c.end(reply); });
  });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => { for (const c of conns) c.destroy(); srv.close(); });
  return sock;
}

/** Run the staged shim as a CLI runs it: payload on stdin, the app's per-spawn environment. */
function run(f, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [f.shim], {
      env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const pre = (tool_name, tool_input = { file_path: '/x' }) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's' });
const isDeny = (r) => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; } };
const counted = (f) => (fs.existsSync(f.counts) ? Object.fromEntries(fs.readdirSync(f.counts).map((n) => [n, fs.statSync(path.join(f.counts, n)).size])) : {});

test('flag off: the shim allows on a dead socket, a missing socket, a bad reply and no reply, as before', async (t) => {
  const f = floor(t);
  const dead = path.join(f.short, 'nobody');
  const garbage = await server(t, f, 'g', 'not json');
  const empty = await server(t, f, 'e', '');
  const silent = await server(t, f, 's', null);
  const env = { AGENT_ID: 'a1' };
  const [a, b, c, d, e] = await Promise.all([
    run(f, pre('Edit'), { ...env, HIVE_SOCK: dead }),
    run(f, pre('Write'), env),
    run(f, pre('Edit'), { ...env, HIVE_SOCK: garbage }),
    run(f, pre('apply_patch', { input: '*** Add File: x' }), { ...env, HIVE_SOCK: empty }),
    run(f, pre('Write'), { ...env, HIVE_SOCK: silent }),
  ]);
  assert.deepEqual(a, { code: 0, out: '' }, 'dead socket');
  assert.deepEqual(b, { code: 0, out: '' }, 'no socket set');
  assert.deepEqual(c, { code: 0, out: 'not json' }, 'a bad reply is relayed as it came');
  assert.deepEqual(d, { code: 0, out: '' }, 'an empty reply');
  assert.deepEqual(e, { code: 0, out: '' }, 'no reply in time');
  assert.deepEqual(counted(f), {}, 'nothing counted');
});

test('the app sets the shim\'s flag for Claude and Codex seats only when scoped roots are on', async (t) => {
  const f = floor(t);
  for (const provider of ['claude', 'codex']) {
    const off = await f.hive.ensureAgent({ id: `${provider}-off`, name: 'x', provider, cwd: f.work }, { spawnId: `pty-${provider}-off`, scopedRoots: false });
    assert.equal(Object.hasOwn(off.env, 'HIVE_SCOPED_ROOTS'), false, `${provider} off`);
    const on = await f.hive.ensureAgent({ id: `${provider}-on`, name: 'x', provider, cwd: f.work }, { spawnId: `pty-${provider}-on`, scopedRoots: true });
    assert.equal(on.env.HIVE_SCOPED_ROOTS, '1', `${provider} on`);
  }
});

test('flag on: a protected write the shim cannot get checked is denied and counted; anything else is allowed as before', async (t) => {
  const f = floor(t);
  const dead = path.join(f.short, 'nobody');
  const garbage = await server(t, f, 'g', 'not json');
  const empty = await server(t, f, 'e', '');
  const silent = await server(t, f, 's', null);
  const allow = await server(t, f, 'ok', '{}');
  const env = { AGENT_ID: 'a1', HIVE_SCOPED_ROOTS: '1' };
  const [noSock, unset, read, bash, stop, bad, none, slow, patch, fine] = await Promise.all([
    run(f, pre('Edit'), { ...env, HIVE_SOCK: dead }),
    run(f, pre('Write'), env),
    run(f, pre('Read'), { ...env, HIVE_SOCK: dead }),
    run(f, pre('Bash', { command: 'ls' }), { ...env, HIVE_SOCK: dead }),
    run(f, { hook_event_name: 'Stop' }, { ...env, HIVE_SOCK: dead }),
    run(f, pre('MultiEdit'), { ...env, HIVE_SOCK: garbage }),
    run(f, pre('NotebookEdit', { notebook_path: '/n' }), { ...env, HIVE_SOCK: empty }),
    run(f, pre('Write'), { ...env, HIVE_SOCK: silent }),
    run(f, pre('apply_patch', { input: '*** Add File: x' }), { ...env, AGENT_ID: 'c1', HIVE_SOCK: dead }),
    run(f, pre('Edit'), { ...env, HIVE_SOCK: allow }),
  ]);
  for (const [what, r] of Object.entries({ noSock, unset, bad, none, slow, patch })) {
    assert.equal(r.code, 0, what);
    assert.ok(isDeny(r), `${what} is denied: ${r.out}`);
    const o = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(o.hookEventName, 'PreToolUse', what);
    assert.equal(r.out.includes(f.short), false, `${what}: no path in the reason`);
  }
  assert.deepEqual(read, { code: 0, out: '' }, 'an unprotected tool still exits 0');
  assert.deepEqual(bash, { code: 0, out: '' }, 'a shell command is left to the sandbox');
  assert.deepEqual(stop, { code: 0, out: '' }, 'another event still exits 0');
  assert.deepEqual(fine, { code: 0, out: '{}' }, 'a reply from the app is relayed as before');
  assert.deepEqual(counted(f), { 'a1.no-socket': 2, 'a1.malformed': 2, 'a1.timeout': 1, 'c1.no-socket': 1 });

  // The app turns the counts into rows and resets them.
  f.hive.drainFailClosedCounts();
  const rows = f.rows.filter((r) => r.kind === 'write-fail-closed').sort((x, y) => `${x.agentId}${x.reason}`.localeCompare(`${y.agentId}${y.reason}`));
  assert.deepEqual(rows, [
    { kind: 'write-fail-closed', agentId: 'a1', reason: 'malformed', count: 2 },
    { kind: 'write-fail-closed', agentId: 'a1', reason: 'no-socket', count: 2 },
    { kind: 'write-fail-closed', agentId: 'a1', reason: 'timeout', count: 1 },
    { kind: 'write-fail-closed', agentId: 'c1', reason: 'no-socket', count: 1 },
  ]);
  assert.deepEqual(counted(f), {}, 'reset once read');
  f.hive.drainFailClosedCounts();
  assert.equal(f.rows.filter((r) => r.kind === 'write-fail-closed').length, 4, 'a second read adds nothing');
});

test('the count rows pass the usage log allowlist, carry no path, and a planted name or prose decides nothing', async (t) => {
  const f = floor(t);
  const dead = path.join(f.short, 'nobody');
  // An id that is not a plain name is never used as a file name.
  await run(f, pre('Write'), { AGENT_ID: '../../x', HIVE_SCOPED_ROOTS: '1', HIVE_SOCK: dead });
  await run(f, pre('Write'), { AGENT_ID: 'a1', HIVE_SCOPED_ROOTS: '1', HIVE_SOCK: dead });
  assert.deepEqual(counted(f), { '_unknown.no-socket': 1, 'a1.no-socket': 1 });
  // Files nothing but the app should write there: prose in a name, a reason off the list, a link, a folder.
  fs.writeFileSync(path.join(f.counts, `${PROSE}.no-socket`), PROSE);
  fs.writeFileSync(path.join(f.counts, `a1.${PROSE}`), 'xx');
  fs.symlinkSync(path.join(f.counts, 'a1.no-socket'), path.join(f.counts, 'b1.timeout'));
  fs.mkdirSync(path.join(f.counts, 'c1.malformed'));
  f.hive.drainFailClosedCounts();
  const rows = f.rows.filter((r) => r.kind === 'write-fail-closed');
  assert.deepEqual(rows.map((r) => `${r.agentId ?? '-'}:${r.reason}:${r.count}`).sort(), ['-:no-socket:1', 'a1:no-socket:1'], 'counted, the unnamed one with no agent');
  for (const row of rows) {
    const clean = sanitize(row, { isAgent: (id) => id === 'a1', isCard: () => false });
    assert.ok(clean, 'passes the allowlist');
    assert.deepEqual(clean, row, 'written as it is');
  }
  const text = JSON.stringify(f.rows);
  for (const s of [PROSE, 'quick brown', f.short, f.runtime, f.base]) assert.equal(text.includes(s), false, s);
});
