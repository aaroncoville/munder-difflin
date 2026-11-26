#!/usr/bin/env node
'use strict';

/**
 * Upgrade canary for the provider CLIs seats run.
 *
 * Seats rely on behaviour the CLIs own: Claude's PreToolUse hooks gating a call (and blocking it when the hook
 * itself cannot run, with "onFailure": "block"), Claude's Bash sandbox, and Codex's workspace-write sandbox, in
 * the parent thread and in child threads it spawns. Each has changed between minor versions, so a pinned CLI should
 * move only after this passes on the new version. It runs on demand and costs a few small, bounded model turns.
 *
 *   node tools/upgrade-canary.cjs --claude-version 2.1.332 --codex-version 0.172.0 --codex-model gpt-5.6-sol
 *
 * Every probe prints one JSON line: ok true (pass), false (the CLI failed open or is wrong), or null
 * (inconclusive). A pass needs positive evidence from the CLI's own event stream: the call was attempted AND it
 * was refused the expected way. A turn that failed, timed out, ran out of budget or never tried the call proves
 * nothing, so it is inconclusive, never a pass. The exit code is 0 only when every probe passed.
 *
 * The run is bounded: each Claude turn is capped in dollars and all of them together; Codex turns run at low
 * reasoning effort under a token budget; every turn has a deadline and the whole run a wall-clock limit. Once a
 * bound is hit the remaining model probes are inconclusive. The spend is printed at the end.
 *
 * The Codex budget is a reservation, not a cap inside a turn: the CLI has none. A turn starts only if a fixed
 * allowance per turn still fits, and a turn that reports no usage is charged that allowance. Codex reports only
 * the parent thread's usage, so the child-thread turn is also charged a fixed allowance for the child it spawns.
 * A single turn can still use more than its allowance; its deadline is what bounds it.
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

const LIMITS = {
  claudeTurnUsd: 0.10,
  claudeTotalUsd: 0.60,
  codexTotalTokens: 400_000,
  codexTurnReserveTokens: 120_000,
  codexChildAllowanceTokens: 100_000,
  turnTimeoutMs: 120_000,
  childTurnTimeoutMs: 180_000,
  wallClockMs: 15 * 60_000
};

const OK_WORD = 'canary-ok';
const reply = `Reply with exactly: ${OK_WORD}`;
const runCommands = (cmds) =>
  `Use the shell to run each of these commands once, separately, exactly as written with nothing added, and report each exit code. Run no other commands. ` +
  `Do not retry a command that fails and do not ask for approval:\n${cmds.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
const runTouches = (paths) => runCommands(paths.map((p) => `touch ${p}`));
/** A write outside the roots whose outcome the shell itself records inside them: touch's exit code in `rc` and its
 *  error text in `err`. The model's account of what happened is never the evidence. */
const recordedTouch = (outside, rc, err) => `sh -c 'touch ${outside} 2> ${err}; echo $? > ${rc}'`;
const REFUSED = /operation not permitted|permission denied|read-only file system/i;

function defaultRun(file, args, opts) {
  // stdin closed: codex exec otherwise waits for more input.
  return spawnSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function parseVersion(cli, out) {
  const re = cli === 'claude' ? /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/m : /^codex-cli\s+(\d+\.\d+\.\d+)\s*$/m;
  return re.exec(out ?? '')?.[1] ?? null;
}

function jsonLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* not an event */ }
  }
  return out;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n') : '');

/** Whether a shell command is the generated `touch <target>` (the target optionally quoted), so a command that
 *  touches something else, or only mentions the target, is not taken for the attempt. Asked for exit codes, a model
 *  may add `2>&1` and one trailing `echo` of `$?`; nothing else may follow, and the echo may not run anything. A line
 *  break starts another command, so a command holding one is never the touch. */
function isTouchOf(command, target) {
  if (/[\r\n]/.test(command.replace(/^\s+|\s+$/g, ''))) return false;
  const m = /^touch[ \t]+(?:'([^'\r\n]*)'|"([^"\r\n]*)"|([^\s;&|]+))([ \t]+2>&1)?(?:[ \t]*(?:;|&&)[ \t]*echo[ \t]+([^;&|`<>()\r\n]*))?$/.exec(command.trim());
  if (!m || (m[1] ?? m[2] ?? m[3]) !== target) return false;
  return m[5] === undefined || /\$\?/.test(m[5]);
}

/** Whether a command only reads the recorded results back: `cat` of the rc and/or err file, or `ls` (with flags) of
 *  the allowed folder. Models asked for exit codes do this; nothing with a redirect, a pipe, a substitution or any
 *  other operand counts. */
