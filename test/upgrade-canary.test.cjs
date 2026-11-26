'use strict';

/**
 * The upgrade canary runs real CLIs, so these drive its probes with stand-in CLIs that print the same event streams
 * (Claude stream-json, Codex exec --json): one that behaves the way a safe CLI must, ones that fail open in exactly
 * one way, and ones whose turns fail or never try the call. Each probe must pass on the first, fail on its own
 * failure, and be inconclusive, never pass, when there is no evidence that the call was attempted and refused.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canary = require('../tools/upgrade-canary.cjs');

const touches = (prompt) => [...prompt.matchAll(/touch (\S+)/g)].map((m) => m[1]);
const write = (p) => { try { fs.writeFileSync(p, ''); return true; } catch { return false; } };
const under = (p, root) => p === root || p.startsWith(root + path.sep);
const lines = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Claude stream-json for a turn that ran these Bash calls; each call is [command, isError, text]. */
function claudeStream(calls, result = 'done', cost = 0.01) {
  const ev = [{ type: 'system', subtype: 'init' }];
  calls.forEach(([command, isError, text], i) => {
    ev.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } });
    ev.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: isError, content: text }] } });
  });
  ev.push({ type: 'result', subtype: 'success', result, total_cost_usd: cost });
  return lines(ev);
}

/**
 * A stand-in for both CLIs. `faults` names how it misbehaves:
 *   hook-open          a PreToolUse hook with onFailure "block" that cannot run lets the call through
 *   deny-open          a hook that exits 2 does not block
 *   claude-sandbox     Claude's sandbox lets Bash write outside allowWrite
 *   codex-sandbox      Codex ignores writable_roots and writes anywhere
 *   child-open         a Codex child thread writes outside the roots
 *   no-child           Codex runs the commands itself instead of in a child thread
 *   fail-after-control every Claude turn after the first hook turn exits 1 with a 429 and does nothing
 *   no-bash            Claude turns answer without ever calling Bash
 *   stop-early         a model runs only the first command it was given
 *   other-error        every out-of-roots or hooked call fails for some other reason (no such file), writing nothing
 *   no-collab-item     the child runs, but the stream shows no sub-agent tool
 *   claims-refusal     the model's report says the write outside the roots was refused, whatever really ran
 *   rc-zero / rc-missing  the recorded exit code reads 0 / is not written, though the refusal text is
 *   no-inside          the write inside the roots is refused too
 */
