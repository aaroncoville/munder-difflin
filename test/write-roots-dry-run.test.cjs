'use strict';
// Scoped write roots, in dry run: what each role would be given, how a path is named in the
// log (a class, never the path), what a tool call would have had refused, the roots a session
// was really given read back from its settings files, and the usage-log allowlist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const W = loadTs('src/main/writeRoots.ts');
const { UsageLog, sanitize } = loadTs('src/main/usageLog.ts');
const { withCodexWritableRoots } = loadTs('src/shared/codexWritableRoots.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

function freshHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-roots-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function jailHome(t, home) {
  const real = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (real === undefined) delete process.env.HOME; else process.env.HOME = real; });
}

function hive(t) {
  const home = freshHome(t);
  const root = path.join(home, 'hive');
  for (const d of ['agents/a1/work/repo', 'agents/a1/.codex', 'agents/a2/outbox', 'evidence', 'bin', 'research']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const ctx = { root, agentId: 'a1', isGod: false, cwd: path.join(root, 'agents/a1/work/repo'), home };
  return { home, root, ctx, god: { ...ctx, agentId: 'g', isGod: true, cwd: root } };
}

const shell = (command, extra = {}) => ({ command, ...extra });

test('scoped roots are role-aware: god keeps the hive root, an agent gets its folder, evidence and an outside worktree', (t) => {
  const { home, root, ctx, god } = hive(t);
  assert.deepEqual(W.scopedRoots(ctx), [path.join(root, 'agents/a1'), path.join(root, 'evidence')], 'a worktree inside the own folder adds nothing');
  const outside = path.join(home, 'wt');
  fs.mkdirSync(outside);
  assert.deepEqual(W.scopedRoots({ ...ctx, cwd: outside }), [path.join(root, 'agents/a1'), path.join(root, 'evidence'), outside]);
  assert.deepEqual(W.scopedRoots(god), [root]);
  assert.deepEqual(W.scopedRoots({ ...ctx, cwd: 'wt' }), [path.join(root, 'agents/a1'), path.join(root, 'evidence')], 'a relative cwd is no cwd');
});

test('property: scoped roots never grant bin, the agents folder, another agent, or anything above the hive', (t) => {
  const { home, root, ctx } = hive(t);
  fs.symlinkSync(path.join(root, 'bin'), path.join(home, 'link-to-bin'));
  fs.symlinkSync(path.join(root, 'agents/a2'), path.join(root, 'agents/a1/link-to-a2'));
  const upper = (p) => p.replace(/\/hive\//, '/HIVE/').replace(/\/bin(\/|$)/, '/BIN$1');
  const cwds = [
    root, path.join(root, 'bin'), path.join(root, 'agents'), path.join(root, 'agents/a2'), path.join(root, 'research'),
    path.join(home, 'link-to-bin'), path.join(root, 'agents/a1/link-to-a2'), home, path.dirname(home), '/',
    path.join(root, 'agents/a1'), path.join(root, 'agents/a1/work/repo'), path.join(home, 'elsewhere'), '',
  ];
  const caseInsensitive = fs.existsSync(upper(path.join(root, 'bin')));
  if (caseInsensitive) cwds.push(upper(path.join(root, 'bin')), upper(path.join(root, 'agents/a2')));
  const ids = ['a1', 'a2', '..', '.', 'a1/../a2', '../..', '', 'agents', 'a1\u0000'];
  const forbidden = [path.join(root, 'bin/cth-hook.cjs'), path.join(root, 'agents/a2/outbox/m.json'), path.join(root, 'tasks.json'), path.join(root, 'registry.json')];
  const rootReal = fs.realpathSync(root);
  let checked = 0;
  for (const cwd of cwds) for (const agentId of ids) {
    const c = { ...ctx, cwd, agentId };
    for (const r of W.scopedRoots(c)) {
      const inHive = r.startsWith(rootReal + path.sep);
      assert.ok(!inHive || r === path.join(rootReal, 'agents', agentId) || r === path.join(rootReal, 'evidence'), `cwd=${cwd} id=${agentId} granted ${r}`);
      assert.ok(r !== rootReal && !rootReal.startsWith(r.endsWith(path.sep) ? r : r + path.sep), `cwd=${cwd} id=${agentId} granted the hive or above: ${r}`);
    }
    for (const f of forbidden) {
      const own = agentId === 'a2' && f.includes('/agents/a2/');
      if (!own) assert.equal(W.wouldRefuse(f, c), true, `cwd=${cwd} id=${agentId} would allow ${f}`);
      if (caseInsensitive && !own) assert.equal(W.wouldRefuse(upper(f), c), true, `case variant of ${f} slipped through`);
      checked++;
    }
  }
  assert.ok(checked > 400);
  assert.deepEqual(W.scopedRoots({ ...ctx, agentId: '..' }), [], 'an id that is not a folder name gets no roots');
});

test('a path is logged as its class, relative to the agent', (t) => {
  const { home, root, ctx } = hive(t);
  const cases = [
    ['agents/a1/memory.md', 'own folder'], ['agents/a1/settings.json', 'own settings'], ['agents/a1/.codex/config.toml', 'own settings'],
    ['agents/a1/work/repo/src/x.ts', 'worktree'], ['agents/a1/work', 'own folder'], ['agents/a2/outbox/m.json', 'other agent folder'], ['agents', 'agents folder'],
    ['tasks.json', 'tasks.json'], ['board.md', 'board.md'], ['bin/cth-hook.cjs', 'bin'], ['research/r.md', 'research'],
    ['evidence/x/y.md', 'evidence'], ['secret-name.txt', 'hive root (other)'], ['', 'hive root'],
  ];
  for (const [rel, cls] of cases) assert.equal(W.pathClass(path.join(root, rel), ctx), cls, rel);
  assert.equal(W.pathClass(path.join(home, 'elsewhere'), ctx), 'outside hive');
  assert.equal(W.pathClass(home, ctx), 'contains hive');
  assert.equal(W.pathClass('src/x.ts', ctx), 'worktree', 'a relative path is read against the cwd');
  assert.equal(W.pathClass(42, ctx), 'unknown');
  fs.symlinkSync(path.join(root, 'agents/a2'), path.join(root, 'agents/a1/peek'));
  assert.equal(W.pathClass(path.join(root, 'agents/a1/peek/outbox/m.json'), ctx), 'other agent folder');
  assert.equal(W.pathClass(path.join(root, 'agents/a1/x'), { ...ctx, agentId: '..' }), 'other agent folder', 'a bad id owns nothing');
  if (fs.existsSync(path.join(root, 'BIN'))) {
    assert.equal(W.pathClass(path.join(root.replace(/\/hive$/, '/HIVE'), 'BIN/cth-hook.cjs'), ctx), 'bin', 'a case variant is classed by the disk');
  }
});

test('shell: the program a command runs is not a write; redirects and known writers are; other named paths count apart', (t) => {
  const { home, root, ctx } = hive(t);
  const obs = (cmd, extra) => W.observeTool('Bash', shell(cmd, extra), ctx);
  assert.deepEqual(obs(`"${root}/bin/hive-node" "${root}/bin/hive-memory" search x`), [{ via: 'shell-named', pathClass: 'bin', refused: true }], 'only the argument, never the program');
  assert.deepEqual(obs(`${root}/bin/hive-node x.cjs`), []);
  assert.deepEqual(obs('python3 x.py > $HIVE_ROOT/tasks.json'), [{ via: 'shell-write', pathClass: 'tasks.json', refused: true }]);
  assert.deepEqual(obs(`echo x 2>>${root}/log.jsonl`), [{ via: 'shell-write', pathClass: 'log.jsonl', refused: true }]);
  assert.deepEqual(obs(`cp "${root}/research/a.md" "${root}/bin/cth-hook.cjs"`), [{ via: 'shell-named', pathClass: 'research', refused: true }, { via: 'shell-write', pathClass: 'bin', refused: true }]);
  assert.deepEqual(obs(`cd x && sed -i '' s/a/b/ ${root}/board.md`), [{ via: 'shell-write', pathClass: 'board.md', refused: true }]);
  assert.deepEqual(obs(`sudo rm -rf ${root}/agents/a2/outbox`), [{ via: 'shell-write', pathClass: 'other agent folder', refused: true }]);
  assert.deepEqual(obs(`cat ${root}/tasks.json | tee ${root}/registry.json`), [{ via: 'shell-named', pathClass: 'tasks.json', refused: true }, { via: 'shell-write', pathClass: 'registry.json', refused: true }]);
  assert.deepEqual(obs(`dd if=/dev/zero of=${root}/bin/x`), [{ via: 'shell-write', pathClass: 'bin', refused: true }]);
  assert.deepEqual(obs('echo hi > ${AGENT_DIR}/outbox/m.json'), []);
  const rel = path.relative(home, root);
  assert.deepEqual(obs(`touch ~/${rel}/tasks.json`), [{ via: 'shell-write', pathClass: 'tasks.json', refused: true }], '~ is the home');
  assert.deepEqual(obs(`touch "$HOME/${rel}/bin/x"`), [{ via: 'shell-write', pathClass: 'bin', refused: true }], '$HOME is the home');
  assert.deepEqual(obs('curl https://x', { dangerouslyDisableSandbox: true }), [{ via: 'shell-unsandboxed', pathClass: 'unknown', refused: true }]);
  assert.deepEqual(W.observeTool('Bash', { cmd: ['bash', '-lc', `echo > ${root}/tasks.json`] }, ctx), [{ via: 'shell-write', pathClass: 'tasks.json', refused: true }], 'a script given to bash -lc is read as a command');
  assert.deepEqual(obs(`bash -lc "echo x > ${root}/tasks.json && ls ${root}/bin"`), [{ via: 'shell-write', pathClass: 'tasks.json', refused: true }, { via: 'shell-named', pathClass: 'bin', refused: true }]);
  assert.deepEqual(obs(`sh -c 'sh -c "rm ${root}/bin/x"'`), [{ via: 'shell-write', pathClass: 'bin', refused: true }], 'nested scripts');
  assert.deepEqual(obs(`find ${root}/research -name x -delete`), [{ via: 'shell-write', pathClass: 'research', refused: true }]);
  assert.deepEqual(obs(`find ${root}/research -name x`), [{ via: 'shell-named', pathClass: 'research', refused: true }]);
  assert.deepEqual(obs(`ls | xargs -0 rm ${root}/bin/x`), [{ via: 'shell-write', pathClass: 'bin', refused: true }]);
  assert.deepEqual(obs(`env -i rm ${root}/bin/x`), [{ via: 'shell-write', pathClass: 'bin', refused: true }]);
  assert.deepEqual(obs(`cat ${root}/tasks.json ${root}/tasks.json; rm ${root}/tasks.json`), [{ via: 'shell-write', pathClass: 'tasks.json', refused: true }], 'a path named twice is one row, a write if either is');
  assert.deepEqual(W.observeTool('exec_command', { cmd: ['rm', `${root}/bin/x`] }, ctx), [{ via: 'shell-write', pathClass: 'bin', refused: true }]);
  assert.deepEqual(W.observeTool('Bash', { cmd: [1, 2] }, ctx), []);
});

test('edit, MCP and patch tools; writes to the own settings are recorded though allowed', (t) => {
  const { root, ctx } = hive(t);
  assert.deepEqual(W.observeTool('Write', { file_path: path.join(root, 'agents/a2/outbox/m.json') }, ctx), [{ via: 'edit', pathClass: 'other agent folder', refused: true }]);
  assert.deepEqual(W.observeTool('Edit', { file_path: path.join(root, 'agents/a1/memory.md') }, ctx), []);
  assert.deepEqual(W.observeTool('Edit', { file_path: path.join(root, 'agents/a1/settings.json') }, ctx), [{ via: 'edit', pathClass: 'own settings', refused: false }]);
  assert.deepEqual(W.observeTool('NotebookEdit', { notebook_path: path.join(root, 'research/n.ipynb') }, ctx), [{ via: 'edit', pathClass: 'research', refused: true }]);
  assert.deepEqual(W.observeTool('mcp__filesystem__write_file', { path: path.join(root, 'tasks.json') }, ctx), [{ via: 'edit', pathClass: 'tasks.json', refused: true }]);
  assert.deepEqual(W.observeTool('mcp__filesystem__read_file', { path: path.join(root, 'tasks.json') }, ctx), []);
  const patch = '*** Begin Patch\n*** Update File: ../../../../bin/x.cjs\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** Update File: ../../.codex/config.toml\n*** End Patch';
  assert.deepEqual(W.observeTool('apply_patch', { input: patch }, ctx), [{ via: 'patch', pathClass: 'bin', refused: true }, { via: 'patch', pathClass: 'own settings', refused: false }]);
  assert.deepEqual(W.observeTool('Bash', shell(`echo x > ${root}/agents/a1/settings.json`), ctx), [{ via: 'shell-write', pathClass: 'own settings', refused: false }]);
  assert.deepEqual(W.observeTool('Read', null, ctx), []);
});

test('effective Claude roots come from every settings file the CLI merges; off or absent is unsandboxed, unreadable is unknown', async (t) => {
  const home = freshHome(t);
  jailHome(t, home);
  const h = new HiveManager(() => home);
  await h.ensureAgent({ id: 'g1', name: 'G', provider: 'claude', cwd: home, isGod: true });
  await h.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  const root = path.join(home, 'hive');
  const ctxOf = (id, isGod, cwd = home) => ({ root, agentId: id, isGod, cwd, home });
  const dir = path.join(root, 'agents/w1');
  const w = W.effectiveRoots('claude', dir, home, home);
  assert.equal(w.state, 'ok');
  const rw = W.rootsReport(w, ctxOf('w1', false));
  assert.deepEqual(rw.effective.sort(), ['contains hive', 'hive root', 'own folder'], JSON.stringify(rw));
  assert.deepEqual(rw.excess.sort(), ['contains hive', 'hive root']);
  assert.deepEqual(W.rootsReport(W.effectiveRoots('claude', path.join(root, 'agents/g1'), home, home), ctxOf('g1', true)).excess, ['contains hive']);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ permissions: { additionalDirectories: [path.join(root, 'bin')] } }));
  const outside = freshHome(t);
  const ro = W.rootsReport(W.effectiveRoots('claude', dir, outside, home), ctxOf('w1', false, outside));
  assert.deepEqual(ro.excess.sort(), ['bin', 'hive root'], 'a user settings file adds a root');
  const generated = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const shapes = [
    ['no sandbox key', { permissions: { additionalDirectories: [] } }, 'unsandboxed'],
    ['enabled false', { sandbox: { enabled: false, filesystem: { allowWrite: [] } } }, 'unsandboxed'],
    ['enabled absent', { sandbox: { filesystem: { allowWrite: [] } } }, 'unsandboxed'],
    ['JSON null', null, 'unknown'],
    ['enabled a string', { sandbox: { enabled: 'yes' } }, 'unknown'],
    ['allowWrite not a list', { sandbox: { enabled: true, filesystem: { allowWrite: '/' } } }, 'unknown'],
  ];
  for (const [why, body, state] of shapes) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(body));
    const eff = W.effectiveRoots('claude', dir, outside, home);
    assert.equal(eff.state, state, why);
    assert.deepEqual(W.rootsReport(eff, ctxOf('w1', false, outside)), { effective: [state], excess: [state] }, why);
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), generated);
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ sandbox: { enabled: false } }));
  assert.equal(W.effectiveRoots('claude', dir, outside, home).state, 'ok', 'the generated --settings file outranks the user file');
  assert.equal(W.effectiveRoots('claude', path.join(root, 'agents/none'), outside, home).state, 'unknown', 'no generated file');
});