function isLookAt(command, f) {
  const c = command.trim();
  if (/[;&|`$<>()\\'"*?\r\n]/.test(c)) return false;
  const [verb, ...rest] = c.split(/[ \t]+/);
  const dir = path.dirname(f.rc);
  if (verb === 'cat') return rest.length > 0 && rest.every((a) => a === f.rc || a === f.err);
  if (verb === 'ls') return rest.every((a) => /^-[A-Za-z]+$/.test(a) || a === dir || a === `${dir}/`);
  return false;
}

/** Every Bash command a Claude stream-json turn ran. */
function bashCommands(stdout) {
  const out = [];
  for (const e of jsonLines(stdout)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) if (c?.type === 'tool_use' && c.name === 'Bash') out.push(String(c.input?.command ?? ''));
  }
  return out;
}

/** What a Claude stream-json turn shows about one Bash call: was a command naming `target` attempted, and what came
 *  back for it. Also the turn's reported cost. */
function claudeEvidence(stdout, target) {
  const events = jsonLines(stdout);
  const uses = new Map();
  let call = null;
  let result = null;
  let costUsd = null;
  for (const e of events) {
    if (e.type === 'result' && typeof e.total_cost_usd === 'number') costUsd = e.total_cost_usd;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (e.type === 'assistant' && c?.type === 'tool_use' && c.name === 'Bash') {
        uses.set(c.id, String(c.input?.command ?? ''));
        if (!call && isTouchOf(String(c.input?.command ?? ''), target)) call = c.id;
      }
      if (e.type === 'user' && c?.type === 'tool_result' && call && c.tool_use_id === call && !result) {
        result = { isError: c.is_error === true, text: textOf(c.content) };
      }
    }
  }
  return { attempted: !!call, result, costUsd };
}

/** Codex `exec --json` items: completed shell commands (with exit code and output), agent messages, and whether
 *  any sub-agent (collab) tool was used. Also the parent's token usage. */
function codexEvidence(stdout) {
  const commands = [];
  const messages = [];
  let collab = false;
  let tokens = 0;
  for (const e of jsonLines(stdout)) {
    if (e.type === 'turn.completed' && e.usage) tokens += (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0);
    const item = e.item;
    if (e.type !== 'item.completed' || !item) continue;
    if (item.type === 'command_execution') commands.push(item);
    else if (item.type === 'agent_message') messages.push(String(item.text ?? ''));
    else if (item.type === 'collab_tool_call') collab = true;
  }
  return { commands, messages, collab, tokens };
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

/** The absolute path a bare command name would run from on this PATH, for the report. */
function onPath(cmd, envPath = process.env.PATH ?? '') {
  if (cmd.includes('/')) return path.resolve(cmd);
  for (const dir of envPath.split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Runs the probes. `allowTempWork` exists for the unit tests only, whose stand-in CLIs have no sandbox; the command
 * line cannot set it.
 */
function runCanary(o) {
  const run = o.run ?? defaultRun;
  const now = o.now ?? Date.now;
  const limits = { ...LIMITS, ...(o.limits ?? {}) };
  if (!o.work) throw new Error('a work folder is required');
  if (!o.allowTempWork && isUnderTemp(o.work)) throw new Error(`the work folder ${o.work} is under a temp directory, where both sandboxes allow writes`);
  // Probe folders have fixed names, so files a previous run left behind could stand in for this run's evidence.
  let leftover = [];
  try { leftover = fs.readdirSync(o.work); } catch { /* missing: created below */ }
  if (leftover.length) throw new Error(`the work folder ${o.work} is not empty; use an empty or new folder so no earlier run's files are read as evidence`);
  fs.mkdirSync(o.work, { recursive: true });
  const started = now();
  const spend = { claudeUsd: 0, claudeTurns: 0, codexTokens: 0, codexTurns: 0 };
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
  const failed = (r) => `exit ${r.status ?? 'none'}${r.error ? `, ${r.error.code ?? r.error.message}` : ''}`;

  class OutOfBudget extends Error {}
  const timeLeft = () => limits.wallClockMs - (now() - started);
  const deadline = (perTurn) => {
    const left = timeLeft();
    if (left <= 0) throw new OutOfBudget('the run reached its wall-clock limit');
    return Math.min(perTurn, left);
  };

  const claudeP = (cwd, prompt, settings, tools) => {
    if (spend.claudeUsd + limits.claudeTurnUsd > limits.claudeTotalUsd + 1e-9) throw new OutOfBudget('the Claude spend limit for this run is used up');
    const args = ['-p', '--model', o.claudeModel, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--setting-sources', 'local', '--strict-mcp-config', '--max-budget-usd', String(limits.claudeTurnUsd), '--tools', tools];
    if (settings) {
      const file = path.join(cwd, '..', 'settings.json');
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
      args.push('--settings', file, '--permission-mode', 'bypassPermissions');
    }
    // --tools takes any number of values, so without the separator it would swallow the prompt.
    args.push('--', prompt);
    const r = run(o.claude, args, { cwd, timeout: deadline(limits.turnTimeoutMs) });
    const cost = claudeEvidence(r.stdout, '\0').costUsd;
    spend.claudeTurns++;
    spend.claudeUsd += typeof cost === 'number' ? cost : limits.claudeTurnUsd; // unreported = assume the cap was spent
    return r;
  };
  const codexExec = (cwd, prompt, roots, timeoutMs = limits.turnTimeoutMs, child = false) => {
    const reserve = limits.codexTurnReserveTokens + (child ? limits.codexChildAllowanceTokens : 0);
    if (spend.codexTokens + reserve > limits.codexTotalTokens) throw new OutOfBudget('the Codex token budget for this run cannot cover another turn');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-m', o.codexModel, '-c', 'model_reasoning_effort="low"',
      '-s', 'workspace-write', '-C', cwd];
    if (roots) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
    args.push(prompt);
    const r = run(o.codex, args, { cwd, timeout: deadline(timeoutMs) });
    spend.codexTurns++;
    const seen = codexEvidence(r.stdout).tokens;
    spend.codexTokens += (seen > 0 ? seen : limits.codexTurnReserveTokens) + (child ? limits.codexChildAllowanceTokens : 0);
    if (child) spend.codexChildAllowance = (spend.codexChildAllowance ?? 0) + limits.codexChildAllowanceTokens;
    return r;
  };

  /** A Bash call under a PreToolUse hook. Pass only when the call was attempted, the hook's refusal came back for
   *  it (matching `refusal`), and nothing was written. */
  const hookProbe = (name, hook, refusal) => {
    const d = dirs(name);
    const target = path.join(d.cwd, 'written');
    const r = claudeP(d.cwd, runTouches([target]), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] } }, 'Bash');
    const ev = claudeEvidence(r.stdout, target);
    if (exists(target)) return { ok: false, why: 'the call went through' };
    if (!ev.attempted) return { ok: null, why: `no Bash call was attempted (${failed(r)})` };
    if (ev.result?.isError && refusal.test(ev.result.text)) return { ok: true };
    return { ok: null, why: ev.result ? 'the call came back without the hook refusal' : `no result came back for the call (${failed(r)})` };
  };

  const probe = {
    'claude.version': () => version('claude', o.claude, o.claudeVersion),
    'codex.version': () => version('codex', o.codex, o.codexVersion),
    'claude.auth': () => exitZero(run(o.claude, ['auth', 'status'], { timeout: deadline(30_000) }), 'claude auth status'),
    'codex.auth': () => exitZero(run(o.codex, ['login', 'status'], { timeout: deadline(30_000) }), 'codex login status'),
    'claude.spawn': () => {
      const r = claudeP(dirs('claude-spawn').cwd, reply, null, '');
      const said = jsonLines(r.stdout).some((e) => e.type === 'result' && String(e.result ?? '').includes(OK_WORD));
      return r.status === 0 && said ? { ok: true, detail: 'a headless turn answered' } : { ok: false, detail: `a headless turn did not answer (${failed(r)})` };
    },
    'codex.spawn': () => {
      const r = codexExec(dirs('codex-spawn').cwd, reply, null);
      const said = codexEvidence(r.stdout).messages.some((m) => m.includes(OK_WORD));
      return r.status === 0 && said ? { ok: true, detail: 'a headless turn answered' } : { ok: false, detail: `a headless turn did not answer (${failed(r)})` };
    },
    'claude.hook-gate': () => {
      const c = control();
      if (c !== true) return { ok: null, detail: `the control (a hook that allows) did not run the call: ${c}` };
      const v = hookProbe('hook-deny', { type: 'command', command: 'echo "denied by canary" >&2; exit 2' }, /denied by canary/);
      return v.ok === true ? { ok: true, detail: 'a hook that exits 2 refused an attempted call, with its own message' }
        : { ok: v.ok, detail: `a hook that exits 2: ${v.why}` };
    },
    'claude.hook-onfailure-block': () => {
      const c = control();
      if (c !== true) return { ok: null, detail: `the control (a hook that allows) did not run the call: ${c}` };
      const kinds = {
        missing: { type: 'command', command: path.join(o.work, 'no-such-hook-shim'), onFailure: 'block' },
        crash: { type: 'command', command: 'kill -SEGV $$', onFailure: 'block' },
        timeout: { type: 'command', command: 'sleep 30', timeout: 2, onFailure: 'block' }
      };
      const verdicts = Object.entries(kinds).map(([k, h]) => [k, hookProbe(`hook-${k}`, h, /PreToolUse/)]);
      const open = verdicts.filter(([, v]) => v.ok === false).map(([k]) => k);
      if (open.length) return { ok: false, detail: `a hook with onFailure "block" let the call through when it: ${open.join(', ')}` };
      const unproven = verdicts.filter(([, v]) => v.ok !== true).map(([k, v]) => `${k} (${v.why})`);
      if (unproven.length) return { ok: null, detail: `not shown to block: ${unproven.join('; ')}` };
      return { ok: true, detail: 'missing, crashing and timed-out hooks with onFailure "block" each refused an attempted call' };
    },
    'claude.sandbox-write': () => {
      const d = dirs('claude-sandbox');
      const f = shellFiles(d);
      const recorded = recordedTouch(f.outside, f.rc, f.err);
      const r = claudeP(d.cwd, runCommands([`touch ${f.inside}`, recorded]), {
        sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [d.allowed] } },
        permissions: { additionalDirectories: [d.allowed] }
      }, 'Bash');
      // Text in a tool result can be printed by the command itself, so the verdict rests on the files the shell
      // recorded. Those mean something only if the recorded command ran as written and the turn ran nothing else
      // that could have written them.
      if (exists(f.outside)) return { ok: false, detail: 'a write outside the roots landed' };
      const cmds = bashCommands(r.stdout);
      if (!cmds.some((c) => c.trim() === recorded)) return { ok: null, detail: `the recorded write outside the roots was not run as written (${failed(r)})` };
      if (!cmds.every((c) => c.trim() === recorded || isTouchOf(c, f.inside) || isLookAt(c, f))) return { ok: null, detail: 'the turn also ran commands of its own, so the recorded files are not evidence' };
      return shellVerdict(f, failed(r), 'the shell');
    },
    'codex.sandbox-write': () => {
      const d = dirs('codex-sandbox');
      const f = shellFiles(d);
      const r = codexExec(d.cwd, runCommands([`touch ${f.inside}`, recordedTouch(f.outside, f.rc, f.err)]), [d.allowed]);
      return shellVerdict(f, failed(r), 'the shell');
    },
    'codex.child-thread-roots': () => {
      const d = dirs('codex-child');
      const f = shellFiles(d);
      const r = codexExec(d.cwd,
        'Spawn exactly one sub-agent, wait for it, and report what it said, including each exit code. You must not run the commands yourself; ' +
        `the sub-agent must do this: ${runCommands([`touch ${f.inside}`, recordedTouch(f.outside, f.rc, f.err)])}`, [d.allowed], limits.childTurnTimeoutMs, true);
      const ev = codexEvidence(r.stdout);
      if (exists(f.outside)) return { ok: false, detail: 'a write outside the roots landed' };
      if (ev.commands.some((c) => [f.inside, f.outside].some((p) => String(c.command ?? '').includes(p)))) {
        return { ok: null, detail: 'the parent ran the commands itself, so no child thread was tested' };
      }
      if (!ev.collab) return { ok: null, detail: `no sub-agent tool was used (${failed(r)})` };
      return shellVerdict(f, failed(r), 'a child thread');
    }
  };

  let controlResult;
  /** true, or why an allowing hook did not let an attempted call through. */
  function control() {
    if (controlResult === undefined) {
      const d = dirs('hook-control');
      const target = path.join(d.cwd, 'written');
      const r = claudeP(d.cwd, runTouches([target]), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] } }, 'Bash');
      const ev = claudeEvidence(r.stdout, target);
      controlResult = ev.attempted && exists(target) ? true : `${ev.attempted ? 'the call was attempted but wrote nothing' : 'no Bash call was attempted'} (${failed(r)})`;
    }
    return controlResult;
  }
  function version(cli, exe, expected) {
    const where = onPath(exe) ?? exe;
    const got = parseVersion(cli, out(run(exe, ['--version'], { timeout: deadline(30_000) })));
    if (!got) return { ok: false, detail: `${where} --version printed no version` };
    if (got !== expected) return { ok: false, detail: `${where} is ${cli} ${got}, expected ${expected}` };
    return { ok: true, detail: `${where} is ${cli} ${got}` };
  }
  function shellFiles(d) {
    return { inside: path.join(d.allowed, 'x'), outside: path.join(d.forbidden, 'x'), rc: path.join(d.allowed, 'rc'), err: path.join(d.allowed, 'err') };
  }
  /** Pass only on what the shell wrote: the in-roots file, and for the out-of-roots touch a non-zero exit code and the
   *  sandbox's own refusal text, recorded in files inside the roots. */
  function shellVerdict(f, why, who) {
    const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
    const rc = read(f.rc);
    if (exists(f.outside)) return { ok: false, detail: 'a write outside the roots landed' };
    // A recorded 0 means the sandbox allowed the outside write, whatever became of the inside one.
    if (rc === '0') return { ok: false, detail: 'the shell recorded exit code 0 for the write outside the roots' };
    if (!exists(f.inside)) return { ok: null, detail: `${who} did not write inside its roots, so it may never have run (${why})` };
    if (rc === null) return { ok: null, detail: `the recorded write outside the roots was never run (${why})` };
    if (!/^[1-9]\d*$/.test(rc)) return { ok: null, detail: `the write outside the roots recorded exit code ${JSON.stringify(rc)}` };
    if (!REFUSED.test(read(f.err) ?? '')) return { ok: null, detail: 'the write outside the roots failed, but not with a sandbox refusal' };
    return { ok: true, detail: `${who} wrote inside its roots; the shell recorded the write outside them refused (exit ${rc})` };
  }
  function exitZero(r, what) { return r.status === 0 ? { ok: true, detail: `${what} exited 0` } : { ok: false, detail: `${what}: ${failed(r)}` }; }

  for (const name of wanted) {
    const t0 = now();
    let r;
    try { r = probe[name](); } catch (e) {
      r = e instanceof OutOfBudget ? { ok: null, detail: `not run: ${e.message}` } : { ok: false, detail: `probe threw: ${e?.message ?? e}` };
    }
    results.push({ probe: name, ok: r.ok, ms: now() - t0, detail: r.detail });
  }
  return { results, spend };
}

