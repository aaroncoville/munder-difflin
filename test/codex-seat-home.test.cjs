'use strict';
/**
 * A Codex agent's CODEX_HOME must be somewhere no agent's sandbox can write.
 *
 * Every sandboxed agent may write the whole hive folder. When the home lived at
 * `<hive>/agents/<id>/.codex`, any other agent could put a `hooks.json` there,
 * and because agents were launched with --dangerously-bypass-hook-trust, Codex
 * ran it, outside the sandbox, the next time the owner started. Replacing the
 * folder (or the short-home link that stood in for it) with one of its own had
 * the same effect: a real folder there was adopted as the home.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome, removeDir } = require('./codex-test-home.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { codexShortHomePath } = loadTs('src/shared/codexRemote.ts');

const BYPASS = '--dangerously-bypass-hook-trust';

/** A short root standing in for the user's home, so the computed home (under
 *  the home-level short root) lands inside it and fits the socket cap. Not under
 *  /tmp or $TMPDIR: Codex lets every agent write those (codex-test-home.cjs). */
function fixture(t) {
  const root = codexTestBase(t, 'mdsh-');
  jailHome(t, root);
  const hive = new HiveManager(() => root);
  // The app's own hook runtime folder, outside the hive: without one no hook command is written.
  const runtime = fs.realpathSync(fs.mkdtempSync('/tmp/mdsr-'));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  const hiveRoot = hive.root();
  const agentDir = (id) => path.join(hiveRoot, 'agents', id);
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const spawn = (id, extra) => hive.ensureAgent({ id, name: id, provider: 'codex', cwd }, extra ? { extraWritableDirs: extra } : undefined);
  return { root, cwd, hive, hiveRoot, agentDir, spawn };
}

