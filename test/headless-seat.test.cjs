'use strict';
// A headless Claude seat runs one `claude -p` turn for one stream, outside the app's terminals:
//  - its launch line carries -p, the generated --settings file, JSON output, an empty --setting-sources (no user,
//    project or local settings), a permission mode and any model or budget asked for;
//  - its environment is an allowlist: only the named variables pass from the parent (no ELECTRON_RUN_AS_NODE or any
//    other app-only variable, whatever the parent holds), plus the seat's own hive values, and always
//    CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME=1 so a resumed run never runs a tool call a hook deferred;
//  - its settings file is written outside the hive, registers the hive gate hook at PreToolUse with
//    "onFailure": "block" (Claude Code blocks the call when the hook cannot run), and confines writes to the scoped
//    seat roots (writeRoots.ts seatWriteRoots) with the sandbox failing closed;
//  - the CLI's JSON result is parsed into exit code, result text, session id and total_cost_usd, and a non-zero
//    exit or unreadable output is reported as such, never as success.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const H = loadTs('src/core/headlessSeat.ts');
const { stageHookRuntime, hookCommandFor } = loadTs('src/core/hookRuntime.ts');
const { claudeRoots } = loadTs('src/core/launchLine.ts');
const { seatWriteRoots } = loadTs('src/core/writeRoots.ts');

const NODE_DIR = path.dirname(process.execPath);

/** An agent's plugin map as the app computes it: one plugin the owner kept for agents, one withheld. */
const PLUGINS = { 'kept-tool@market': true, 'owner-only@market': false };

/** A hive with one agent folder and evidence/, a working folder outside it, a private settings folder and a staged
 *  hook runtime (both outside the hive), and a stub `claude` that records how it was started. */
function floor(t, canned = { stdout: '{}' }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdhs-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hiveRoot = path.join(base, 'hive');
  fs.mkdirSync(path.join(hiveRoot, 'agents', 'ag1'), { recursive: true });
  fs.mkdirSync(path.join(hiveRoot, 'evidence'));
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  const settingsDir = path.join(base, 'app', 'headless-seat-settings');
  const hookRuntime = stageHookRuntime({
    dir: path.join(base, 'app', 'hook-runtime'), hiveRoot, platform: process.platform,
    launcher: { name: 'node-launcher', content: '#!/bin/sh\nexec node "$@"\n', mode: 0o755 },
    shim: { name: 'hive-hook.cjs', content: 'process.exit(0);\n', mode: 0o644 },
  });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'claude');
  fs.copyFileSync(path.join(__dirname, 'headless-claude-stub.cjs'), cli);
  fs.chmodSync(cli, 0o755);
  fs.writeFileSync(path.join(bin, 'canned.json'), JSON.stringify(canned));
  const record = () => JSON.parse(fs.readFileSync(path.join(bin, 'record.json'), 'utf8'));
  const opts = (more = {}) => ({
    prompt: 'Say ok.', hiveRoot, agentId: 'ag1', cwd, settingsDir, hookRuntime, cliPath: cli,
    parentEnv: { HOME: base, PATH: `${NODE_DIR}:/usr/bin:/bin`, USER: 'someone', LANG: 'en_US.UTF-8' },
    enabledPlugins: PLUGINS,
    // The machine's own managed settings are not this test's: point the check at a file that is not there.
    managedSettingsFile: path.join(base, 'managed', 'managed-settings.json'),
    ...more,
  });
  return { base, hiveRoot, cwd, settingsDir, hookRuntime, cli, record, opts };
}

const SUCCESS = {
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 1,
  result: 'ok', session_id: '8c1d2f3a-0000-4000-8000-000000000001', total_cost_usd: 0.0042,
};

// --- launch line ---------------------------------------------------------------------------------------------------

