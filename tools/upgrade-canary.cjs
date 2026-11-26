#!/usr/bin/env node
'use strict';

/**
 * Upgrade canary for the provider CLIs seats run.
 *
 * Seats rely on behaviour the CLIs own: Claude's PreToolUse hooks gating a call (and blocking it when the hook
 * itself cannot run, with "onFailure": "block"), Claude's Bash sandbox, and Codex's workspace-write sandbox, in
 * the parent thread and in child threads it spawns. Each has changed between minor versions, so a pinned CLI should
 * move only after this passes on the new version. It runs on demand and costs a few small model turns.
 *
 *   node tools/upgrade-canary.cjs --claude-version 2.1.332 --codex-version 0.172.0 --codex-model gpt-5.6-sol
 *
 * Every probe prints one JSON line: ok true (pass), false (the CLI failed open or is wrong), or null
 * (inconclusive: the control did not run, so the probe proves nothing). The exit code is 0 only when every
 * probe passed.
 *
 * The work folder must not be under a temp directory: both sandboxes let any command write to /tmp and $TMPDIR,
 * so a write probe there could not fail.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROBES = [
  'claude.version', 'claude.auth', 'claude.spawn', 'claude.hook-gate', 'claude.hook-onfailure-block', 'claude.sandbox-write',
  'codex.version', 'codex.auth', 'codex.spawn', 'codex.sandbox-write', 'codex.child-thread-roots'
];

const OK_WORD = 'canary-ok';
const reply = `Reply with exactly: ${OK_WORD}`;
const runTouches = (paths) =>
  `Use the shell to run each of these commands once, separately, and report each exit code. ` +
  `Do not retry a command that fails and do not ask for approval: ${paths.map((p) => `touch ${p}`).join(' ; ')}`;

function defaultRun(file, args, opts) {
  return spawnSync(file, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024, ...opts });
}

function parseVersion(cli, out) {
  const re = cli === 'claude' ? /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/m : /^codex-cli\s+(\d+\.\d+\.\d+)\s*$/m;
  return re.exec(out ?? '')?.[1] ?? null;
}

function isUnderTemp(dir) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const d = path.resolve(dir);
  const temps = [os.tmpdir(), process.env.TMPDIR, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .filter(Boolean).map((t) => real(t));
  let probe = d;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const full = path.join(real(probe), path.relative(probe, d));
  return temps.some((t) => full === t || full.startsWith(t + path.sep) || d === t || d.startsWith(t + path.sep));
}

function runCanary(o) {
  const run = o.run ?? defaultRun;
  if (!o.work) throw new Error('a work folder is required');
  if (isUnderTemp(o.work)) throw new Error(`the work folder ${o.work} is under a temp directory, where both sandboxes allow writes`);
  fs.mkdirSync(o.work, { recursive: true });
  const wanted = o.only ? PROBES.filter((p) => o.only.includes(p)) : PROBES;
  const results = [];
  let n = 0;
  /** A fresh cwd, an allowed root and a forbidden root for one probe. */
  const dirs = (name) => {
    const root = path.join(o.work, `${String(++n).padStart(2, '0')}-${name}`);
    const d = { cwd: path.join(root, 'cwd'), allowed: path.join(root, 'allowed'), forbidden: path.join(root, 'forbidden') };
    for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
    return d;
  };
  const exists = (p) => fs.existsSync(p);
  const out = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;

  const claudeP = (cwd, prompt, settings, tools) => {
    const args = ['-p', '--model', o.claudeModel, '--output-format', 'text', '--no-session-persistence', '--setting-sources', 'local',
      '--strict-mcp-config', '--max-budget-usd', String(o.maxBudgetUsd ?? 0.25), '--tools', tools];
    if (settings) {
      const file = path.join(cwd, '..', 'settings.json');
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
      args.push('--settings', file, '--permission-mode', 'bypassPermissions');
    }
    // --tools takes any number of values, so without the separator it would swallow the prompt.
    args.push('--', prompt);
    return run(o.claude, args, { cwd });
  };
  const codexExec = (cwd, prompt, roots, extra = []) => {
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-m', o.codexModel, '-s', 'workspace-write', '-C', cwd];
    if (roots) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
    args.push(...extra, prompt);
    return run(o.codex, args, { cwd });
  };
  /** A Bash call under a PreToolUse hook: blocked (true), let through (false). Needs a control that wrote. */
  const hookBlocks = (name, hook) => {
    const d = dirs(name);
    const target = path.join(d.cwd, 'written');
    claudeP(d.cwd, runTouches([target]), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] } }, 'Bash');
    return !exists(target);
  };

  const probe = {
    'claude.version': () => version('claude', o.claude, o.claudeVersion),
    'codex.version': () => version('codex', o.codex, o.codexVersion),
    'claude.auth': () => exitZero(run(o.claude, ['auth', 'status'], {}), 'claude auth status'),
    'codex.auth': () => exitZero(run(o.codex, ['login', 'status'], {}), 'codex login status'),
    'claude.spawn': () => saidOk(claudeP(dirs('claude-spawn').cwd, reply, null, '')),
    'codex.spawn': () => { const d = dirs('codex-spawn'); return saidOk(codexExec(d.cwd, reply, null)); },
    'claude.hook-gate': () => {
      if (!control()) return inconclusive();
      return hookBlocks('hook-deny', { type: 'command', command: 'echo "denied by canary" >&2; exit 2' })
        ? { ok: true, detail: 'a hook that exits 2 blocked the call' }
        : { ok: false, detail: 'a hook that exits 2 did not block the call' };
    },
    'claude.hook-onfailure-block': () => {
      if (!control()) return inconclusive();
      const kinds = {
        missing: { type: 'command', command: path.join(o.work, 'no-such-hook-shim'), onFailure: 'block' },
        crash: { type: 'command', command: 'kill -SEGV $$', onFailure: 'block' },
        timeout: { type: 'command', command: 'sleep 30', timeout: 2, onFailure: 'block' }
      };
      const open = Object.entries(kinds).filter(([k, h]) => !hookBlocks(`hook-${k}`, h)).map(([k]) => k);
      return open.length
        ? { ok: false, detail: `a hook with onFailure "block" let the call through when it: ${open.join(', ')}` }
        : { ok: true, detail: 'missing, crashing and timed-out hooks with onFailure "block" each blocked the call' };
    },
    'claude.sandbox-write': () => {
      const d = dirs('claude-sandbox');
      const inside = path.join(d.allowed, 'x');
      const outside = path.join(d.forbidden, 'x');
      claudeP(d.cwd, runTouches([inside, outside]), {
        sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [d.allowed] } },
        permissions: { additionalDirectories: [d.allowed] }
      }, 'Bash');
      return writeVerdict(inside, outside);
    },
    'codex.sandbox-write': () => {
      const d = dirs('codex-sandbox');
      const inside = path.join(d.allowed, 'x');
      const outside = path.join(d.forbidden, 'x');
      codexExec(d.cwd, runTouches([inside, outside]), [d.allowed]);
      return writeVerdict(inside, outside);
    },
    'codex.child-thread-roots': () => {
      const d = dirs('codex-child');
      const inside = path.join(d.allowed, 'child');
      const outside = path.join(d.forbidden, 'child');
      const r = codexExec(d.cwd,
        'Spawn exactly one sub-agent, wait for it, and report what it said. You must not run the commands yourself; ' +
        `the sub-agent must do this: ${runTouches([inside, outside])}`, [d.allowed], ['--json']);
      const spawned = /spawn_agent|collab_tool_call|collab_agent_spawn/.test(r.stdout ?? '');
      if (!spawned) return { ok: null, detail: 'no child thread was seen in the event stream, so the probe proves nothing' };
      return writeVerdict(inside, outside, 'a child thread');
    }
  };

  let controlResult;
  function control() {
    if (controlResult === undefined) {
      const d = dirs('hook-control');
      const target = path.join(d.cwd, 'written');
      claudeP(d.cwd, runTouches([target]), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] } }, 'Bash');
      controlResult = exists(target);
    }
    return controlResult;
  }
  function inconclusive() { return { ok: null, detail: 'the control (a hook that allows) did not write, so a block proves nothing' }; }
  function version(cli, exe, expected) {
    const got = parseVersion(cli, out(run(exe, ['--version'], {})));
    if (!got) return { ok: false, detail: `${cli} --version printed no version` };
    if (expected && got !== expected) return { ok: false, detail: `${cli} is ${got}, expected ${expected}` };
    return { ok: true, detail: `${cli} ${got}` };
  }
  function exitZero(r, what) { return r.status === 0 ? { ok: true, detail: `${what} exited 0` } : { ok: false, detail: `${what} exited ${r.status}` }; }
  function saidOk(r) {
    return r.status === 0 && (r.stdout ?? '').includes(OK_WORD)
      ? { ok: true, detail: 'a headless turn answered' }
      : { ok: false, detail: `a headless turn did not answer (exit ${r.status})` };
  }
  function writeVerdict(inside, outside, who = 'the shell') {
    const wroteIn = exists(inside);
    const wroteOut = exists(outside);
    if (wroteOut) return { ok: false, detail: `${who} wrote outside its roots` };
    if (!wroteIn) return { ok: null, detail: `${who} did not write inside its roots either, so the refusal proves nothing` };
    return { ok: true, detail: `${who} wrote inside its roots and was refused outside them` };
  }

  for (const name of wanted) {
    const started = Date.now();
    let r;
    try { r = probe[name](); } catch (e) { r = { ok: false, detail: `probe threw: ${e?.message ?? e}` }; }
    results.push({ probe: name, ok: r.ok, ms: Date.now() - started, detail: r.detail });
  }
  return results;
}