/** Every entry under `dir`, with link targets and file contents, for "untouched" checks. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const generatedCommands = (config) => [...config.matchAll(/^command = (.+)$/gm)].map((m) => m[1]);

test('a Codex agent runs in a home outside the hive, the short home it always had', async (t) => {
  const f = fixture(t);
  const inj = await f.spawn('a1');
  const home = inj.env.CODEX_HOME;
  assert.equal(home, codexShortHomePath(path.join(f.agentDir('a1'), '.codex'), 'a1'));
  const rel = path.relative(f.hiveRoot, fs.realpathSync(home));
  assert.ok(rel.startsWith('..'), `home ${home} is inside the hive`);
  assert.equal(fs.lstatSync(path.join(f.agentDir('a1'), '.codex'), { throwIfNoEntry: false }), undefined,
    'nothing is created in the agent folder for Codex');
});

test('a hooks.json planted in the agent folder by another agent is never part of the home', async (t) => {
  const f = fixture(t);
  const planted = path.join(f.agentDir('victim'), '.codex');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, 'hooks.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"planted"}]}]}}');
  fs.writeFileSync(path.join(planted, 'config.toml'), '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "planted"\n');
  const before = snapshot(planted);

  const home = (await f.spawn('victim')).env.CODEX_HOME;
  assert.notEqual(fs.realpathSync(home), fs.realpathSync(planted));
  assert.equal(fs.existsSync(path.join(home, 'hooks.json')), false);
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /planted/);
  assert.equal(generatedCommands(config).length, 8);
  assert.deepEqual(snapshot(planted), before, 'the agent folder is read, never changed');
});

test('a short-home link swapped for another target changes nothing', async (t) => {
  const f = fixture(t);
  const first = (await f.spawn('z')).env.CODEX_HOME;
  const elsewhere = path.join(f.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'hooks.json'), '{"hooks":{}}');
  const link = path.join(f.agentDir('z'), '.codex');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(elsewhere, link);

  const again = (await f.spawn('z')).env.CODEX_HOME;
  assert.equal(again, codexShortHomePath(link, 'z'));
  assert.equal(again, first);
  assert.equal(fs.existsSync(path.join(elsewhere, 'config.toml')), false, 'nothing is written through the swapped link');
  assert.equal(fs.readlinkSync(link), elsewhere, 'the swapped link is left as it was');
});

test('hooks.state written into the home before a spawn does not survive into the launch', async (t) => {
  const f = fixture(t);
  const home = (await f.spawn('s')).env.CODEX_HOME;
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[hooks.state."planted:session_start:0:0"]\ntrusted_hash = "sha256:' + '0'.repeat(64) + '"\n');
  await f.spawn('s');
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /hooks\.state|planted/);
});

test('Codex is launched without the hook-trust bypass', async (t) => {
  const f = fixture(t);
  const inj = await f.spawn('b');
  assert.equal(inj.args.includes(BYPASS), false, `args: ${inj.args.join(' ')}`);
});

test('a home inside one of the agent\'s writable folders refuses the spawn', async (t) => {
  const f = fixture(t);
  // Roots that contain the short-home base, spelled directly and through a link.
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.root, alias);
  for (const extra of [[f.root], [alias]]) {
    await assert.rejects(f.spawn('o', extra), (e) => e.name === 'CodexHomeRefused' && e.message.includes(extra[0]) && /every Codex agent's home/.test(e.message));
  }
});

const refusedHome = (folder) => (e) => {
  assert.equal(e.name, 'CodexHomeRefused', String(e));
  assert.ok(e.message.includes(folder), `the reason names ${folder}: ${e.message}`);
  return true;
};

test('an agent of any provider that could write the Codex homes is refused, and nothing is created for it', async (t) => {
  const f = fixture(t);
  // Sandboxed providers, by their roots; one the app does not sandbox is covered below.
  for (const provider of ['claude', 'codex']) {
    const id = `h-${provider}`;
    await assert.rejects(f.hive.ensureAgent({ id, name: id, provider, cwd: f.root }), refusedHome(f.root), provider);
    assert.equal(fs.existsSync(f.agentDir(id)), false, `${provider}: no agent folder`);
    assert.equal(Object.hasOwn(f.hive.registry().agents, id), false, `${provider}: no registry row`);
  }
});

test('a later agent whose working folder is a running Codex agent\'s home is the one refused', async (t) => {
  const f = fixture(t);
  const home = (await f.spawn('first')).env.CODEX_HOME;
  const before = snapshot(home);
  for (const provider of ['claude']) {
    await assert.rejects(f.hive.ensureAgent({ id: `later-${provider}`, name: 'l', provider, cwd: home }), refusedHome(home), provider);
  }
  assert.deepEqual(snapshot(home), before, 'the running agent\'s home is left alone');
  assert.equal(f.hive.registry().agents.first.archived, false, 'and so is its registry row');
});

test('an agent rooted at $HOME or the homes folder is refused, whichever starts first', async (t) => {
  // A seat that could write a victim's home could plant a hooks.json there and trust it through
  // Codex's model-free app server; the victim's next start would run it outside any sandbox.
  const f = fixture(t);
  const mdc = path.join(f.root, '.mdc');
  // The attacker first: refused; the victim then starts as usual.
  await assert.rejects(f.hive.ensureAgent({ id: 'att0', name: 'a', provider: 'claude', cwd: mdc }), refusedHome(mdc));
  const victim = (await f.spawn('victim')).env.CODEX_HOME;
  assert.equal(path.dirname(victim), mdc);
  // The victim first: every later seat that reaches its home is refused.
  for (const [provider, root] of [['claude', f.root], ['claude', mdc], ['codex', mdc], ['claude', victim]]) {
    await assert.rejects(f.hive.ensureAgent({ id: `att-${provider}`, name: 'a', provider, cwd: f.cwd }, { extraWritableDirs: [root] }), refusedHome(root), `${provider} given ${root}`);
    await assert.rejects(f.hive.ensureAgent({ id: `att2-${provider}`, name: 'a', provider, cwd: root }), refusedHome(root), `${provider} rooted at ${root}`);
  }
});

test('a Codex home under a temp folder Codex lets every agent write is refused', async (t) => {
  // HOME under /tmp: workspace-write grants /tmp to every Codex agent.
  const tmpRoot = fs.realpathSync(fs.mkdtempSync('/tmp/mdtt-'));
  t.after(async () => { await removeDir(tmpRoot); });
  jailHome(t, tmpRoot);
  const cwd = path.join(tmpRoot, 'work');
  fs.mkdirSync(cwd);
  const hive = new HiveManager(() => tmpRoot);
  await assert.rejects(hive.ensureAgent({ id: 'tmp1', name: 't', provider: 'codex', cwd }), refusedHome('/tmp'));

  // HOME under $TMPDIR: workspace-write grants it too.
  const f = fixture(t);
  const realTmp = process.env.TMPDIR;
  process.env.TMPDIR = path.dirname(f.root);
  t.after(() => { if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp; });
  await assert.rejects(f.spawn('tmp2'), refusedHome(path.dirname(f.root)));
});

test('write roots from the owner\'s Codex config and from a project config are checked against the homes', async (t) => {
  const f = fixture(t);
  const user = path.join(f.root, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(user), { recursive: true });
  fs.writeFileSync(user, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(path.join(f.root, '.mdc'))}]\n`);
  await assert.rejects(f.spawn('u1'), (e) => refusedHome(path.join(f.root, '.mdc'))(e) && e.message.includes(user));
  fs.rmSync(user);
  fs.mkdirSync(path.join(f.cwd, '.codex'));
  const project = path.join(f.cwd, '.codex', 'config.toml');
  fs.writeFileSync(project, `[sandbox_workspace_write]\nwritable_roots = ["~"]\n`);
  await assert.rejects(f.spawn('p1'), (e) => refusedHome(f.root)(e) && e.message.includes(project));
});

test('a computed home that is a link or not a folder refuses the start, naming it, and nothing is written through it', async (t) => {
  const f = fixture(t);
  const homeOf = (id) => codexShortHomePath(path.join(f.agentDir(id), '.codex'), id);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const cases = [
    ['a link to a folder', (h) => fs.symlinkSync(outside, h)],
    ['a dangling link', (h) => fs.symlinkSync(path.join(f.root, 'gone'), h)],
    ['a file', (h) => fs.writeFileSync(h, 'x')],
  ];
  for (const [label, make] of cases) {
    const id = `l-${cases.findIndex((c) => c[0] === label)}`;
    const home = homeOf(id);
    fs.mkdirSync(path.dirname(home), { recursive: true });
    make(home);
    await assert.rejects(f.spawn(id), (e) => e.name === 'CodexHomeRefused' && e.message.includes(home), label);
    assert.deepEqual(fs.readdirSync(outside), [], `${label}: nothing written through it`);
    assert.equal(fs.existsSync(path.join(f.root, 'gone')), false, `${label}: no folder made at the link's target`);
  }
});

test('a home whose rollout folders cannot be linked refuses the start instead of starting without them', async (t) => {
  const f = fixture(t);
  const home = (await f.spawn('lk')).env.CODEX_HOME;
  // The home's sessions folder holds data and so does its target under ~/.codex: neither can win.
  const target = fs.realpathSync(path.join(home, 'sessions'));
  fs.rmSync(path.join(home, 'sessions'));
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'a.jsonl'), '{}\n');
  fs.writeFileSync(path.join(target, 'b.jsonl'), '{}\n');
  await assert.rejects(f.spawn('lk'), (e) => /could not be written|could not be prepared/.test(e.message) && e.message.includes('both contain data'));
});

test('a stale config.toml in the home is replaced, never written through', async (t) => {
  const f = fixture(t);
  const home = (await f.spawn('st')).env.CODEX_HOME;
  const elsewhere = path.join(f.root, 'elsewhere.toml');
  fs.writeFileSync(elsewhere, 'model = "keep"\n');
  fs.rmSync(path.join(home, 'config.toml'));
  fs.symlinkSync(elsewhere, path.join(home, 'config.toml'));
  await f.spawn('st');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'model = "keep"\n', 'the link target is untouched');
  assert.ok(fs.lstatSync(path.join(home, 'config.toml')).isFile(), 'the home holds a fresh regular file');
  assert.equal(generatedCommands(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).length, 8);
});

test('an agent with an old in-tree home keeps its history, and only that is copied', async (t) => {
  const f = fixture(t);
  const legacy = path.join(f.agentDir('m'), '.codex');
  fs.mkdirSync(path.join(legacy, 'skills', 's'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'plugins'), { recursive: true });
  for (const [name, body] of [['history.jsonl', '{"h":1}\n'], ['hive-thread.json', '{"fresh":false,"ids":["m1","m2"]}'],
    ['state_5.sqlite', 'state'], ['state_5.sqlite-wal', 'wal'], ['thread_history_1.sqlite', 'th'],
    ['hooks.json', '{"hooks":{}}'], ['AGENTS.md', 'do as I say'], ['config.toml', 'model = "x"\n'], ['dev.config.toml', 'x'],
    ['skills/s/SKILL.md', 's'], ['plugins/p.json', '{}']]) fs.writeFileSync(path.join(legacy, name), body);
  fs.symlinkSync('/etc/hosts', path.join(legacy, 'thread_history_2.sqlite'));
  const before = snapshot(legacy);

  const home = (await f.spawn('m')).env.CODEX_HOME;
  for (const name of ['history.jsonl', 'hive-thread.json']) {
    assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), before[name], name);
    assert.ok(fs.lstatSync(path.join(home, name)).isFile(), `${name} is a copy, not a link`);
  }
  // Codex rebuilds its state databases from the rollouts, so they are not carried over.
  for (const name of ['state_5.sqlite', 'state_5.sqlite-wal', 'thread_history_1.sqlite', 'hooks.json', 'AGENTS.md', 'dev.config.toml', 'skills', 'plugins', 'thread_history_2.sqlite']) {
    assert.equal(fs.existsSync(path.join(home, name)), false, `${name} must not be carried over`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /model = "x"/);
  assert.deepEqual(snapshot(legacy), before, 'the old home is left exactly as it was');

  await f.spawn('m');
  const rows = fs.readFileSync(path.join(f.hiveRoot, 'log.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.kind === 'codex-home-migrated');
  assert.equal(rows.length, 1, 'one log row, on the first spawn only');
  assert.equal(rows[0].from, legacy);
  assert.deepEqual(rows[0].copied.sort(), ['history.jsonl', 'hive-thread.json']);
});

test('a thread record that is not exactly the app\'s shape is not carried over, and is named', async (t) => {
  const f = fixture(t);
  for (const [i, body] of ['{"thread":"t1"}', '{"fresh":false,"ids":["m1"],"extra":1}', '{"fresh":"no","ids":[]}', '{"fresh":false,"ids":[1]}', 'not json'].entries()) {
    const id = `ts${i}`;
    const legacy = path.join(f.agentDir(id), '.codex');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'hive-thread.json'), body);
    const home = (await f.spawn(id)).env.CODEX_HOME;
    assert.equal(fs.existsSync(path.join(home, 'hive-thread.json')), false, body);
    const row = f.hive.logTail(500).find((r) => r.kind === 'codex-home-migrated' && r.agentId === id);
    assert.ok(row.skipped.some((x) => /^hive-thread\.json \(not a thread record/.test(x)), JSON.stringify(row.skipped));
  }
});

test('an interrupted migration leaves no partial file, writes no marker, and the next start finishes it', (t) => {
  const { migrateSeatHome } = loadTs('src/main/codexSeatHome.ts');
  const root = codexTestBase(t, 'mdsi-');
  const agent = path.join(root, 'agent');
  const legacy = path.join(agent, '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'hive-thread.json'), '{"fresh":true,"ids":[]}');
  fs.writeFileSync(path.join(legacy, 'history.jsonl'), 'h\n');
  const home = path.join(root, 'home');
  // A temp file a crash left behind, and a source that cannot be read this time.
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.migrating-history.jsonl.123.abc'), 'partial');
  fs.chmodSync(path.join(legacy, 'history.jsonl'), 0o000);
  t.after(() => { try { fs.chmodSync(path.join(legacy, 'history.jsonl'), 0o600); } catch { /* gone */ } });
  assert.throws(() => migrateSeatHome(agent, home));
  assert.equal(fs.existsSync(path.join(home, 'history.jsonl')), false, 'no partial copy in place');
  assert.equal(fs.readdirSync(home).some((n) => n.startsWith('.migrated')), false, 'no marker');
  fs.chmodSync(path.join(legacy, 'history.jsonl'), 0o600);
  const res = migrateSeatHome(agent, home);
  assert.ok(res.copied.includes('history.jsonl'));
  assert.equal(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8'), 'h\n');
  assert.equal(fs.readFileSync(path.join(home, 'hive-thread.json'), 'utf8'), '{"fresh":true,"ids":[]}');
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.migrating')), [], 'the leftover temp file is gone');
  assert.equal(migrateSeatHome(agent, home), null, 'finished: a later start does nothing');
});