function fakeRun(faults = new Set(), versions = { claude: '2.1.332', codex: '0.172.0' }) {
  let claudeHookTurns = 0;
  return (file, args, opts) => {
    const cli = path.basename(file);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === '--version') return ok(cli === 'claude' ? `${versions.claude} (Claude Code)\n` : `codex-cli ${versions.codex}\n`);
    if (cli === 'claude' && args[0] === 'auth') return ok('{"loggedIn":true}');
    if (cli === 'codex' && args[0] === 'login') return ok('Logged in using ChatGPT');
    const prompt = args[args.length - 1];
    let wanted = touches(prompt);
    if (faults.has('stop-early')) wanted = wanted.slice(0, 1);
    if (cli === 'claude') {
      // Like the real CLI: a variadic --tools reads the prompt as a tool name unless -- ends the options.
      if (args[args.length - 2] !== '--') return { status: 1, stdout: '', stderr: 'Input must be provided' };
      if (!args.includes('stream-json')) return ok('done');
      const si = args.indexOf('--settings');
      const settings = si >= 0 ? JSON.parse(fs.readFileSync(args[si + 1], 'utf8')) : {};
      const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (hook && claudeHookTurns++ > 0 && faults.has('fail-after-control')) return { status: 1, stdout: '', stderr: 'API Error: 429 rate limited' };
      if (!wanted.length) return ok(claudeStream([], 'canary-ok'));
      if (faults.has('no-bash')) return ok(claudeStream([], 'I would rather not.'));
      const allow = settings.sandbox?.enabled ? [opts.cwd, ...settings.sandbox.filesystem.allowWrite] : null;
      const calls = [];
      for (const t of wanted) {
        const cmd = `touch ${t}`;
        if (faults.has('other-error') && ((hook && hook.command !== 'exit 0') || t.includes(`${path.sep}forbidden${path.sep}`))) { calls.push([cmd, true, `touch: ${t}: No such file or directory`]); continue; }
        if (hook) {
          const denies = /exit 2/.test(hook.command);
          if (denies && !faults.has('deny-open')) { calls.push([cmd, true, `PreToolUse:Bash hook error: [${hook.command}]: denied by canary\n`]); continue; }
          if (!denies && hook.command !== 'exit 0' && hook.onFailure === 'block' && !faults.has('hook-open')) {
            calls.push([cmd, true, `PreToolUse:Bash hook error: [${hook.command}]: hook failed`]); continue;
          }
        }
        if (allow && !faults.has('claude-sandbox') && !allow.some((r) => under(t, r))) { calls.push([cmd, true, `touch: ${t}: Operation not permitted`]); continue; }
        write(t);
        calls.push([cmd, false, '']);
      }
      return ok(claudeStream(calls));
    }
    // codex exec --json
    const roots = [args[args.indexOf('-C') + 1]];
    const ci = args.findIndex((a, i) => args[i - 1] === '-c' && a.startsWith('sandbox_workspace_write.writable_roots='));
    if (ci >= 0) roots.push(...JSON.parse(args[ci].split('=')[1]));
    const ev = [{ type: 'thread.started' }, { type: 'turn.started' }];
    const usage = { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } };
    if (!wanted.length) return ok(lines([...ev, { type: 'item.completed', item: { type: 'agent_message', text: 'canary-ok' } }, usage]));
    const child = /sub-agent/.test(prompt) && !faults.has('no-child');
    const report = [];
    wanted.forEach((t, i) => {
      const open = faults.has('codex-sandbox') || (child && faults.has('child-open'));
      const writable = (p) => open || roots.some((r) => under(p, r));
      const other = faults.has('other-error') && t.includes(`${path.sep}forbidden${path.sep}`);
      const inRoots = !t.includes(`${path.sep}forbidden${path.sep}`);
      const wrote = !other && !(faults.has('no-inside') && inRoots) && writable(t) && write(t);
      const why = other ? 'No such file or directory' : 'Operation not permitted';
      // The shell-recorded form: sh -c 'touch <t> 2> <err>; echo $? > <rc>'
      const rec = new RegExp(`sh -c 'touch ${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 2> (\\S+); echo \\$\\? > (\\S+)'`).exec(prompt);
      if (rec) {
        if (!wrote && writable(rec[1])) fs.writeFileSync(rec[1], `touch: ${t}: ${why}\n`);
        if (writable(rec[2]) && !faults.has('rc-missing')) fs.writeFileSync(rec[2], `${wrote || faults.has('rc-zero') ? 0 : 1}\n`);
      }
      const item = { id: `c${i}`, type: 'command_execution', command: `/bin/zsh -lc '${rec ? rec[0] : `touch ${t}`}'`, exit_code: rec ? 0 : (wrote ? 0 : 1),
        aggregated_output: wrote ? '' : `touch: ${t}: ${why}`, status: 'completed' };
      report.push(`touch ${t} — exit code ${wrote ? 0 : 1}`);
      if (!child) ev.push({ type: 'item.completed', item });
    });
    if (faults.has('claims-refusal')) report.push(`touch ${roots[0]}/../forbidden/x — exit code 1 (Operation not permitted)`);
    if (!child) ev.push({ type: 'item.completed', item: { type: 'agent_message', text: report.join('\n') } });
    if (child) {
      if (!faults.has('no-collab-item')) ev.push({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait', status: 'completed' } });
      ev.push({ type: 'item.completed', item: { type: 'agent_message', text: `The sub-agent reported:\n${report.join('\n')}` } });
    }
    return ok(lines([...ev, usage]));
  };
}

