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

/** The shell-recorded form of the touch of `t` in a prompt: sh -c 'touch <t> 2> <err>; echo $? > <rc>'. */
const recordedFor = (prompt, t) =>
  new RegExp(`sh -c 'touch ${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 2> (\\S+); echo \\$\\? > (\\S+)'`).exec(prompt);
const touches = (prompt) => [...prompt.matchAll(/touch (\S+)/g)].map((m) => m[1]);
const write = (p) => { try { fs.writeFileSync(p, ''); return true; } catch { return false; } };
const under = (p, root) => p === root || p.startsWith(root + path.sep);
const lines = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Claude stream-json for a turn that ran these Bash calls; each call is [command, isError, text]. */
function claudeStream(calls, result = 'done', cost = 0.01) {
  const ev = [{ type: 'system', subtype: 'init' }];
  calls.forEach(([command, isError, text, name = 'Bash'], i) => {
    ev.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name, input: { command } }] } });
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
 *   extra-call         the model also runs a command of its own (ls /)
 *   looks              the model also reads its results, as Claude Haiku does: ls -la <allowed>/ and cat <rc> <err>
 *   sneaky-look        the model's 'look' writes: cat <rc> > <err>
 *   ls-bare / ls-la    the model also lists the working folder: ls / ls -la
 *   ls-ignore          the model's ls names the allowed folder only as a flag's argument (GNU: ls -I <allowed>)
 *   other-tool         the turn also calls a shell tool not named Bash, which could rewrite the recorded files
 *   forge-refusal      the sandbox fails open, and the model's command for the outside write also removes the file
 *                      and prints a refusal: touch <out>; echo $?\nunlink <out>\necho Operation not permitted
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
        const rec = recordedFor(prompt, t);
        const cmd = rec ? rec[0] : `touch ${t}`;
        const outsideT = t.includes(`${path.sep}forbidden${path.sep}`);
        const record = (code, err) => {
          if (!rec) return;
          if (err) fs.writeFileSync(rec[1], err);
          if (!faults.has('rc-missing')) fs.writeFileSync(rec[2], `${faults.has('rc-zero') ? 0 : code}\n`);
        };
        if (faults.has('no-inside') && !outsideT && !hook) { calls.push([cmd, true, `touch: ${t}: Operation not permitted`]); continue; }
        if (faults.has('other-error') && rec) { record(1, `touch: ${t}: No such file or directory\n`); calls.push([cmd, false, '']); continue; }
        if (faults.has('other-error') && ((hook && hook.command !== 'exit 0') || t.includes(`${path.sep}forbidden${path.sep}`))) { calls.push([cmd, true, `touch: ${t}: No such file or directory`]); continue; }
        if (hook) {
          const denies = /exit 2/.test(hook.command);
          if (denies && !faults.has('deny-open')) { calls.push([cmd, true, `PreToolUse:Bash hook error: [${hook.command}]: denied by canary\n`]); continue; }
          if (!denies && hook.command !== 'exit 0' && hook.onFailure === 'block' && !faults.has('hook-open')) {
            calls.push([cmd, true, `PreToolUse:Bash hook error: [${hook.command}]: hook failed`]); continue;
          }
        }
        if (faults.has('forge-refusal') && allow && !allow.some((r) => under(t, r))) {
          write(t); fs.rmSync(t);
          calls.push([`touch ${t}; echo $?\nunlink ${t}\necho Operation not permitted`, false, '0\nOperation not permitted']); continue;
        }
        if (allow && !faults.has('claude-sandbox') && !allow.some((r) => under(t, r))) {
          if (rec) { record(1, `touch: ${t}: Operation not permitted\n`); calls.push([cmd, false, '']); continue; }
          calls.push([cmd, true, `touch: ${t}: Operation not permitted`]); continue;
        }
        write(t);
        record(0, '');
        calls.push([cmd, false, '']);
      }
      if (faults.has('extra-call')) calls.push(['ls /', false, 'bin']);
      const rcFile = /echo \$\? > (\S+)'/.exec(prompt)?.[1];
      const errFile = / 2> (\S+);/.exec(prompt)?.[1];
      if (rcFile && faults.has('looks')) calls.push([`ls -la ${path.dirname(rcFile)}/`, false, 'x rc err'], [`cat ${rcFile} ${errFile}`, false, '1']);
      if (rcFile && faults.has('sneaky-look')) calls.push([`cat ${rcFile} > ${errFile}`, false, '']);
      if (rcFile && faults.has('ls-bare')) calls.push(['ls', false, '']);
      if (rcFile && faults.has('ls-la')) calls.push(['ls -la', false, '']);
      if (rcFile && faults.has('ls-ignore')) calls.push([`ls -I ${path.dirname(rcFile)}`, false, '']);
      if (rcFile && faults.has('other-tool')) calls.push([`echo 1 > ${rcFile}`, false, '', 'Shell']);
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