test('migration caps each file and never follows a link', (t) => {
  const { migrateSeatHome } = loadTs('src/main/codexSeatHome.ts');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/mdsm-'));
  t.after(async () => removeDir(root));
  const agent = path.join(root, 'agent');
  fs.mkdirSync(path.join(agent, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(agent, '.codex', 'history.jsonl'), 'x'.repeat(64));
  fs.writeFileSync(path.join(agent, '.codex', 'hive-thread.json'), '{"fresh":true,"ids":[]}');
  const home = path.join(root, 'home');
  const res = migrateSeatHome(agent, home, 32);
  assert.deepEqual(res.copied, ['hive-thread.json']);
  assert.match(res.skipped.join(), /history\.jsonl \(larger than 32 bytes\)/);
  assert.equal(fs.existsSync(path.join(home, 'history.jsonl')), false);
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.migrating')), [], 'nothing partial is left');

  // An in-tree home that is itself a link is not read at all.
  const agent2 = path.join(root, 'agent2');
  fs.mkdirSync(agent2);
  fs.symlinkSync(path.join(agent, '.codex'), path.join(agent2, '.codex'));
  assert.equal(migrateSeatHome(agent2, path.join(root, 'home2')), null);
});

test('after migration a resumed agent still finds its rollouts', async (t) => {
  const f = fixture(t);
  // Older homes already kept their rollouts under the user's Codex scan root,
  // linked from the in-tree home; the new home links to the same place.
  const hiveId = crypto.createHash('sha1').update(f.hiveRoot).digest('hex').slice(0, 12);
  const target = path.join(f.root, '.codex', 'sessions', 'munder-difflin', hiveId, 'r');
  fs.mkdirSync(path.join(target, '2026', '11', '12'), { recursive: true });
  const rollout = path.join(target, '2026', '11', '12', 'rollout-x.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const legacy = path.join(f.agentDir('r'), '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  fs.symlinkSync(target, path.join(legacy, 'sessions'));
  fs.writeFileSync(path.join(legacy, 'state_5.sqlite'), 'index');
  fs.writeFileSync(path.join(legacy, 'hive-thread.json'), '{"fresh":false,"ids":["m1"]}');

  const home = (await f.spawn('r')).env.CODEX_HOME;
  assert.equal(fs.realpathSync(path.join(home, 'sessions')), fs.realpathSync(target));
  assert.ok(fs.existsSync(path.join(home, 'sessions', '2026', '11', '12', 'rollout-x.jsonl')));
  // Not needed: Codex rebuilds its index from the rollouts on the next start.
  assert.equal(fs.existsSync(path.join(home, 'state_5.sqlite')), false);
  assert.equal(fs.readFileSync(path.join(home, 'hive-thread.json'), 'utf8'), '{"fresh":false,"ids":["m1"]}');
});

// The installed Codex CLI, model-free: only `app-server` hooks/list and config writes.
let codex = null;
try { codex = execFileSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim() || null; } catch { /* not installed */ }

test('with the real CLI: generated hooks get trusted, a planted project hook refuses the start', { skip: !codex && 'codex CLI not installed', timeout: 30_000 }, async (t) => {
  const { seedCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
  const f = fixture(t);
  // Another agent's plant at the old home location: no effect on trust.
  fs.mkdirSync(path.join(f.agentDir('c'), '.codex'), { recursive: true });
  fs.writeFileSync(path.join(f.agentDir('c'), '.codex', 'hooks.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"planted"}]}]}}');
  const inj = await f.spawn('c');
  const ctx = { home: inj.env.CODEX_HOME, cwd: f.cwd, executable: codex, env: { ...process.env, ...inj.env }, written: f.hive.codexConfigWritten(inj.env.CODEX_HOME) };
  assert.equal(await seedCodexHookTrust(ctx, 15_000), true);

  // A hook in the (trusted) working folder's project layer: never trusted by us,
  // so nothing starts, and the reason names it.
  fs.mkdirSync(path.join(f.cwd, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.codex', 'hooks.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"planted"}]}]}}');
  let why = '';
  assert.equal(await seedCodexHookTrust(ctx, 15_000, (r) => { why = r; }), false);
  assert.match(why, /did not write.*\.codex\/hooks\.json/);

  // Trust recorded for that hook's exact hash in the project layer's own
  // config.toml grants nothing: only the home's trust counts.
  const project = (await listHooks(ctx)).find((h) => h.source === 'project');
  assert.ok(project, 'Codex lists the planted project hook');
  fs.writeFileSync(path.join(f.cwd, '.codex', 'config.toml'),
    `[hooks.state.${JSON.stringify(project.key)}]\ntrusted_hash = ${JSON.stringify(project.currentHash)}\n`);
  const again = (await listHooks(ctx)).find((h) => h.key === project.key);
  assert.equal(again.trustStatus, 'untrusted');
  assert.equal(await seedCodexHookTrust(ctx, 15_000), false);
});