test('Given a model and a budget, when the launch is built, then argv is -p, JSON output, the generated settings, the model, the budget and the prompt last', (t) => {
  const f = floor(t);
  const l = H.buildHeadlessLaunch(f.opts({ model: 'haiku', maxBudgetUsd: 0.05, permissionMode: 'acceptEdits' }));
  assert.equal(l.argv[0], f.cli);
  assert.ok(l.argv.includes('-p'), 'non-interactive print mode');
  const val = (name) => l.argv[l.argv.indexOf(name) + 1];
  assert.equal(val('--output-format'), 'json');
  assert.equal(val('--settings'), l.settingsFile);
  assert.equal(val('--model'), 'haiku');
  assert.equal(val('--max-budget-usd'), '0.05');
  assert.equal(val('--permission-mode'), 'acceptEdits');
  assert.equal(l.argv[l.argv.length - 1], 'Say ok.', 'the prompt is the one positional, last');
  assert.ok(!l.settingsFile.startsWith(f.hiveRoot + path.sep), 'the settings file is never written into the hive');
  assert.ok(l.settingsFile.startsWith(f.settingsDir + path.sep), 'the settings file is in the private settings folder');
});

test('Given no model and no budget, when the launch is built, then neither option appears', (t) => {
  const f = floor(t);
  const l = H.buildHeadlessLaunch(f.opts());
  assert.ok(!l.argv.includes('--model'));
  assert.ok(!l.argv.includes('--max-budget-usd'));
});

test('Given no permission mode, when the launch is built, then dontAsk is passed, so the owner\'s default mode never decides', (t) => {
  const f = floor(t);
  const l = H.buildHeadlessLaunch(f.opts());
  assert.equal(l.argv.filter((a) => a === '--permission-mode').length, 1);
  assert.equal(l.argv[l.argv.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('Given a built launch, then it loads no settings source of the owner\'s: --setting-sources is empty and the only --settings is the generated file', (t) => {
  const f = floor(t);
  const l = H.buildHeadlessLaunch(f.opts({ model: 'haiku', maxBudgetUsd: 0.05, permissionMode: 'acceptEdits' }));
  const at = l.argv.indexOf('--setting-sources');
  assert.notEqual(at, -1);
  assert.equal(l.argv[at + 1], '', 'no user, project or local settings');
  assert.equal(l.argv.filter((a) => a === '--setting-sources').length, 1);
  assert.equal(l.argv.filter((a) => a === '--settings').length, 1);
  assert.equal(l.argv[l.argv.indexOf('--settings') + 1], l.settingsFile);
});

test('Given a prompt that starts with a dash, when the launch is built, then it is refused rather than read as an option', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ prompt: '--dangerously-skip-permissions' })), /prompt/);
});

test('Given a model that starts with a dash, when the launch is built, then it is refused rather than read as an option', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ model: '--dangerously-skip-permissions' })), /model/);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ model: '-p' })), /model/);
});

test('Given a permission mode, when the launch is built, then only manual, acceptEdits, plan and dontAsk are accepted', (t) => {
  const f = floor(t);
  // Claude Code 2.1.332 --help: --permission-mode choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
  for (const mode of ['manual', 'acceptEdits', 'plan', 'dontAsk']) {
    const l = H.buildHeadlessLaunch(f.opts({ permissionMode: mode }));
    assert.equal(l.argv[l.argv.indexOf('--permission-mode') + 1], mode);
  }
  for (const mode of ['default', 'bypassPermissions', 'auto', '--dangerously-skip-permissions', 'AcceptEdits', '']) {
    assert.throws(() => H.buildHeadlessLaunch(f.opts({ permissionMode: mode })), /permission mode/, mode);
  }
});

test('Given a budget that is not a positive number, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ maxBudgetUsd: 0 })), /budget/);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ maxBudgetUsd: Number.NaN })), /budget/);
});

// --- environment ---------------------------------------------------------------------------------------------------

const JUNK = {
  ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require /tmp/evil.js', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_CHILD_SESSION: '1', AWS_SECRET_ACCESS_KEY: 'nope', HIVE_SOCK: '/tmp/parent.sock', AGENT_ID: 'parent',
  DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: '0',
};

test('Given a parent env full of app-only and unrelated variables, when the launch is built, then the env is exactly the allowlisted ones present plus the deferred-resume switch', (t) => {
  const f = floor(t);
  const parentEnv = { ...f.opts().parentEnv, TMPDIR: '/tmp/x/', SHELL: '/bin/zsh', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ...JUNK };
  const l = H.buildHeadlessLaunch(f.opts({ parentEnv }));
  assert.deepEqual(l.env, {
    HOME: f.base, PATH: `${NODE_DIR}:/usr/bin:/bin`, USER: 'someone', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x/', SHELL: '/bin/zsh',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: '1',
  });
});