test('effective Codex roots: inherited roots show; full access is unsandboxed; dotted and inline tables are unknown', (t) => {
  const { root, ctx } = hive(t);
  const auto = { args: ['codex', '-a never -s workspace-write'], platform: 'darwin' };
  const write = (toml, launch = auto) => { fs.writeFileSync(path.join(root, 'agents/a1/.codex/config.toml'), toml); return W.effectiveRoots('codex', path.join(root, 'agents/a1'), ctx.cwd, ctx.home, launch); };
  const user = '[sandbox_workspace_write]\nwritable_roots = ["/Users/someone/everything"]\n';
  const eff = write(withCodexWritableRoots(user, [path.join(root, 'agents/a1'), root], () => {}));
  assert.ok(eff.roots.includes('/Users/someone/everything'));
  assert.deepEqual(W.rootsReport(eff, ctx).excess.sort(), ['hive root', 'outside hive']);
  assert.equal(W.codexRoots('sandbox_mode = "danger-full-access"\n').state, 'unsandboxed');
  assert.equal(write('sandbox_workspace_write.writable_roots = ["/"]\n').state, 'unknown');
  assert.equal(write('sandbox_workspace_write = { writable_roots = ["/"] }\n').state, 'unknown');
  assert.equal(write('[sandbox_workspace_write]\nwritable_roots = [1]\n').state, 'unknown');
  assert.deepEqual(W.codexRoots('[sandbox_workspace_write]\nwritable_roots = [\n  "/a",\n  "/b",\n]\n'), { roots: ['/a', '/b'], state: 'ok' });
  fs.rmSync(path.join(root, 'agents/a1/.codex/config.toml'));
  assert.equal(W.effectiveRoots('codex', path.join(root, 'agents/a1'), ctx.cwd, ctx.home, auto).state, 'unknown');
  // Forms that must never read as scoped.
  assert.equal(W.codexRoots("sandbox_mode = 'danger-full-access'\n").state, 'unsandboxed', 'single quotes');
  assert.equal(write("sandbox_mode = 'danger-full-access'\n").state, 'ok', 'the command line mode outranks the config');
  assert.equal(write('[profiles.fast]\nsandbox_mode = "danger-full-access"\n').state, 'unknown', 'a profile');
  assert.equal(write('sandbox_mode = danger\n').state, 'unknown', 'unquoted');
  assert.equal(write('', { args: ['codex', '--dangerously-bypass-approvals-and-sandbox'], platform: 'darwin' }).state, 'unsandboxed', 'command line full access');
  assert.equal(write('', { args: ['codex', '--sandbox=danger-full-access'], platform: 'darwin' }).state, 'unsandboxed');
  assert.equal(write('', { args: ['codex'], platform: 'darwin' }).state, 'unknown', 'no sandbox choice on the command line');
  assert.equal(write('', { args: ['codex', '-c', 'sandbox_mode="read-only"'], platform: 'darwin' }).state, 'unknown', 'a -c override');
  assert.equal(write('', { args: ['codex', '-s', 'banana'], platform: 'darwin' }).state, 'unknown');
  assert.equal(write('', { ...auto, platform: 'win32' }).state, 'unknown', 'a platform with no sandbox');
  assert.equal(write('').state, 'ok');
  fs.writeFileSync(path.join(root, 'agents/a1/settings.json'), JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: [] } } }));
  assert.equal(W.effectiveRoots('claude', path.join(root, 'agents/a1'), ctx.cwd, ctx.home, auto).state, 'ok');
  assert.equal(W.effectiveRoots('gemini', path.join(root, 'agents/a1'), ctx.cwd, ctx.home, auto).state, 'unknown', 'neither Claude nor Codex, even with Claude settings present');
});