test('with the real CLI: a planted hook whose hash is already trusted in the home still refuses the start', { skip: !codex && 'codex CLI not installed', timeout: 30_000 }, async (t) => {
  const { seedCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
  const f = fixture(t);
  const inj = await f.spawn('pre');
  const ctx = { home: inj.env.CODEX_HOME, cwd: f.cwd, executable: codex, env: { ...process.env, ...inj.env }, written: f.hive.codexConfigWritten(inj.env.CODEX_HOME) };
  fs.mkdirSync(path.join(f.cwd, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.codex', 'hooks.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"planted"}]}]}}');
  const planted = (await listHooks(ctx)).find((h) => h.source === 'project');
  assert.ok(planted, 'Codex lists the planted project hook');
  // Its exact hash recorded as trusted in the agent's own home.
  fs.appendFileSync(path.join(fs.realpathSync(ctx.home), 'config.toml'), `\n[hooks.state.${JSON.stringify(planted.key)}]\ntrusted_hash = ${JSON.stringify(planted.currentHash)}\n`);
  assert.equal((await listHooks(ctx)).find((h) => h.key === planted.key).trustStatus, 'trusted', 'Codex now reports it trusted');
  let why = '';
  assert.equal(await seedCodexHookTrust(ctx, 15_000, (r) => { why = r; }), false);
  assert.match(why, /did not write.*\.codex\/hooks\.json/);
});