test('Given a parent on Bedrock or Vertex, when the launch is built, then the backend switches do not pass, since the credentials they need do not either', (t) => {
  const f = floor(t);
  const parentEnv = { ...f.opts().parentEnv, CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CONFIG_DIR: '/cfg' };
  const l = H.buildHeadlessLaunch(f.opts({ parentEnv }));
  assert.equal(l.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(l.env.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(l.env.CLAUDE_CONFIG_DIR, '/cfg', 'the rest of the shared keep-list still passes');
});

test('Given the seat\'s own hive values, when the launch is built, then they are set from the options, not from the parent', (t) => {
  const f = floor(t);
  const l = H.buildHeadlessLaunch(f.opts({ parentEnv: { ...f.opts().parentEnv, ...JUNK }, seatEnv: { AGENT_ID: 'ag1', HIVE_ROOT: f.hiveRoot } }));
  assert.equal(l.env.AGENT_ID, 'ag1');
  assert.equal(l.env.HIVE_ROOT, f.hiveRoot);
  assert.equal(l.env.HIVE_SOCK, undefined, 'the parent\'s socket does not leak in');
  assert.equal(l.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('Given a seat value outside the seat allowlist (ELECTRON_RUN_AS_NODE), when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ seatEnv: { ELECTRON_RUN_AS_NODE: '1' } })), /ELECTRON_RUN_AS_NODE/);
});

test('Given a parent env with ELECTRON_RUN_AS_NODE, when the seat runs, then the CLI process receives exactly the built env', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS) });
  const parentEnv = { ...f.opts().parentEnv, ...JUNK };
  const r = await H.runHeadlessSeat(f.opts({ parentEnv, model: 'haiku' }));
  const rec = f.record();
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts, whatever environment the parent passed.
  if (process.platform === 'darwin') delete rec.env.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(rec.env, { HOME: f.base, PATH: `${NODE_DIR}:/usr/bin:/bin`, USER: 'someone', LANG: 'en_US.UTF-8', CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: '1' });
  assert.equal(rec.cwd, f.cwd, 'it runs in the seat\'s working folder');
  assert.deepEqual(rec.argv, r.argv.slice(1));
});

// --- settings ------------------------------------------------------------------------------------------------------

test('Given a staged hook runtime, when the seat runs, then the settings file it receives registers the gate hook at PreToolUse with onFailure block', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS) });
  await H.runHeadlessSeat(f.opts());
  const s = JSON.parse(f.record().settings);
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: hookCommandFor(f.hookRuntime, true), onFailure: 'block' }] }]);
});

test('Given a scoped seat, when the seat runs, then the settings confine writes to the seat roots and the sandbox fails closed', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS) });
  await H.runHeadlessSeat(f.opts());
  const json = f.record().settings;
  const want = seatWriteRoots({ root: f.hiveRoot, agentId: 'ag1', isGod: false, cwd: f.cwd });
  assert.deepEqual(want, [path.join(f.hiveRoot, 'agents', 'ag1'), path.join(f.hiveRoot, 'evidence'), f.cwd]);
  const read = claudeRoots(json);
  assert.equal(read.enabled, true);
  assert.deepEqual(read.roots, [...want, ...want], 'sandbox.filesystem.allowWrite and permissions.additionalDirectories');
  const s = JSON.parse(json);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
});

test('Given the agent\'s plugin map, when the seat runs, then the settings carry exactly that enabledPlugins map, a withheld plugin off', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS) });
  await H.runHeadlessSeat(f.opts());
  const s = JSON.parse(f.record().settings);
  assert.deepEqual(s.enabledPlugins, PLUGINS);
  assert.equal(s.enabledPlugins['owner-only@market'], false, 'a plugin not kept for agents is switched off for this session');
});

test('Given no plugin map, when the launch is built, then it is refused rather than load every plugin the owner enabled', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ enabledPlugins: undefined })), /plugin/);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ enabledPlugins: ['kept-tool@market'] })), /plugin/);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ enabledPlugins: { 'kept-tool@market': 'yes' } })), /plugin/);
  assert.equal(fs.existsSync(f.settingsDir) && fs.readdirSync(f.settingsDir).length > 0, false, 'no settings file is written');
});

