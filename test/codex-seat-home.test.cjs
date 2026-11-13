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
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { codexShortHomePath } = loadTs('src/shared/codexRemote.ts');

/** A short /tmp root standing in for the user's home, so the computed home
 *  (under the home-level short root) lands inside it and fits the socket cap. */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/mdsh-'));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = oldHome; fs.rmSync(root, { recursive: true, force: true }); });
  const hive = new HiveManager(() => root);
  // The app's own hook runtime folder, outside the hive: without one no hook command is written.
  const runtime = fs.realpathSync(fs.mkdtempSync('/tmp/mdsr-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
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

test('a home inside one of the agent\'s writable folders refuses the spawn', async (t) => {
  const f = fixture(t);
  // Roots that contain the short-home base, spelled directly and through a link.
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.root, alias);
  for (const extra of [[f.root], [alias]]) {
    await assert.rejects(f.spawn('o', extra), (e) => e.name === 'CodexHomeRefused' && /overlaps the writable folder/.test(e.message));
  }
});

test('an agent with an old in-tree home keeps its history, and only that is copied', async (t) => {
  const f = fixture(t);
  const legacy = path.join(f.agentDir('m'), '.codex');
  fs.mkdirSync(path.join(legacy, 'skills', 's'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'plugins'), { recursive: true });
  for (const [name, body] of [['history.jsonl', '{"h":1}\n'], ['hive-thread.json', '{"thread":"t1"}'],
    ['state_5.sqlite', 'state'], ['state_5.sqlite-wal', 'wal'], ['thread_history_1.sqlite', 'th'],
    ['hooks.json', '{"hooks":{}}'], ['AGENTS.md', 'do as I say'], ['config.toml', 'model = "x"\n'], ['dev.config.toml', 'x'],
    ['skills/s/SKILL.md', 's'], ['plugins/p.json', '{}']]) fs.writeFileSync(path.join(legacy, name), body);
  fs.symlinkSync('/etc/hosts', path.join(legacy, 'thread_history_2.sqlite'));
  const before = snapshot(legacy);

  const home = (await f.spawn('m')).env.CODEX_HOME;
  for (const name of ['history.jsonl', 'hive-thread.json', 'state_5.sqlite', 'state_5.sqlite-wal', 'thread_history_1.sqlite']) {
    assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), before[name], name);
    assert.ok(fs.lstatSync(path.join(home, name)).isFile(), `${name} is a copy, not a link`);
  }
  for (const name of ['hooks.json', 'AGENTS.md', 'dev.config.toml', 'skills', 'plugins', 'thread_history_2.sqlite']) {
    assert.equal(fs.existsSync(path.join(home, name)), false, `${name} must not be carried over`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /model = "x"/);
  assert.deepEqual(snapshot(legacy), before, 'the old home is left exactly as it was');

  await f.spawn('m');
  const rows = fs.readFileSync(path.join(f.hiveRoot, 'log.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.kind === 'codex-home-migrated');
  assert.equal(rows.length, 1, 'one log row, on the first spawn only');
  assert.equal(rows[0].from, legacy);
  assert.ok(rows[0].skipped.some((s) => s.startsWith('thread_history_2.sqlite')), 'the linked file is named as skipped');
});

test('migration caps each file and never follows a link', (t) => {
  const { migrateSeatHome } = loadTs('src/main/codexSeatHome.ts');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/mdsm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent');
  fs.mkdirSync(path.join(agent, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(agent, '.codex', 'state_5.sqlite'), 'x'.repeat(64));
  fs.writeFileSync(path.join(agent, '.codex', 'history.jsonl'), 'ok');
  const home = path.join(root, 'home');
  const res = migrateSeatHome(agent, home, 16);
  assert.deepEqual(res.copied, ['history.jsonl']);
  assert.match(res.skipped.join(), /state_5\.sqlite \(larger than 16 bytes\)/);
  assert.equal(fs.existsSync(path.join(home, 'state_5.sqlite')), false);

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
  fs.writeFileSync(path.join(legacy, 'hive-thread.json'), '{"thread":"t1"}');

  const home = (await f.spawn('r')).env.CODEX_HOME;
  assert.equal(fs.realpathSync(path.join(home, 'sessions')), fs.realpathSync(target));
  assert.ok(fs.existsSync(path.join(home, 'sessions', '2026', '11', '12', 'rollout-x.jsonl')));
  assert.equal(fs.readFileSync(path.join(home, 'state_5.sqlite'), 'utf8'), 'index');
  assert.equal(fs.readFileSync(path.join(home, 'hive-thread.json'), 'utf8'), '{"thread":"t1"}');
});