test('the usage log takes the dry-run events with fixed lists only: no path, no free-text tool or provider', (t) => {
  const known = { isAgent: (id) => id === 'a1', isCard: () => false };
  const ok = { kind: 'write-would-refuse', agentId: 'a1', tool: 'Bash', via: 'shell-write', pathClass: 'tasks.json' };
  assert.deepEqual(sanitize(ok, known), ok);
  assert.equal(sanitize({ ...ok, pathClass: '/Users/x/hive/tasks.json' }, known), null);
  assert.equal(sanitize({ ...ok, via: 'other' }, known), null);
  assert.equal(sanitize({ ...ok, agentId: 'stranger' }, known), null);
  assert.equal(sanitize({ ...ok, tool: 'the_secret_is_hunter2.and.more' }, known), null, 'a tool outside the list');
  assert.equal(W.toolClass('the_secret_is_hunter2'), 'other');
  assert.equal(W.toolClass('mcp__fs__write_file'), 'mcp');
  assert.equal(W.toolClass('apply_patch'), 'apply_patch');
  const roots = { kind: 'write-roots', agentId: 'a1', provider: 'codex', role: 'agent', source: 'codex-config', effective: ['hive root', 'own folder'], excess: ['hive root'] };
  assert.deepEqual(sanitize(roots, known), roots);
  assert.equal(sanitize({ ...roots, provider: 'my-secret-provider' }, known), null);
  assert.equal(W.providerClass('my-secret-provider'), 'other');
  assert.equal(sanitize({ ...roots, excess: ['/etc'] }, known), null);
  assert.equal(sanitize({ ...roots, excess: 'hive root' }, known), null);
  assert.equal(sanitize({ ...roots, path: '/x' }, known).path, undefined, 'an extra field is dropped');
  assert.equal(sanitize({ kind: 'write-observed', agentId: 'a1', tool: 'Bash', shape: 'cmd-array', count: 3 }, known).count, 3);
  assert.equal(sanitize({ kind: 'write-observed', agentId: 'a1', tool: 'Bash', shape: 'weird', count: 3 }, known), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = new UsageLog({ dir: () => dir, enabled: () => true, isAgent: (id) => id === 'a1' });
  assert.equal(log.record(ok), true);
  assert.match(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), /"pathClass":"tasks.json"/);
});