// The headless session loads no user settings, so the owner's user settings cannot widen it and are not read. Managed
// settings cannot be left out and outrank the generated file: a write root there outside the seat's roots would reach
// the sandbox and the edit tools whatever the generated settings say.
function ownerSettings(f, dir, json) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(json));
}
function managedSettings(f, json) {
  fs.mkdirSync(path.join(f.base, 'managed'), { recursive: true });
  fs.writeFileSync(path.join(f.base, 'managed', 'managed-settings.json'), typeof json === 'string' ? json : JSON.stringify(json));
}
const OTHER = (f) => path.join(f.hiveRoot, 'agents', 'other');

test('Given user settings that would widen the seat, when the launch is built, then they are not read and the session does not load them', (t) => {
  const f = floor(t);
  fs.mkdirSync(OTHER(f));
  const widen = { sandbox: { enabled: false, filesystem: { disabled: true, allowWrite: [OTHER(f)] }, excludedCommands: ['cp *'] }, permissions: { defaultMode: 'bypassPermissions', allow: ['Bash', `Write(/${OTHER(f)}/**)`] } };
  const cfg = path.join(f.base, 'cfg');
  ownerSettings(f, cfg, widen);
  ownerSettings(f, path.join(f.base, '.claude'), widen);
  const l = H.buildHeadlessLaunch(f.opts({ parentEnv: { ...f.opts().parentEnv, CLAUDE_CONFIG_DIR: cfg } }));
  assert.equal(l.argv[l.argv.indexOf('--setting-sources') + 1], '');
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{ not json');
  assert.doesNotThrow(() => H.buildHeadlessLaunch(f.opts({ parentEnv: { ...f.opts().parentEnv, CLAUDE_CONFIG_DIR: cfg } })), 'an unreadable user file is not read either');
});

test('Given managed settings that add a root outside the seat, when the launch is built, then it is refused naming the managed source and root, and nothing is written', (t) => {
  for (const json of [
    (f) => ({ sandbox: { filesystem: { allowWrite: [OTHER(f)] } } }),
    (f) => ({ permissions: { additionalDirectories: [OTHER(f)] } }),
    (f) => ({ permissions: { allow: [`Edit(/${OTHER(f)}/**)`] } }),
  ]) {
    const f = floor(t);
    fs.mkdirSync(OTHER(f));
    managedSettings(f, json(f));
    assert.throws(() => H.buildHeadlessLaunch(f.opts()), (e) => e.name === 'HeadlessSeatRefused' && /managed settings/.test(e.message) && e.message.includes(OTHER(f)), JSON.stringify(json(f)));
    assert.equal(fs.existsSync(f.settingsDir), false, 'no settings file is written');
  }
});

test('Given managed settings that run a command outside the sandbox, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  managedSettings(f, { sandbox: { excludedCommands: ['cp *'] } });
  assert.throws(() => H.buildHeadlessLaunch(f.opts()), /managed settings: sandbox\.excludedCommands/);
});

test('Given managed settings that switch the sandbox off or allow an unsandboxed retry, when the launch is built, then it is refused', (t) => {
  for (const [sandbox, key] of [[{ enabled: false }, 'managed settings: sandbox.enabled'], [{ allowUnsandboxedCommands: true }, 'managed settings: sandbox.allowUnsandboxedCommands']]) {
    const f = floor(t);
    managedSettings(f, { sandbox });
    assert.throws(() => H.buildHeadlessLaunch(f.opts()), (e) => e.message.includes(key), key);
  }
});