function withWork(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-canary-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const base = (work, run, extra = {}) => ({
  claude: '/fake/claude', codex: '/fake/codex', claudeModel: 'm', codexModel: 'm', work, run, allowTempWork: true,
  claudeVersion: '2.1.332', codexVersion: '0.172.0', ...extra
});
const one = (work, faults, probe, extra) => canary.runCanary(base(work, fakeRun(new Set(faults)), { only: [probe], ...extra })).results[0];

test('a CLI that keeps every promise passes every probe', () => {
  withWork((work) => {
    const { results } = canary.runCanary(base(work, fakeRun()));
    for (const r of results) assert.equal(r.ok, true, `${r.probe}: ${r.detail}`);
    assert.deepEqual(results.map((r) => r.probe).sort(), [...canary.PROBES].sort());
  });
});

for (const [fault, probe] of [
  ['hook-open', 'claude.hook-onfailure-block'],
  ['deny-open', 'claude.hook-gate'],
  ['claude-sandbox', 'claude.sandbox-write'],
  ['codex-sandbox', 'codex.sandbox-write'],
  ['child-open', 'codex.child-thread-roots']
]) {
  test(`${fault} fails ${probe}`, () => {
    withWork((work) => {
      const r = one(work, [fault], probe);
      assert.equal(r.probe, probe);
      assert.equal(r.ok, false, r.detail);
    });
  });
}

// The reviewers' case: the control writes, then every later turn fails before any tool call.
for (const probe of ['claude.hook-gate', 'claude.hook-onfailure-block']) {
  test(`${probe} is inconclusive, not a pass, when turns after the control fail`, () => {
    withWork((work) => {
      const r = one(work, ['fail-after-control'], probe);
      assert.equal(r.ok, null, r.detail);
      assert.match(r.detail, /no Bash call was attempted.*exit 1/);
    });
  });
}

for (const [fault, probe] of [
  ['no-bash', 'claude.hook-gate'],
  ['no-bash', 'claude.hook-onfailure-block'],
  ['no-bash', 'claude.sandbox-write'],
  ['stop-early', 'claude.sandbox-write'],
  ['stop-early', 'codex.sandbox-write'],
  ['no-child', 'codex.child-thread-roots'],
  ['other-error', 'claude.hook-gate'],
  ['other-error', 'claude.hook-onfailure-block'],
  ['other-error', 'claude.sandbox-write'],
  ['other-error', 'codex.sandbox-write'],
  ['other-error', 'codex.child-thread-roots'],
  ['no-collab-item', 'codex.child-thread-roots']
]) {
  test(`${probe} is inconclusive when ${fault}`, () => {
    withWork((work) => assert.equal(one(work, [fault], probe).ok, null));
  });
}

test('the run stops spending once its Claude budget is used up, and reports the spend', () => {
  withWork((work) => {
    const run = (file, args, opts) => {
      const r = fakeRun()(file, args, opts);
      return { ...r, stdout: r.stdout.replace(/"total_cost_usd":[0-9.]+/g, '"total_cost_usd":0.1') };
    };
    const res = canary.runCanary(base(work, run, { limits: { claudeTurnUsd: 0.1, claudeTotalUsd: 0.25 } }));
    assert.equal(res.spend.claudeTurns, 2);
    const skipped = res.results.filter((r) => /not run: the Claude spend limit/.test(r.detail ?? ''));
    assert.ok(skipped.length >= 2, JSON.stringify(res.results));
    for (const r of skipped) assert.equal(r.ok, null);
  });
});

test('a turn that reports no cost is counted at its cap', () => {
  withWork((work) => {
    const run = (file, args, opts) => {
      const r = fakeRun()(file, args, opts);
      return { ...r, stdout: r.stdout.replace(/"total_cost_usd":[0-9.]+/g, '"x":0') };
    };
    const res = canary.runCanary(base(work, run, { only: ['claude.spawn'], limits: { claudeTurnUsd: 0.1 } }));
    assert.equal(res.spend.claudeUsd, 0.1);
  });
});

test('the run stops starting model turns at its wall-clock limit', () => {
  withWork((work) => {
    let t = 0;
    const run = (file, args, opts) => { t += 60_000; return fakeRun()(file, args, opts); };
    const res = canary.runCanary(base(work, run, { now: () => t, limits: { wallClockMs: 150_000 } }));
    assert.ok(res.results.some((r) => /wall-clock/.test(r.detail ?? '') && r.ok === null), JSON.stringify(res.results));
  });
});

test('a Codex turn starts only if its allowance fits; the child turn is charged an allowance for its child', () => {
  withWork((work) => {
    const limits = { codexTotalTokens: 3500, codexTurnReserveTokens: 1000, codexChildAllowanceTokens: 1000 };
    const res = canary.runCanary(base(work, fakeRun(), { limits }));
    // spawn and sandbox: 1,100 reported each; the child turn would need 1,000 + 1,000 on top of 2,200.
    assert.equal(res.spend.codexTokens, 2200);
    const r = res.results.find((x) => x.probe === 'codex.child-thread-roots');
    assert.equal(r.ok, null);
    assert.match(r.detail, /Codex token budget/);
  });
  withWork((work) => {
    const limits = { codexTotalTokens: 10_000, codexTurnReserveTokens: 1000, codexChildAllowanceTokens: 1000 };
    const roomy = canary.runCanary(base(work, fakeRun(), { only: ['codex.child-thread-roots'], limits }));
    assert.equal(roomy.spend.codexTokens, 1100 + 1000);
  });
});

test('a Codex turn that reports no usage is charged its full allowance', () => {
  withWork((work) => {
    const run = (file, args, opts) => {
      const r = fakeRun()(file, args, opts);
      return { ...r, stdout: r.stdout.replace(/.*"turn\.completed".*\n/g, '') };
    };
    const res = canary.runCanary(base(work, run, { only: ['codex.spawn'], limits: { codexTurnReserveTokens: 5000 } }));
    assert.equal(res.spend.codexTokens, 5000);
  });
});

for (const probe of ['codex.sandbox-write', 'codex.child-thread-roots']) {
  test(`${probe}: a refusal the model only claims is not evidence; the shell must record it`, () => {
    for (const f of [['stop-early', 'claims-refusal'], ['rc-zero'], ['rc-missing'], ['no-inside']]) {
      withWork((work) => assert.equal(one(work, f, probe).ok, null, f.join('+')));
    }
    withWork((work) => {
      const r = one(work, [], probe);
      assert.equal(r.ok, true, r.detail);
      assert.match(r.detail, /shell recorded .*refused \(exit 1\)/);
    });
  });
}

test('a version other than the expected one fails its probe, naming the binary', () => {
  withWork((work) => {
    const r = canary.runCanary(base(work, fakeRun(new Set(), { claude: '2.1.333', codex: '0.172.0' }), { only: ['claude.version'] })).results[0];
    assert.equal(r.ok, false);
    assert.match(r.detail, /\/fake\/claude is claude 2\.1\.333, expected 2\.1\.332/);
  });
});

test('a failed auth probe fails', () => {
  withWork((work) => {
    const run = (file, args, opts) => (args[0] === 'login' ? { status: 1, stdout: 'Not logged in', stderr: '' } : fakeRun()(file, args, opts));
    assert.equal(canary.runCanary(base(work, run, { only: ['codex.auth'] })).results[0].ok, false);
  });
});

test('the expected versions and the Codex model are required on the command line', () => {
  assert.throws(() => canary.parseArgs(['--codex-model', 'm', '--codex-version', '0.172.0']), /--claude-version is required/);
  assert.throws(() => canary.parseArgs(['--codex-model', 'm', '--claude-version', '2.1.332']), /--codex-version is required/);
  assert.ok(canary.parseArgs(['--codex-model', 'm', '--claude-version', '2', '--codex-version', '0']));
  // The temp-folder escape hatch is for the tests only.
  assert.throws(() => canary.parseArgs(['--allow-temp-work']), /unknown/);
});

test('a work folder under a temp directory is refused: both sandboxes let any command write there', () => {
  const o = base(path.join(os.tmpdir(), 'x'), fakeRun());
  delete o.allowTempWork;
  assert.throws(() => canary.runCanary(o), /temp/);
});

test('only a touch of the target counts as the attempted call, not a command that merely mentions it', () => {
  const stream = (command) => claudeStream([[command, true, 'PreToolUse:Bash hook error: denied by canary']]);
  assert.equal(canary.claudeEvidence(stream('touch /w/t'), '/w/t').attempted, true);
  assert.equal(canary.claudeEvidence(stream('echo touch /w/t'), '/w/t').attempted, false);
});
