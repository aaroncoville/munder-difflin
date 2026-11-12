'use strict';
// Scoped write roots, in dry run: what each role would be given, how a path is named in the
// log (a class, never the path), what a tool call would have had refused, the roots a session
// was really given read back from its generated settings, and the usage-log allowlist.

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

function hive(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-roots-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  for (const d of ['agents/a1/work/repo', 'agents/a2/outbox', 'evidence', 'bin', 'research']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const ctx = { root, agentId: 'a1', isGod: false, cwd: path.join(root, 'agents/a1/work/repo') };
  return { home, root, ctx, god: { ...ctx, agentId: 'g', isGod: true, cwd: root } };
}

test('scoped roots are role-aware: god keeps the hive root, an agent gets its folder, evidence and its worktree', (t) => {
  const { root, ctx, god } = hive(t);
  assert.deepEqual(W.scopedRoots(ctx), [path.join(root, 'agents/a1'), path.join(root, 'evidence'), ctx.cwd]);
  assert.deepEqual(W.scopedRoots(god), [root]);
  assert.deepEqual(W.scopedRoots({ ...ctx, cwd: path.dirname(root) }), [path.join(root, 'agents/a1'), path.join(root, 'evidence')], 'a cwd holding the hive is not a root');
  assert.equal(W.wouldRefuse(path.join(root, 'tasks.json'), { ...ctx, cwd: path.dirname(root) }), true);
});

test('a path is logged as its class, relative to the agent', (t) => {
  const { home, root, ctx } = hive(t);
  const cases = [
    ['agents/a1/memory.md', 'own folder'], ['agents/a1/settings.json', 'own settings'], ['agents/a1/.codex/config.toml', 'own settings'],
    ['agents/a1/work/repo/src/x.ts', 'worktree'], ['agents/a2/outbox/m.json', 'other agent folder'], ['agents', 'agents folder'],
    ['tasks.json', 'tasks.json'], ['board.md', 'board.md'], ['bin/cth-hook.cjs', 'bin'], ['research/r.md', 'research'],
    ['evidence/x/y.md', 'evidence'], ['secret-name.txt', 'hive root (other)'], ['', 'hive root'],
  ];
  for (const [rel, cls] of cases) assert.equal(W.pathClass(path.join(root, rel), ctx), cls, rel);
  assert.equal(W.pathClass(path.join(home, 'elsewhere'), ctx), 'outside hive');
  assert.equal(W.pathClass(home, ctx), 'contains hive');
  assert.equal(W.pathClass(path.join(root, 'agents/a1/work'), ctx), 'own folder', 'beside the worktree, not in it');
  assert.equal(W.pathClass('src/x.ts', ctx), 'worktree', 'a relative path is read against the cwd');
  assert.equal(W.pathClass(42, ctx), 'unknown');
  // A link into another agent's folder is classed by where it lands.
  fs.symlinkSync(path.join(root, 'agents/a2'), path.join(root, 'agents/a1/peek'));
  assert.equal(W.pathClass(path.join(root, 'agents/a1/peek/outbox/m.json'), ctx), 'other agent folder');
});

test('wouldRefuse: only hive paths outside the role\'s roots', (t) => {
  const { home, root, ctx, god } = hive(t);
  assert.equal(W.wouldRefuse(path.join(root, 'tasks.json'), ctx), true);
  assert.equal(W.wouldRefuse(path.join(root, 'agents/a2/outbox/m.json'), ctx), true);
  assert.equal(W.wouldRefuse(path.join(root, 'agents/a1/outbox/m.json'), ctx), false);
  assert.equal(W.wouldRefuse(path.join(root, 'evidence/r.md'), ctx), false);
  assert.equal(W.wouldRefuse(path.join(root, 'tasks.json'), god), false);
  assert.equal(W.wouldRefuse(path.join(home, 'elsewhere'), ctx), false, 'outside the hive the roots do not change');
  assert.equal(W.wouldRefuse(path.join(root, 'agents/a1x/m.json'), ctx), true, 'a sibling whose name starts the same is not inside');
});

test('a tool call yields what scoped roots would refuse, by how it was seen', (t) => {
  const { root, ctx } = hive(t);
  assert.deepEqual(W.observeTool('Write', { file_path: path.join(root, 'agents/a2/outbox/m.json') }, ctx), [{ via: 'edit', pathClass: 'other agent folder' }]);
  assert.deepEqual(W.observeTool('Edit', { file_path: path.join(root, 'agents/a1/memory.md') }, ctx), []);
  assert.deepEqual(W.observeTool('NotebookEdit', { notebook_path: path.join(root, 'research/n.ipynb') }, ctx), [{ via: 'edit', pathClass: 'research' }]);
  assert.deepEqual(W.observeTool('Bash', { command: 'python3 x.py > $HIVE_ROOT/tasks.json' }, ctx), [{ via: 'shell-named', pathClass: 'tasks.json' }]);
  assert.deepEqual(W.observeTool('Bash', { command: `cp a "${root}/bin/cth-hook.cjs"` }, ctx), [{ via: 'shell-named', pathClass: 'bin' }]);
  assert.deepEqual(W.observeTool('Bash', { command: 'echo hi > ${AGENT_DIR}/outbox/m.json' }, ctx), []);
  assert.deepEqual(W.observeTool('Bash', { command: 'curl https://x', dangerouslyDisableSandbox: true }, ctx), [{ via: 'shell-unsandboxed', pathClass: 'unknown' }]);
  const patch = '*** Begin Patch\n*** Update File: ../../../../bin/x.cjs\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** End Patch';
  assert.deepEqual(W.observeTool('apply_patch', { input: patch }, ctx), [{ via: 'patch', pathClass: 'bin' }]);
  assert.deepEqual(W.observeTool('Bash', { cmd: `ls ${root}/agents/a2` }, ctx), [{ via: 'shell-named', pathClass: 'other agent folder' }], 'Codex sends cmd');
  assert.deepEqual(W.observeTool('Read', null, ctx), []);
});

test('effective roots are read back from the Claude settings the app really generated', async (t) => {
  const home = freshHome(t);
  const h = new HiveManager(() => home);
  await h.ensureAgent({ id: 'g1', name: 'G', provider: 'claude', cwd: home, isGod: true });
  await h.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  const root = path.join(home, 'hive');
  const ctxOf = (id, isGod) => ({ root, agentId: id, isGod, cwd: home });
  const w = W.effectiveRoots('claude', path.join(root, 'agents/w1'), home);
  assert.equal(w.readable, true);
  const rw = W.rootsReport(w, ctxOf('w1', false));
  assert.deepEqual(rw.effective.sort(), ['contains hive', 'hive root', 'own folder'], JSON.stringify(rw));
  assert.deepEqual(rw.excess.sort(), ['contains hive', 'hive root'], 'today a worker is given the whole hive, and a cwd holding it grants it again');
  const rg = W.rootsReport(W.effectiveRoots('claude', path.join(root, 'agents/g1'), home), ctxOf('g1', true));
  assert.deepEqual(rg.excess, ['contains hive'], 'god keeps the hive root, but not a cwd above it');
  const outside = freshHome(t);
  const ro = W.rootsReport(W.effectiveRoots('claude', path.join(root, 'agents/w1'), outside), { ...ctxOf('w1', false), cwd: outside });
  assert.deepEqual(ro.excess, ['hive root'], 'a worktree outside the hive is in scope');
});

test('effective Codex roots include the ones inherited from user config, and unreadable settings read as unknown', (t) => {
  const { root, ctx } = hive(t);
  const user = '[sandbox_workspace_write]\nwritable_roots = ["/Users/someone/everything"]\n';
  const toml = withCodexWritableRoots(user, [path.join(root, 'agents/a1'), root], () => {});
  fs.mkdirSync(path.join(root, 'agents/a1/.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents/a1/.codex/config.toml'), toml);
  const eff = W.effectiveRoots('codex', path.join(root, 'agents/a1'), ctx.cwd);
  assert.ok(eff.roots.includes('/Users/someone/everything'), JSON.stringify(eff));
  assert.deepEqual(W.rootsReport(eff, ctx).excess.sort(), ['hive root', 'outside hive']);
  assert.deepEqual(W.codexRoots('[sandbox_workspace_write]\nwritable_roots = [\n  "/a",\n  "/b",\n]\n'), ['/a', '/b']);
  assert.equal(W.codexRoots('[sandbox_workspace_write]\nwritable_roots = [1]\n'), null);
  fs.writeFileSync(path.join(root, 'agents/a1/settings.json'), '{"sandbox":{"filesystem":{"allowWrite":"/"}}}');
  const bad = W.effectiveRoots('claude', path.join(root, 'agents/a1'), ctx.cwd);
  assert.equal(bad.readable, false);
  assert.deepEqual(W.rootsReport(bad, ctx).excess, ['unknown'], 'absent or unreadable never reads as scoped');
  assert.equal(W.effectiveRoots('claude', path.join(root, 'agents/none'), ctx.cwd).readable, false);
});

test('the usage log takes the dry-run events with classes only, never a path', (t) => {
  const known = { isAgent: (id) => id === 'a1', isCard: () => false };
  const ok = { kind: 'write-would-refuse', agentId: 'a1', tool: 'Bash', via: 'shell-named', pathClass: 'tasks.json' };
  assert.deepEqual(sanitize(ok, known), ok);
  assert.equal(sanitize({ ...ok, pathClass: '/Users/x/hive/tasks.json' }, known), null);
  assert.equal(sanitize({ ...ok, via: 'other' }, known), null);
  assert.equal(sanitize({ ...ok, agentId: 'stranger' }, known), null);
  const roots = { kind: 'write-roots', agentId: 'a1', provider: 'codex', role: 'agent', effective: ['hive root', 'own folder'], excess: ['hive root'] };
  assert.deepEqual(sanitize(roots, known), roots);
  assert.equal(sanitize({ ...roots, excess: ['/etc'] }, known), null);
  assert.equal(sanitize({ ...roots, excess: 'hive root' }, known), null);
  assert.equal(sanitize({ ...roots, path: '/x' }, known).path, undefined, 'an extra field is dropped');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = new UsageLog({ dir: () => dir, enabled: () => true, isAgent: (id) => id === 'a1' });
  assert.equal(log.record(ok), true);
  assert.match(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), /"pathClass":"tasks.json"/);
});