test('Given managed settings that disable the filesystem sandbox, choose bypass as the default mode, or carry a key the check does not know, when the launch is built, then it is refused naming the key', (t) => {
  for (const [json, key] of [
    [{ sandbox: { filesystem: { disabled: true } }, permissions: { allow: ['Bash'] } }, 'sandbox.filesystem.disabled'],
    [{ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash'] } }, 'permissions.defaultMode'],
    [{ sandbox: { network: { allowUnixSockets: ['/var/run/docker.sock'] } } }, 'sandbox.network.allowUnixSockets'],
  ]) {
    const f = floor(t);
    managedSettings(f, json);
    assert.throws(() => H.buildHeadlessLaunch(f.opts()), (e) => e.name === 'HeadlessSeatRefused' && e.message.includes(`managed settings: ${key}`), key);
    assert.equal(fs.existsSync(f.settingsDir), false, 'no settings file is written');
  }
});

test('Given managed settings that cannot be understood, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  managedSettings(f, '{ not json');
  assert.throws(() => H.buildHeadlessLaunch(f.opts()), /managed settings \(could not be understood/);
});

test('Given a Claude user folder that cannot be placed, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ parentEnv: { ...f.opts().parentEnv, CLAUDE_CONFIG_DIR: 'relative/cfg' } })), /CLAUDE_CONFIG_DIR/);
});

test('Given managed settings whose roots are all inside the seat\'s roots, when the launch is built, then it goes ahead', (t) => {
  const f = floor(t);
  managedSettings(f, { sandbox: { filesystem: { allowWrite: [path.join(f.hiveRoot, 'evidence')] } }, permissions: { additionalDirectories: [f.cwd] } });
  const l = H.buildHeadlessLaunch(f.opts());
  assert.ok(fs.existsSync(l.settingsFile));
});

test('Given a working folder inside the private settings folder, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  const inside = path.join(f.settingsDir, 'w');
  fs.mkdirSync(inside, { recursive: true });
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ cwd: inside })), /settings folder/);
});

test('Given a working folder that holds the hook runtime, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  assert.throws(() => H.buildHeadlessLaunch(f.opts({ cwd: path.join(f.base, 'app') })), /hook runtime/);
});

// --- result --------------------------------------------------------------------------------------------------------

test('Given the CLI prints a success result and exits 0, when the seat runs, then the result carries exit code, text, session id and cost', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS) + '\n' });
  const r = await H.runHeadlessSeat(f.opts({ outputFile: '/tmp/brief-output.md' }));
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'ok');
  assert.equal(r.sessionId, SUCCESS.session_id);
  assert.equal(r.totalCostUsd, 0.0042);
  assert.equal(r.subtype, 'success');
  assert.equal(r.outcome, 'success');
  assert.equal(r.error, null);
  assert.equal(r.outputFile, '/tmp/brief-output.md');
  assert.ok(r.settingsFile.startsWith(f.settingsDir));
});

test('Given the CLI stops on its budget and exits 1, when the seat runs, then the run is not ok and the cost it reported is kept', async (t) => {
  const out = { ...SUCCESS, subtype: 'error_max_budget_usd', is_error: true, result: undefined, total_cost_usd: 0.051 };
  const f = floor(t, { stdout: JSON.stringify(out), stderr: 'budget exceeded', exitCode: 1 });
  const r = await H.runHeadlessSeat(f.opts({ maxBudgetUsd: 0.05 }));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.subtype, 'error_max_budget_usd');
  assert.equal(r.outcome, 'budget-stop');
  assert.equal(r.totalCostUsd, 0.051);
  assert.equal(r.stderr, 'budget exceeded');
});

test('Given the CLI prints a success result but exits non-zero, when the seat runs, then the run is not ok and says the exit code', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS), exitCode: 2 });
  const r = await H.runHeadlessSeat(f.opts());
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.error, /code 2/);
  assert.equal(r.totalCostUsd, 0.0042, 'the cost it reported is still read');
});

test('Given the CLI exits 0 with a result that is not an error but is not a success either, when the seat runs, then the run is not ok and names the subtype', async (t) => {
  const out = { ...SUCCESS, subtype: 'error_max_turns', is_error: false };
  const f = floor(t, { stdout: JSON.stringify(out), exitCode: 0 });
  const r = await H.runHeadlessSeat(f.opts());
  assert.equal(r.ok, false);
  assert.equal(r.subtype, 'error_max_turns');
  assert.match(r.error, /error_max_turns/);
});

test('Given the CLI exits 0 with a result object missing its fields, when the seat runs, then the run is not ok and says the result is malformed', async (t) => {
  for (const out of [{ type: 'result' }, { ...SUCCESS, is_error: undefined }, { ...SUCCESS, is_error: 'false' }, { ...SUCCESS, session_id: 7 }, { ...SUCCESS, result: undefined }]) {
    const f = floor(t, { stdout: JSON.stringify(out), exitCode: 0 });
    const r = await H.runHeadlessSeat(f.opts());
    assert.equal(r.ok, false, JSON.stringify(out));
    assert.equal(r.outcome, 'failed');
    assert.match(r.error, /malformed/);
  }
});

