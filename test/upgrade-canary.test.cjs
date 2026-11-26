'use strict';

/**
 * The upgrade canary runs real CLIs, so these drive its probes with stand-in CLIs: one that behaves the way a safe
 * CLI must, and ones that fail open in exactly one way. Each probe must pass on the first and fail on its own
 * failure, and a probe whose control did not run must not report a pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canary = require('../tools/upgrade-canary.cjs');

/** Shell commands a prompt asks for: every `touch <path>`. */
const touches = (prompt) => [...prompt.matchAll(/touch (\S+)/g)].map((m) => m[1]);
const write = (p) => { try { fs.writeFileSync(p, ''); return true; } catch { return false; } };
const under = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * A stand-in for both CLIs. `faults` names the one way it fails open:
 *   hook-open       - a PreToolUse hook with onFailure "block" that cannot run lets the call through
 *   deny-open       - a hook that exits 2 does not block
 *   claude-sandbox  - Claude's sandbox lets Bash write outside allowWrite
 *   codex-sandbox   - Codex ignores writable_roots and writes anywhere
 *   child-open      - a Codex child thread writes outside the roots
 *   no-child        - Codex runs the commands itself instead of in a child thread
 */
function fakeRun(faults = new Set(), versions = { claude: '2.1.332', codex: '0.172.0' }) {
  return (file, args, opts) => {
    const cli = path.basename(file);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === '--version') return ok(cli === 'claude' ? `${versions.claude} (Claude Code)\n` : `codex-cli ${versions.codex}\n`);
    if (cli === 'claude' && args[0] === 'auth') return ok('{"loggedIn":true}');
    if (cli === 'codex' && args[0] === 'login') return ok('Logged in using ChatGPT');
    const prompt = args[args.length - 1];
    if (cli === 'claude') {
      // Like the real CLI: a variadic --tools reads the prompt as a tool name unless -- ends the options.
      if (args[args.length - 2] !== '--') return { status: 1, stdout: '', stderr: 'Input must be provided' };
      const si = args.indexOf('--settings');
      const settings = si >= 0 ? JSON.parse(fs.readFileSync(args[si + 1], 'utf8')) : {};
      if (!touches(prompt).length) return ok('canary-ok');
      const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (hook) {
        const denies = /exit 2/.test(hook.command);
        const fails = !denies;
        if (denies && !faults.has('deny-open')) return ok('blocked');
        if (fails && hook.onFailure === 'block' && !faults.has('hook-open')) return ok('blocked');
      }
      const allow = settings.sandbox?.enabled ? [opts.cwd, ...settings.sandbox.filesystem.allowWrite] : null;
      for (const t of touches(prompt)) {
        if (allow && !faults.has('claude-sandbox') && !allow.some((r) => under(t, r))) continue;
        write(t);
      }
      return ok('done');
    }
    // codex exec
    const roots = [args[args.indexOf('-C') + 1]];
    const ci = args.findIndex((a, i) => args[i - 1] === '-c' && a.startsWith('sandbox_workspace_write.writable_roots='));
    if (ci >= 0) roots.push(...JSON.parse(args[ci].split('=')[1]));
    if (!touches(prompt).length) return ok('canary-ok');
    const child = /sub-agent/.test(prompt);
    const events = [];
    if (child && !faults.has('no-child')) events.push(JSON.stringify({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent' } }));
    for (const t of touches(prompt)) {
      const open = faults.has('codex-sandbox') || (child && faults.has('child-open'));
      if (open || roots.some((r) => under(t, r))) write(t);
    }
    return ok(events.join('\n'));
  };
}

function withWork(fn) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.upgrade-canary-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const base = (work, run, extra = {}) => ({
  claude: '/fake/claude', codex: '/fake/codex', claudeModel: 'm', codexModel: 'm', work, run,
  claudeVersion: '2.1.332', codexVersion: '0.172.0', ...extra
});

test('a CLI that keeps every promise passes every probe', () => {
  withWork((work) => {
    const results = canary.runCanary(base(work, fakeRun()));
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
      const r = canary.runCanary(base(work, fakeRun(new Set([fault])), { only: [probe] }))[0];
      assert.equal(r.probe, probe);
      assert.equal(r.ok, false, r.detail);
    });
  });
}

test('a child-thread probe with no child thread is inconclusive, not a pass', () => {
  withWork((work) => {
    const r = canary.runCanary(base(work, fakeRun(new Set(['no-child'])), { only: ['codex.child-thread-roots'] }))[0];
    assert.equal(r.ok, null, r.detail);
  });
});

test('a version other than the expected one fails its probe', () => {
  withWork((work) => {
    const r = canary.runCanary(base(work, fakeRun(new Set(), { claude: '2.1.333', codex: '0.172.0' }), { only: ['claude.version'] }))[0];
    assert.equal(r.ok, false);
    assert.match(r.detail, /2\.1\.333.*2\.1\.332/);
  });
});

test('a failed auth probe fails', () => {
  withWork((work) => {
    const run = (file, args, opts) => (args[0] === 'login' ? { status: 1, stdout: 'Not logged in', stderr: '' } : fakeRun()(file, args, opts));
    const r = canary.runCanary(base(work, run, { only: ['codex.auth'] }))[0];
    assert.equal(r.ok, false);
  });
});

test('a work folder under a temp directory is refused: both sandboxes let any command write there', () => {
  assert.throws(() => canary.runCanary(base(path.join(os.tmpdir(), 'x'), fakeRun())), /temp/);
});