test('with the real CLI: generated commands replaced in the home after it was written are not trusted', { skip: !codex && 'codex CLI not installed', timeout: 30_000 }, async (t) => {
  const { seedCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
  const f = fixture(t);
  const inj = await f.spawn('swap');
  const ctx = { home: inj.env.CODEX_HOME, cwd: f.cwd, executable: codex, env: { ...process.env, ...inj.env }, written: f.hive.codexConfigWritten(inj.env.CODEX_HOME) };
  const cfg = path.join(fs.realpathSync(ctx.home), 'config.toml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^command = .+$/gm, `command = ${JSON.stringify('/bin/sh -c "printf owned"')}`));
  let why = '';
  assert.equal(await seedCodexHookTrust(ctx, 15_000, (r) => { why = r; }), false);
  assert.match(why, /generated hook|did not write/);
  assert.doesNotMatch(fs.readFileSync(cfg, 'utf8'), /trusted_hash/, 'no trust was recorded');
});

test('with the real CLI: the owner\'s own trusted hooks are allowed, an untrusted one refuses', { skip: !codex && 'codex CLI not installed', timeout: 60_000 }, async (t) => {
  const { seedCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
  const f = fixture(t);
  const ownerHome = path.join(f.root, '.codex');
  fs.mkdirSync(ownerHome, { recursive: true });
  const ownerCfg = path.join(ownerHome, 'config.toml');
  fs.writeFileSync(ownerCfg, '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo owner"\n');
  const spawnAndSeed = async (id) => {
    const inj = await f.spawn(id);
    const ctx = { home: inj.env.CODEX_HOME, cwd: f.cwd, executable: codex, env: { ...process.env, ...inj.env }, written: f.hive.codexConfigWritten(inj.env.CODEX_HOME) };
    let why = '';
    const ok = await seedCodexHookTrust(ctx, 15_000, (r) => { why = r; });
    return { ok, why, ctx };
  };
  const untrusted = await spawnAndSeed('o1');
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.why, /not trusted in .*\.codex\/config\.toml: stop/);

  // The owner trusts it in their own Codex (as the review menu would record it).
  const own = (await listHooks({ home: ownerHome, cwd: f.cwd, executable: codex, env: process.env })).find((h) => h.command === 'echo owner');
  assert.ok(own, 'Codex lists the owner hook in the owner\'s own home');
  fs.appendFileSync(ownerCfg, `\n[hooks.state.${JSON.stringify(own.key)}]\ntrusted_hash = ${JSON.stringify(own.currentHash)}\n`);
  const trusted = await spawnAndSeed('o2');
  assert.equal(trusted.ok, true, trusted.why);
  const listed = await listHooks(trusted.ctx);
  assert.equal(listed.find((h) => h.command === 'echo owner').trustStatus, 'trusted');
  assert.ok(listed.every((h) => h.trustStatus === 'trusted'), 'every listed hook is trusted');
});

/** `codex app-server` → initialize → hooks/list, nothing else. */
function listHooks({ home, cwd, executable, env }) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server'], { env: { ...env, CODEX_HOME: home }, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const timer = setTimeout(() => { child.kill(); reject(new Error('hooks/list timed out')); }, 15_000);
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) send(2, 'hooks/list', { cwds: [cwd] });
        if (m.id === 2) { clearTimeout(timer); child.kill(); resolve(m.result?.data?.[0]?.hooks ?? []); }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: { experimentalApi: true } });
  });
}