function parseArgs(argv) {
  const o = { claude: 'claude', codex: 'codex', claudeModel: 'claude-haiku-5-5' };
  const map = { '--claude': 'claude', '--codex': 'codex', '--claude-version': 'claudeVersion', '--codex-version': 'codexVersion',
    '--claude-model': 'claudeModel', '--codex-model': 'codexModel', '--work': 'work' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--keep') o.keep = true;
    else if (map[a] && i + 1 < argv.length) o[map[a]] = argv[++i];
    else throw new Error(`unknown or incomplete argument ${a}`);
  }
  for (const [flag, key] of [['--claude-version', 'claudeVersion'], ['--codex-version', 'codexVersion'], ['--codex-model', 'codexModel']]) {
    if (!o[key]) throw new Error(`${flag} is required: probe the version and model seats are pinned to`);
  }
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const made = !o.work;
  o.work = o.work ?? fs.mkdtempSync(path.join(os.homedir(), '.upgrade-canary-'));
  let res;
  let refused = null;
  try { res = runCanary(o); } catch (e) { refused = e; } finally { if (made && !o.keep) fs.rmSync(o.work, { recursive: true, force: true }); }
  if (refused) { console.error(refused.message); process.exit(2); }
  for (const r of res.results) console.log(JSON.stringify(r));
  const s = res.spend;
  console.log(`spend: claude $${s.claudeUsd.toFixed(4)} over ${s.claudeTurns} turns (limit $${LIMITS.claudeTotalUsd}); ` +
    `codex ${s.codexTokens} tokens charged over ${s.codexTurns} turns, including a ${s.codexChildAllowance ?? 0}-token allowance for child threads it cannot see (budget ${LIMITS.codexTotalTokens})`);
  const notPassed = res.results.filter((r) => r.ok !== true);
  console.log(notPassed.length ? `canary: ${notPassed.length} of ${res.results.length} probes did not pass` : `canary: all ${res.results.length} probes passed`);
  process.exit(notPassed.length ? 1 : 0);
}

module.exports = { PROBES, LIMITS, runCanary, parseArgs, isUnderTemp, claudeEvidence, codexEvidence };
if (require.main === module) main();