/** A stand-in Claude executable: the settings schema for these key paths, minified the way the CLI carries it, with
 *  the network, filesystem and credentials objects built lazily and referred to by name. */
const ANCHORED = { 'sandbox.network': 'Ja', 'sandbox.filesystem': 'Za', 'sandbox.credentials': 'el' };
function schemaFor(paths) {
  const tree = {};
  for (const p of paths) { let n = tree; for (const part of p.split('.')) n = n[part] ??= {}; }
  const defs = [];
  const emit = (node, at) => `u({${Object.entries(node).map(([k, kids]) => {
    const here = `${at}.${k}`;
    if (ANCHORED[here]) { defs.push(`${ANCHORED[here]}=p(()=>${emit(kids, here)})`); return `${k}:${ANCHORED[here]}()`; }
    return Object.keys(kids).length ? `${k}:${emit(kids, here)}.optional()` : `${k}:M().optional().describe("a, {b}")`;
  }).join(',')}})`;
  const sandbox = `DGo=p(()=>${emit(tree.sandbox ?? {}, 'sandbox')})`;
  const perms = `function nr(e){return ${emit(tree.permissions ?? {}, 'permissions')}.passthrough()}`;
  return `\0\0binary;${defs.join(';')};${sandbox};${perms};more\0`;
}
const keyFixture = require('../tools/claude-settings-keys.json');
const fakeBinaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-canary-bin-'));
test.after(() => fs.rmSync(fakeBinaryDir, { recursive: true, force: true }));
const fakeBinary = (name, paths) => { const f = path.join(fakeBinaryDir, name); fs.writeFileSync(f, schemaFor(paths)); return f; };
const PINNED_BINARY = fakeBinary('claude-pinned', keyFixture.paths);