test('the write-roots dry run reads the computed home as the config the app generated', async (t) => {
  const W = loadTs('src/main/writeRoots.ts');
  const f = fixture(t);
  const inj = await f.spawn('dr');
  const home = inj.env.CODEX_HOME;
  assert.ok(home.startsWith(path.join(f.root, '.mdc') + path.sep), home);
  // What the spawn core records: the app set this CODEX_HOME (index.ts codexHomeFromApp).
  const rec = { args: ['codex -a never -s workspace-write'], env: { HOME: f.root, CODEX_HOME: home }, codexHomeFromApp: true };
  const read = (r) => W.effectiveRoots('codex', f.agentDir('dr'), f.cwd, f.root, W.spawnLaunchFacts(r, 'darwin', f.hive.codexAppHooks()));
  const ok = read(rec);
  assert.equal(ok.state, 'ok', JSON.stringify(ok));
  // Read as generated, a hook the app did not write is caught; read as the owner's own config it would pass unread.
  const cfg = path.join(home, 'config.toml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^(command = ".*)"$/m, '$1 planted"'));
  assert.deepEqual([read(rec).state, read(rec).why], ['unknown', 'app-hooks-differ']);
  // Without the spawn record it is not generated, and a home that is not the owner's ~/.codex is not modelled.
  const unset = read({ ...rec, codexHomeFromApp: false });
  assert.deepEqual([unset.state, unset.source], ['unknown', 'codex-config'], 'only the spawn record makes it generated');
});

test('a source that changes while it is copied leaves no marker, and the next start copies it', (t) => {
  const { migrateSeatHome } = loadTs('src/main/codexSeatHome.ts');
  const root = codexTestBase(t, 'mdsc-');
  const agent = path.join(root, 'agent');
  const legacy = path.join(agent, '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  const src = path.join(legacy, 'history.jsonl');
  fs.writeFileSync(src, 'one\n');
  const home = path.join(root, 'home');
  // Another agent appends to the source right after the copy measured it.
  const realFstat = fs.fstatSync;
  let grown = false;
  fs.fstatSync = function (fd, ...rest) {
    const st = realFstat.call(fs, fd, ...rest);
    if (!grown && st.isFile() && Number(st.size) === 4) { grown = true; fs.appendFileSync(src, 'two\n'); }
    return st;
  };
  try { migrateSeatHome(agent, home); } finally { fs.fstatSync = realFstat; }
  assert.equal(grown, true, 'the probe ran');
  assert.equal(fs.existsSync(path.join(home, 'history.jsonl')), false, 'no partial copy');
  assert.equal(fs.readdirSync(home).some((n) => n.startsWith('.migrated')), false, 'no marker: the migration is not finished');
  const again = migrateSeatHome(agent, home);
  assert.ok(again && again.copied.includes('history.jsonl'), JSON.stringify(again));
  assert.equal(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8'), 'one\ntwo\n');
});

test('history over a sane size is a named skip, and the migration still finishes', (t) => {
  const { migrateSeatHome, MIGRATE_HISTORY_MAX_BYTES } = loadTs('src/main/codexSeatHome.ts');
  assert.ok(MIGRATE_HISTORY_MAX_BYTES <= 64 * 1024 * 1024, `history cap ${MIGRATE_HISTORY_MAX_BYTES}`);
  const root = codexTestBase(t, 'mdsb-');
  const agent = path.join(root, 'agent');
  const legacy = path.join(agent, '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  // Sparse: the size is what counts, and an over-cap file is never read.
  fs.closeSync(fs.openSync(path.join(legacy, 'history.jsonl'), 'w'));
  fs.truncateSync(path.join(legacy, 'history.jsonl'), MIGRATE_HISTORY_MAX_BYTES + 1);
  fs.writeFileSync(path.join(legacy, 'hive-thread.json'), '{"fresh":true,"ids":[]}');
  const home = path.join(root, 'home');
  const res = migrateSeatHome(agent, home);
  assert.deepEqual(res.copied, ['hive-thread.json']);
  assert.ok(res.skipped.some((s) => /^history\.jsonl \(larger than \d+ bytes\)$/.test(s)), JSON.stringify(res.skipped));
  assert.equal(migrateSeatHome(agent, home), null, 'finished');
});

// A provider the app does not sandbox can write anywhere, so its roots say nothing: it reaches every Codex home.
const refusedUnconfined = (provider) => (e) => {
  assert.equal(e.name, 'CodexHomeRefused', String(e));
  assert.ok(e.message.includes(provider), `the reason names ${provider}: ${e.message}`);
  return true;
};

test('an agent the app does not sandbox cannot start while any Codex agent has a home', async (t) => {
  const f = fixture(t);
  // No Codex home yet: nothing for it to reach.
  await f.hive.ensureAgent({ id: 'early', name: 'e', provider: 'custom', cwd: f.cwd });
  f.hive.withdrawRefusedSpawn('early', 'test cleanup');
  const victim = (await f.spawn('victim')).env.CODEX_HOME;
  for (const provider of ['custom', 'gemini', 'opencode']) {
    await assert.rejects(f.hive.ensureAgent({ id: `u-${provider}`, name: 'u', provider, cwd: f.cwd }), refusedUnconfined(provider), provider);
    assert.equal(fs.existsSync(f.agentDir(`u-${provider}`)), false, `${provider}: nothing created`);
  }
  assert.ok(fs.existsSync(victim));
});

test('a Codex agent cannot start while an agent the app does not sandbox is starting or running', async (t) => {
  const f = fixture(t);
  // Starting: admitted, its terminal not yet up.
  await f.hive.ensureAgent({ id: 'u1', name: 'u', provider: 'custom', cwd: f.cwd }, { spawnId: 'pty-u1' });
  await assert.rejects(f.spawn('cx1'), refusedUnconfined('custom'));
  // Its spawn was refused or failed: it no longer counts.
  f.hive.withdrawRefusedSpawn('pty-u1', 'test');
  // Running: the app reports it live.
  let live = [{ agentId: 'u2', provider: 'gemini' }];
  f.hive.setLiveSeats(() => live);
  await assert.rejects(f.spawn('cx2'), (e) => refusedUnconfined('gemini')(e) && e.message.includes('u2'));
  assert.equal(fs.existsSync(codexShortHomePath(path.join(f.agentDir('cx2'), '.codex'), 'cx2')), false, 'no home was made');
  live = [];
  assert.ok((await f.spawn('cx3')).env.CODEX_HOME, 'once it is gone, Codex starts');
});

test('a source rewritten to the same size while it is copied leaves no marker, and the next start copies it whole', (t) => {
  const { migrateSeatHome } = loadTs('src/main/codexSeatHome.ts');
  const root = codexTestBase(t, 'mdss-');
  const agent = path.join(root, 'agent');
  const legacy = path.join(agent, '.codex');
  fs.mkdirSync(legacy, { recursive: true });
  const src = path.join(legacy, 'history.jsonl');
  const MiB = 1024 * 1024;
  fs.writeFileSync(src, Buffer.alloc(2 * MiB, 'A'));
  const home = path.join(root, 'home');
  // After the first 1 MiB is read, another writer rewrites the source in place with 2 MiB of other bytes.
  const realRead = fs.readSync;
  let rewritten = false;
  fs.readSync = function (...args) {
    const n = realRead.apply(fs, args);
    if (!rewritten && n === MiB) { rewritten = true; fs.writeFileSync(src, Buffer.alloc(2 * MiB, 'B')); }
    return n;
  };
  let first;
  try { first = migrateSeatHome(agent, home); } finally { fs.readSync = realRead; }
  assert.equal(rewritten, true, 'the probe ran');
  assert.equal(first.finished, false, JSON.stringify(first));
  assert.equal(fs.existsSync(path.join(home, 'history.jsonl')), false, 'no mixed copy published');
  assert.equal(fs.readdirSync(home).some((n) => n.startsWith('.migrated')), false, 'no marker');
  const again = migrateSeatHome(agent, home);
  assert.ok(again.finished && again.copied.includes('history.jsonl'), JSON.stringify(again));
  assert.ok(fs.readFileSync(path.join(home, 'history.jsonl')).equals(Buffer.alloc(2 * MiB, 'B')), 'the whole new file');
});