test('the hook server hands every hook to the dry run, which never changes the answer', async (t) => {
  const home = freshHome(t);
  const h = new HiveManager(() => home);
  await h.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  const root = path.join(home, 'hive');
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const fire = (hooks) => hooks.handle({ agent_id: 'w1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write', tool_input: { file_path: path.join(root, 'tasks.json') } });
  const bare = new HookServer(h, () => null, () => ({ notifications: false }), control, undefined);
  const baseline = fire(bare);
  const rows = [];
  const dry = new W.WriteRootsDryRun({
    agent: (id) => (id === 'w1' ? { ctx: { root, agentId: 'w1', isGod: false, cwd: home }, provider: 'claude', agentDir: path.join(root, 'agents/w1') } : null),
    record: (e) => rows.push(e),
  });
  const hooks = new HookServer(h, () => null, () => ({ notifications: false }), control, undefined);
  hooks.setWriteObserver((a, e, p) => dry.onHook(a, e, p));
  assert.deepEqual(fire(hooks), baseline);
  assert.deepEqual(rows, [{ kind: 'write-would-refuse', agentId: 'w1', tool: 'Write', via: 'edit', pathClass: 'tasks.json' }]);
  hooks.handle({ agent_id: 'w1', hook_event_name: 'SessionStart', session_id: 's' });
  assert.equal(rows[1].kind, 'write-roots');
  assert.deepEqual(rows[1].excess.sort(), ['contains hive', 'hive root']);
  hooks.setWriteObserver(() => { throw new Error('boom'); });
  assert.deepEqual(fire(hooks), baseline, 'an observer that throws changes nothing');
  const throwing = new W.WriteRootsDryRun({ agent: () => { throw new Error('x'); }, record: () => {} });
  assert.doesNotThrow(() => throwing.onHook('w1', 'PreToolUse', {}));
});