const base = (work, run, extra = {}) => ({
  claude: '/fake/claude', codex: '/fake/codex', claudeModel: 'm', codexModel: 'm', work, run, allowTempWork: true,
  claudeVersion: '2.1.332', codexVersion: '0.172.0', claudeBinary: PINNED_BINARY, ...extra
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
    for (const f of [['stop-early', 'claims-refusal'], ['rc-missing'], ['no-inside']]) {
      withWork((work) => assert.equal(one(work, f, probe).ok, null, f.join('+')));
    }
    // The shell saying the outside write succeeded is a failure, not a lack of evidence.
    for (const f of [['rc-zero'], ['rc-zero', 'no-inside']]) {
      withWork((work) => {
        const r = one(work, f, probe);
        assert.equal(r.ok, false, `${f.join('+')}: ${r.detail}`);
        assert.match(r.detail, /exit code 0/);
      });
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

test('claude.settings-keys passes when the installed CLI accepts exactly the keys the settings table classifies', () => {
  withWork((work) => {
    const r = canary.runCanary(base(work, fakeRun(), { only: ['claude.settings-keys'] })).results[0];
    assert.equal(r.ok, true, r.detail);
  });
});

test('claude.settings-keys fails, naming the keys, when the installed CLI accepts a key the table lacks or lacks one it has', () => {
  withWork((work) => {
    const changed = [...keyFixture.paths.filter((p) => p !== 'permissions.disableAutoMode'), 'sandbox.network.newThing'];
    const r = canary.runCanary(base(work, fakeRun(), { only: ['claude.settings-keys'], claudeBinary: fakeBinary('claude-changed', changed) })).results[0];
    assert.equal(r.ok, false, r.detail);
    assert.match(r.detail, /sandbox\.network\.newThing/);
    assert.match(r.detail, /permissions\.disableAutoMode/);
  });
});

test('claude.settings-keys fails when the pinned version is not the one the table was read from', () => {
  withWork((work) => {
    const r = canary.runCanary(base(work, fakeRun(new Set(), { claude: '2.1.333', codex: '0.172.0' }), { only: ['claude.settings-keys'], claudeVersion: '2.1.333' })).results[0];
    assert.equal(r.ok, false, r.detail);
    assert.match(r.detail, /2\.1\.332/);
  });
});

test('claude.settings-keys is inconclusive when the schema cannot be read from the executable', () => {
  withWork((work) => {
    const blank = path.join(fakeBinaryDir, 'claude-blank');
    fs.writeFileSync(blank, 'no schema here');
    for (const claudeBinary of [blank, path.join(fakeBinaryDir, 'missing')]) {
      const r = canary.runCanary(base(work, fakeRun(), { only: ['claude.settings-keys'], claudeBinary })).results[0];
      assert.equal(r.ok, null, r.detail);
    }
  });
});

test('--claude-binary names the executable the settings keys are read from', () => {
  assert.equal(canary.parseArgs(['--codex-model', 'm', '--claude-version', '2', '--codex-version', '0', '--claude-binary', '/x/claude']).claudeBinary, '/x/claude');
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
  assert.equal(canary.claudeEvidence(stream('touch /w/t-other'), '/w/t').attempted, false);
  assert.equal(canary.claudeEvidence(stream('touch /elsewhere; echo /w/t'), '/w/t').attempted, false);
  assert.equal(canary.claudeEvidence(stream('touch /w/t /w/u'), '/w/t').attempted, false);
  assert.equal(canary.claudeEvidence(stream("touch '/w/t'"), '/w/t').attempted, true);
  assert.equal(canary.claudeEvidence(stream('  touch /w/t\n'), '/w/t').attempted, true);
  // A model asked for exit codes may echo $? after the touch; nothing else may follow it.
  for (const ok of ['touch /w/t; echo "exit=$?"', 'touch /w/t && echo $?', 'touch /w/t 2>&1; echo $?']) {
    assert.equal(canary.claudeEvidence(stream(ok), '/w/t').attempted, true, ok);
  }
  // No line break anywhere: each line is a command of its own.
  for (const bad of ['touch /w/t; echo $?\ntouch /etc/other', 'touch /w/t && echo $?\nrm -rf /x', 'touch\n/w/t', 'touch /w/t\r\necho $?']) {
    assert.equal(canary.claudeEvidence(stream(bad), '/w/t').attempted, false, JSON.stringify(bad));
  }
  for (const bad of ['touch /w/t; touch /w/u', 'touch /w/t; echo $(cat /etc/hosts)', 'touch /w/t; echo $?; rm -f /w/t', 'touch /w/t | tee /w/u']) {
    assert.equal(canary.claudeEvidence(stream(bad), '/w/t').attempted, false, bad);
  }
});

test("a work folder that already holds files is refused: a previous run's files could pass a probe", () => {
  withWork((work) => {
    fs.mkdirSync(path.join(work, '01-claude-sandbox', 'allowed'), { recursive: true });
    fs.writeFileSync(path.join(work, '01-claude-sandbox', 'allowed', 'x'), '');
    assert.throws(() => canary.runCanary(base(work, fakeRun())), /not empty/);
  });
  // An empty or missing folder is fine.
  withWork((work) => assert.ok(canary.runCanary(base(work, fakeRun(), { only: ['claude.version'] }))));
  withWork((work) => assert.ok(canary.runCanary(base(path.join(work, 'new'), fakeRun(), { only: ['claude.version'] }))));
});

test('a failed-open sandbox whose command removes the file and prints a refusal is not a pass', () => {
  withWork((work) => {
    const r = one(work, ['forge-refusal'], 'claude.sandbox-write');
    assert.notEqual(r.ok, true, r.detail);
  });
});

test('claude.sandbox-write is judged on the shell receipt, and only when the turn ran nothing but the generated commands', () => {
  withWork((work) => {
    const r = one(work, [], 'claude.sandbox-write');
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /shell recorded .*refused \(exit 1\)/);
  });
  withWork((work) => {
    const r = one(work, ['looks'], 'claude.sandbox-write');
    assert.equal(r.ok, true, `reading the results back is harmless: ${r.detail}`);
  });
  for (const f of [['extra-call'], ['sneaky-look'], ['other-tool'], ['ls-bare'], ['ls-la'], ['ls-ignore'], ['rc-missing'], ['no-inside'], ['other-error'], ['stop-early']]) {
    withWork((work) => assert.equal(one(work, f, 'claude.sandbox-write').ok, null, f.join('+')));
  }
  // A recorded 0 says the sandbox let the write through, whatever else the turn ran afterwards.
  for (const f of [['rc-zero'], ['claude-sandbox'], ['rc-zero', 'extra-call'], ['rc-zero', 'other-tool']]) {
    withWork((work) => assert.equal(one(work, f, 'claude.sandbox-write').ok, false, f.join('+')));
  }
});