test('the dry run counts every call, looks an agent up only for calls that can write, and never changes the hook answer', async (t) => {
  const home = freshHome(t);
  jailHome(t, home);
  const h = new HiveManager(() => home);
  await h.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  const root = path.join(home, 'hive');
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const pre = (tool_name, tool_input) => ({ agent_id: 'w1', hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input });
  const fire = (hooks) => hooks.handle(pre('Write', { file_path: path.join(root, 'tasks.json') }));
  const baseline = fire(new HookServer(h, () => null, () => ({ notifications: false }), control, undefined));
  const rows = [];
  let lookups = 0;
  const later = [];
  const settle = () => { while (later.length) later.shift()(); };
  const dry = new W.WriteRootsDryRun({
    agent: (id) => { lookups++; return id === 'w1' ? { ctx: { root, agentId: 'w1', isGod: false, cwd: home, home }, provider: 'claude', agentDir: path.join(root, 'agents/w1'), launch: { platform: 'darwin' } } : null; },
    record: (e) => rows.push(e),
    defer: (fn) => later.push(fn),
  });
  const hooks = new HookServer(h, () => null, () => ({ notifications: false }), control, undefined);
  hooks.setWriteObserver((a, e, p) => dry.onHook(a, e, p));
  assert.deepEqual(fire(hooks), baseline);
  assert.equal(lookups, 0, 'nothing happens on the answer path');
  assert.deepEqual(rows, []);
  settle();
  assert.deepEqual(rows, [{ kind: 'write-would-refuse', agentId: 'w1', tool: 'Write', via: 'edit', pathClass: 'tasks.json' }]);
  hooks.handle(pre('Read', { file_path: path.join(root, 'tasks.json') }));
  hooks.handle(pre('Grep', { pattern: 'x' }));
  hooks.handle(pre('mcp__secret_tool', {}));
  hooks.handle({ agent_id: 'w1', hook_event_name: 'Stop', session_id: 's' });
  settle();
  const observed = rows.filter((r) => r.kind === 'write-observed').map((r) => `${r.tool}/${r.shape}/${r.count}`).sort();
  assert.deepEqual(observed, ['Grep/other/1', 'Read/file-path/1', 'Write/file-path/1', 'mcp/other/1']);
  rows.length = 0;
  hooks.handle({ agent_id: 'w1', hook_event_name: 'Stop', session_id: 's' });
  settle();
  assert.deepEqual(rows, [], 'counts are flushed once');
  hooks.handle({ agent_id: 'w1', hook_event_name: 'SessionStart', session_id: 's' });
  settle();
  assert.equal(rows[0].kind, 'write-roots');
  assert.equal(rows[0].provider, 'claude');
  assert.deepEqual(rows[0].excess.sort(), ['contains hive', 'hive root']);
  hooks.setWriteObserver(() => { throw new Error('boom'); });
  assert.deepEqual(fire(hooks), baseline, 'an observer that throws changes nothing');
  const throwing = new W.WriteRootsDryRun({ agent: () => { throw new Error('x'); }, record: () => {}, defer: (fn) => later.push(fn) });
  assert.doesNotThrow(() => throwing.onHook('w1', 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/x' } }));
  assert.doesNotThrow(settle);
});

// --- round 2: the answer path, budgets, and values an agent can plant ---

function hookFloor(t) {
  const home = freshHome(t);
  jailHome(t, home);
  const root = path.join(home, 'hive');
  for (const d of ['agents/w1', 'agents/w2/outbox', 'bin']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const agent = (id) => (id === 'w1' ? { ctx: { root, agentId: 'w1', isGod: false, cwd: home, home }, provider: 'claude', agentDir: path.join(root, 'agents/w1'), launch: { platform: 'darwin' } } : null);
  return { home, root, agent };
}

/** Commands no larger than a hook frame that cost the most to read. */
function hostileCommands(root) {
  const deep = (i) => `${root}/agents/w2/${'d/'.repeat(40)}missing-${i}`;
  return [
    Array.from({ length: 6000 }, (_, i) => `${root}/bin/f${i}`).join(' ').slice(0, 250_000),
    Array.from({ length: 2000 }, (_, i) => deep(i)).join(' ').slice(0, 250_000),
    `rm ${'x'.repeat(250_000)}`,
    `bash -c "${Array.from({ length: 3000 }, (_, i) => `rm ${root}/bin/x${i}`).join(' && ')}"`.slice(0, 250_000),
    Array.from({ length: 4000 }, () => `${root}/tasks.json`).join(' '),
  ];
}

test('the hook answer does not wait for the dry run: answer time is the same for any command', async (t) => {
  const { root, agent } = hookFloor(t);
  const { HookServer: HS } = loadTs('src/main/hooks.ts');
  const h = new HiveManager(() => path.dirname(root));
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  let slowLookups = 0;
  const dry = new W.WriteRootsDryRun({
    // A lookup that never finishes in time would show up in the answer time if it ran on the answer path.
    agent: (id) => { slowLookups++; const end = Date.now() + 200; while (Date.now() < end) { /* spin */ } return agent(id); },
    record: () => {},
  });
  const hooks = new HS(h, () => null, () => ({ notifications: false }), control, undefined);
  hooks.setWriteObserver((a, e, p) => dry.onHook(a, e, p));
  const times = [];
  for (const command of hostileCommands(root)) {
    const t0 = process.hrtime.bigint();
    hooks.handle({ agent_id: 'w1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command } });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.equal(slowLookups, 0, 'no lookup on the answer path');
  assert.ok(Math.max(...times) < 50, `answer times ${times.map((x) => x.toFixed(1)).join(', ')} ms`);
});

test('each deferred call stays inside its budget, and a call past it records one truncated row', (t) => {
  const { root, agent } = hookFloor(t);
  const ctx = agent('w1').ctx;
  for (const command of hostileCommands(root)) {
    const t0 = Date.now();
    const rows = W.observeTool('Bash', { command }, ctx);
    const ms = Date.now() - t0;
    assert.ok(ms < W.BUDGET_MS + 150, `one call took ${ms} ms`);
    assert.ok(rows.length <= W.MAX_PATHS + 2);
  }
  const many = Array.from({ length: 200 }, (_, i) => `rm ${root}/bin/x${i}`).join('; ');
  const rows = W.observeTool('Bash', { command: many }, ctx);
  assert.equal(rows.filter((r) => r.via === 'truncated').length, 1, 'past the path cap');
  const longCmd = `echo ${'x'.repeat(W.MAX_COMMAND)} > ${root}/tasks.json`;
  assert.deepEqual(W.observeTool('Bash', { command: longCmd }, ctx), [], 'past the length cap a command is not read');
  let clock = 0;
  const slow = W.observeTool('Bash', { command: `rm ${root}/bin/a ${root}/bin/b ${root}/bin/c` }, ctx, 10, () => (clock += 6));
  assert.deepEqual(slow.map((r) => r.via), ['shell-write', 'truncated'], 'past the time budget the rest is dropped');
});

test('the queue is bounded and sheds; made-up ids neither queue work for themselves nor crowd out a real agent', (t) => {
  const { root, agent } = hookFloor(t);
  const later = [];
  const rows = [];
  const dry = new W.WriteRootsDryRun({ agent, known: (id) => id === 'w1', record: (e) => rows.push(e), defer: (fn) => later.push(fn) });
  for (let i = 0; i < 10_000; i++) dry.onHook(`fake-${i}`, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  for (let i = 0; i < 10; i++) dry.onHook('w1', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.equal(later.length, 1, 'one scheduled drain at a time');
  assert.ok(dry.shed.size <= 1, 'made-up ids are not tallied');
  later.shift()();
  assert.equal(later.length, 1, 'one call per turn, then the next is scheduled');
  while (later.length) later.shift()();
  dry.onHook('w1', 'Stop', {});
  while (later.length) later.shift()();
  const observed = rows.filter((r) => r.kind === 'write-observed');
  assert.deepEqual(observed.map((r) => `${r.tool}/${r.shape}/${r.count}`).sort(), ['other/shed/10'], 'the real agent\'s shed calls are counted; nothing for fake ids');
  assert.equal(rows.length, observed.length);
  for (let i = 0; i < 3000; i++) dry.onHook(`fake-${i}`, 'PreToolUse', { tool_name: 'Read', tool_input: {} });
  while (later.length) later.shift()();
  dry.onHook('w1', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } });
  dry.onHook('w1', 'Stop', {});
  while (later.length) later.shift()();
  assert.ok(rows.some((r) => r.kind === 'write-observed' && r.tool === 'Read' && r.count === 1), '3,000 unknown ids do not stop a real count');
  assert.equal(path.basename(root), 'hive');
});

test('generated: a value planted at any read site reads as unknown or refused, never as scoped or own', (t) => {
  const outcomes = [];
  const sites = [
    { name: 'generated Claude settings', provider: 'claude', file: (c) => path.join(c.root, 'agents/a1/settings.json'), optional: false },
    { name: 'project settings', provider: 'claude', file: (c) => path.join(c.cwd, '.claude/settings.json'), optional: true },
    { name: 'project local settings', provider: 'claude', file: (c) => path.join(c.cwd, '.claude/settings.local.json'), optional: true },
    { name: 'user Claude settings', provider: 'claude', file: (c) => path.join(c.home, '.claude/settings.json'), optional: true },
    { name: 'Codex config', provider: 'codex', file: (c) => path.join(c.root, 'agents/a1/.codex/config.toml'), optional: false },
  ];
  const good = { claude: JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: [] } } }), codex: '' };
  const kinds = ['link', 'directory', 'unreadable', 'oversized', 'missing', 'parent is a file'];
  const canChmod = typeof process.getuid === 'function' && process.getuid() !== 0;
  for (const site of sites) for (const kind of kinds) {
    if (kind === 'unreadable' && !canChmod) continue;
    const home = freshHome(t);
    const root = path.join(home, 'hive');
    const cwd = path.join(home, 'wt');
    for (const d of ['agents/a1/.codex', 'agents/a2', 'bin']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const c = { root, cwd, home };
    // Every other source valid, so the planted one decides.
    fs.writeFileSync(path.join(root, 'agents/a1/settings.json'), good.claude);
    fs.writeFileSync(path.join(root, 'agents/a1/.codex/config.toml'), good.codex);
    const f = site.file(c);
    fs.rmSync(f, { force: true, recursive: true });
    const decoy = path.join(home, 'decoy');
    fs.writeFileSync(decoy, site.provider === 'claude' ? good.claude : good.codex);
    if (kind === 'link') fs.symlinkSync(decoy, f);
    if (kind === 'directory') fs.mkdirSync(f);
    if (kind === 'unreadable') { fs.writeFileSync(f, site.provider === 'claude' ? good.claude : good.codex); fs.chmodSync(f, 0); }
    if (kind === 'parent is a file') { const dir = path.dirname(f); fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, 'x'); }
    if (kind === 'oversized') fs.writeFileSync(f, (site.provider === 'claude' ? good.claude : good.codex) + ' '.repeat(W.MAX_SETTINGS + 1));
    const ctx = { root, agentId: 'a1', isGod: false, cwd, home };
    const eff = W.effectiveRoots(site.provider, path.join(root, 'agents/a1'), cwd, home, { args: ['codex', '-s', 'workspace-write'], platform: 'darwin' });
    const report = W.rootsReport(eff, ctx);
    const expectOk = kind === 'missing' && site.optional;
    outcomes.push(`${site.name}/${kind}: ${eff.state}`);
    if (expectOk) assert.equal(eff.state, 'ok', `${site.name}/${kind}`);
    else assert.deepEqual(report, { effective: ['unknown'], excess: ['unknown'] }, `${site.name}/${kind}`);
    if (kind === 'unreadable') fs.chmodSync(f, 0o600);
  }
  // The agent's own folder: a link to another agent, a file, missing, or an id that is not a plain name.
  const home = freshHome(t);
  const root = path.join(home, 'hive');
  for (const d of ['agents/a2/outbox', 'bin']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const plant = {
    link: () => fs.symlinkSync(path.join(root, 'agents/a2'), path.join(root, 'agents/a1')),
    file: () => fs.writeFileSync(path.join(root, 'agents/a1'), 'x'),
    missing: () => {},
    'link to bin': () => fs.symlinkSync(path.join(root, 'bin'), path.join(root, 'agents/a1')),
  };
  for (const [kind, fn] of Object.entries(plant)) {
    fs.rmSync(path.join(root, 'agents/a1'), { force: true, recursive: true });
    fn();
    const ctx = { root, agentId: 'a1', isGod: false, cwd: '', home };
    assert.deepEqual(W.scopedRoots(ctx), [], `own folder ${kind}: no roots`);
    for (const target of ['agents/a2/outbox/m.json', 'agents/a1/outbox/m.json', 'bin/cth-hook.cjs']) {
      const obs = W.observeTool('Write', { file_path: path.join(root, target) }, ctx);
      assert.deepEqual(obs, [{ via: 'edit', pathClass: 'unknown', refused: true }], `own folder ${kind}, ${target}`);
    }
    assert.deepEqual(W.rootsReport({ roots: [path.join(root, 'agents/a1')], state: 'ok', source: 'claude-settings-files' }, ctx), { effective: ['unknown'], excess: ['unknown'] });
  }
  for (const id of ['..', 'a1/../a2', '', '.', 'a2/outbox']) {
    const ctx = { root, agentId: id, isGod: false, cwd: '', home };
    assert.deepEqual(W.scopedRoots(ctx), [], `hostile id ${JSON.stringify(id)}`);
    assert.ok(W.observeTool('Write', { file_path: path.join(root, 'agents/a2/outbox/m.json') }, ctx).every((o) => o.refused && o.pathClass !== 'own folder'));
  }
  // Hook payload fields: wrong types and oversized values record nothing, or one truncated row.
  const ctx = { root, agentId: 'a2', isGod: false, cwd: '', home };
  assert.deepEqual(W.observeTool('Bash', { command: 42 }, ctx), []);
  assert.deepEqual(W.observeTool('Bash', { cmd: { x: 1 } }, ctx), []);
  assert.deepEqual(W.observeTool('Write', { file_path: ['a'] }, ctx), []);
  assert.equal(W.toolClass({}), 'other');
  assert.equal(W.inputShape('x'.repeat(10)), 'other');
  assert.ok(outcomes.length >= 20, outcomes.join('\n'));
});