function parseArgs(argv) {
  const o = { claude: 'claude', codex: 'codex', claudeModel: 'claude-haiku-5-5', codexModel: null };
  const map = { '--claude': 'claude', '--codex': 'codex', '--claude-version': 'claudeVersion', '--codex-version': 'codexVersion',
    '--claude-model': 'claudeModel', '--codex-model': 'codexModel', '--work': 'work', '--max-budget-usd': 'maxBudgetUsd' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--keep') o.keep = true;
    else if (map[a]) o[map[a]] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.codexModel) throw new Error('--codex-model is required: probe the model seats are pinned to');
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const made = !o.work;
  o.work = o.work ?? fs.mkdtempSync(path.join(os.homedir(), '.upgrade-canary-'));
  let results;
  try { results = runCanary(o); } finally { if (made && !o.keep) fs.rmSync(o.work, { recursive: true, force: true }); }
  for (const r of results) console.log(JSON.stringify(r));
  const failed = results.filter((r) => r.ok !== true);
  console.log(failed.length ? `canary: ${failed.length} of ${results.length} probes did not pass` : `canary: all ${results.length} probes passed`);
  process.exit(failed.length ? 1 : 0);
}

module.exports = { PROBES, runCanary, parseArgs, isUnderTemp };
if (require.main === module) main();