test('Given the CLI reports a budget stop without is_error and exits 0, when the seat runs, then the run is not ok and its outcome is a budget stop', async (t) => {
  const out = { ...SUCCESS, subtype: 'error_max_budget_usd', is_error: false, result: undefined, total_cost_usd: 0.051 };
  const f = floor(t, { stdout: JSON.stringify(out), exitCode: 0 });
  const r = await H.runHeadlessSeat(f.opts({ maxBudgetUsd: 0.05 }));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'budget-stop');
  assert.match(r.error, /budget/);
  assert.equal(r.totalCostUsd, 0.051);
});

test('Given a success result followed by output that is not a result, when the seat runs, then the run is not ok', async (t) => {
  const f = floor(t, { stdout: `${JSON.stringify(SUCCESS)}\n{"type":"result"\n`, exitCode: 0 });
  const r = await H.runHeadlessSeat(f.opts());
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed');
});

test('Given the CLI prints something that is not a JSON result, when the seat runs, then the run is not ok and says why', async (t) => {
  const f = floor(t, { stdout: 'Error: something went wrong\n', exitCode: 0 });
  const r = await H.runHeadlessSeat(f.opts());
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 0);
  assert.match(r.error, /result/);
  assert.equal(r.totalCostUsd, null);
  assert.equal(r.stdout, 'Error: something went wrong\n');
});

test('Given a CLI whose stdout passes the output bound and keeps running, when the seat runs, then the CLI is killed and the run fails saying so', { timeout: 10_000 }, async (t) => {
  const f = floor(t, { stdout: 'x'.repeat(5000), hang: true });
  const r = await H.runHeadlessSeat(f.opts({ maxOutputBytes: 1000 }));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null, 'it did not exit by itself');
  assert.equal(r.signal, 'SIGKILL');
  assert.match(r.error, /stdout.*1000 bytes/);
  assert.ok(r.stdout.length <= 1000, 'no more than the bound is kept');
});

test('Given a CLI whose stderr passes the output bound, when the seat runs, then the run fails saying so', { timeout: 10_000 }, async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS), stderr: 'e'.repeat(5000), hang: true });
  const r = await H.runHeadlessSeat(f.opts({ maxOutputBytes: 1000 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /stderr.*1000 bytes/);
});

test('Given an output bound that is not a positive whole number of bytes, when the launch is built, then it is refused', (t) => {
  const f = floor(t);
  for (const n of [0, -1, 1.5, Number.NaN]) assert.throws(() => H.buildHeadlessLaunch(f.opts({ maxOutputBytes: n })), /output bound/, String(n));
});

test('The default output bound is 8 MiB per stream', () => {
  assert.equal(H.HEADLESS_MAX_OUTPUT_BYTES, 8 * 1024 * 1024);
});

test('Given a CLI path that does not exist, when the seat runs, then it resolves not ok with the spawn error', async (t) => {
  const f = floor(t);
  const r = await H.runHeadlessSeat(f.opts({ cliPath: path.join(f.base, 'missing', 'claude') }));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.match(r.error, /ENOENT/);
});

test('Given an injected spawn, when the seat runs, then it is called with the built argv, env and cwd', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS) });
  const calls = [];
  const { spawn } = require('node:child_process');
  const r = await H.runHeadlessSeat(f.opts({ spawn: (file, args, o) => { calls.push({ file, args, o }); return spawn(file, args, o); } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, f.cli);
  assert.deepEqual(calls[0].args, r.argv.slice(1));
  assert.equal(calls[0].o.cwd, f.cwd);
  assert.equal(calls[0].o.env.CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME, '1');
});

test('parseHeadlessOutput: the last JSON result line wins over earlier lines', () => {
  const p = H.parseHeadlessOutput(`warning: x\n${JSON.stringify(SUCCESS)}\n`);
  assert.equal(p.result.session_id, SUCCESS.session_id);
  assert.equal(H.parseHeadlessOutput('[1,2]').result, null);
  assert.equal(H.parseHeadlessOutput(JSON.stringify({ type: 'assistant' })).result, null);
  assert.equal(H.parseHeadlessOutput(`${JSON.stringify(SUCCESS)}\nnot json\n`).result, null, 'the result must be the last line');
});
