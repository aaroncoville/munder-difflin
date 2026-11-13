'use strict';
// The app's own helper Claude sessions (runHiddenClaude: today only the memory condense in reflect.ts) loaded every
// plugin the owner enabled in ~/.claude/settings.json and every MCP server, so each condense started (among others)
// a terraform-mcp-server container. A helper now gets a --settings file whose enabledPlugins map turns every plugin
// the owner has off (the hive-agent mechanism from agentPlugins.ts), and --strict-mcp-config with no --mcp-config,
// so no MCP server starts. A call site that needs a plugin or a server names it (opts.plugins / opts.mcpConfigs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

/** A fake owner Claude folder with plugins on, pointed at by CLAUDE_CONFIG_DIR for the test. */
function ownerDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-plugins-'));
  fs.mkdirSync(path.join(d, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ enabledPlugins: { 'terraform@claude-plugins-official': true, 'superpowers@claude-plugins-official': true } }));
  fs.writeFileSync(path.join(d, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'github@claude-plugins-official': [] } }));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = d;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}

/** An app-private folder for helper settings, outside a fake hive folder, configured on the loaded module. */
function privateDir(t, mod) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'helper-userdata-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hive = path.join(base, 'hive');
  fs.mkdirSync(hive);
  const dir = path.join(base, 'userData', 'helper-sessions');
  mod.setHelperSettingsDir(dir, () => hive);
  return { base, hive, dir };
}

/** Stub node-pty so a spawn records its args and the --settings file's contents, then fails (no real CLI runs). */
function capturePty(t) {
  const spawns = [];
  loadTs.reset();
  // Bare imports bypass loadTs.stub, so the real module's spawn is replaced (and put back) before hiddenClaude loads.
  const pty = require('node-pty');
  const real = pty.spawn;
  t.after(() => { pty.spawn = real; });
  Object.assign(pty, {
    spawn: (file, args) => {
      const i = args.indexOf('--settings');
      const settingsPath = i >= 0 ? args[i + 1] : null;
      spawns.push({ file, args, settingsPath, settings: settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null });
      throw new Error('stubbed spawn');
    }
  });
  return spawns;
}

const ALL_OFF = {
  'github@claude-plugins-official': false,
  'superpowers@claude-plugins-official': false,
  'terraform@claude-plugins-official': false
};

test('a helper session loads no plugin and no MCP server by default', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const hc = loadTs('src/main/hiddenClaude.ts');
  privateDir(t, hc);
  const r = await hc.runHiddenClaude('hi', { model: 'claude-haiku-5-5', cwd: os.tmpdir() });
  assert.equal(r.ok, false);
  assert.equal(spawns.length, 1);
  const { args, settings, settingsPath } = spawns[0];
  assert.ok(args.includes('--strict-mcp-config'), 'no user, project or plugin MCP server');
  assert.ok(!args.includes('--mcp-config'));
  assert.deepEqual(settings, { enabledPlugins: ALL_OFF });
  assert.ok(!fs.existsSync(settingsPath), 'the per-call settings file is removed');
});

test('a call site that needs a plugin or an MCP server names it, and gets only that', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const hc = loadTs('src/main/hiddenClaude.ts');
  privateDir(t, hc);
  await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir(), plugins: ['GitHub'], mcpConfigs: ['/x/mcp.json'] });
  const { args, settings } = spawns[0];
  assert.deepEqual(settings.enabledPlugins, { ...ALL_OFF, 'github@claude-plugins-official': true });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(args.slice(args.indexOf('--mcp-config')), ['--mcp-config', '/x/mcp.json']);
});

test('call site reflect.ts (memory condense): its helper loads no plugin and no MCP server', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const { MemoryReflector } = loadTs('src/main/reflect.ts');
  const { dir: helperDir } = privateDir(t, loadTs('src/main/hiddenClaude.ts'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-reflect-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'hive', 'agents', 'a1');
  fs.mkdirSync(dir, { recursive: true });
  const body = (h) => `## ${h}\n${'x'.repeat(300)}\n`;
  fs.writeFileSync(path.join(dir, 'memory.md'), ['# Memory\n', '## 📌 Durable facts (pinned — never condensed)\n\nf\n', '## Recent\n', body('one'), body('two'), body('three')].join('\n'));
  const reflector = new MemoryReflector(() => home, () => 'claude', () => ({}),
    () => ({ enabled: true, intervalMs: 1_800_000, byteTriggerPct: 0, sectionTrigger: 50, recentKeep: 1, minBytes: 50, keepBudgetPct: 25 }),
    () => {});
  await reflector.reflectNow('a1');
  assert.ok(spawns.length >= 1, 'the condense reached a helper spawn');
  for (const s of spawns) {
    assert.ok(s.args.includes('--strict-mcp-config'));
    assert.ok(!s.args.includes('--mcp-config'));
    assert.deepEqual(s.settings, { enabledPlugins: ALL_OFF });
    assert.equal(path.dirname(path.dirname(s.settingsPath)), helperDir);
  }
});

// Review of #102, H1: the settings file was written under tmpdir(), which Codex seats can write, so a seat could swap
// in a `hooks` entry that runs as the owner. It now lives in the app's private folder, checked like hook-runtime.
test('the helper settings file is in the app-private folder, owner-only, never the temp folder, and removed after', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const hc = loadTs('src/main/hiddenClaude.ts');
  const { dir } = privateDir(t, hc);
  await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir() });
  const { settingsPath } = spawns[0];
  const folder = path.dirname(settingsPath);
  assert.equal(path.dirname(folder), dir, 'a per-call folder inside the configured private folder');
  assert.match(path.basename(folder), /^helper-/, 'a name-neutral, unique prefix');
  assert.notEqual(path.dirname(folder), fs.realpathSync(os.tmpdir()), 'not directly in the temp folder');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(!fs.existsSync(folder), 'removed when the session ends');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('no helper runs when the private folder is unset, a link, or inside the hive', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const hc = loadTs('src/main/hiddenClaude.ts');
  const { base, hive, dir } = privateDir(t, hc);

  hc.setHelperSettingsDir(null, () => hive);
  let r = await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir() });
  assert.equal(r.ok, false);
  assert.match(r.error, /no private folder/);

  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.rmSync(dir, { recursive: true, force: true }); // setting the folder made it (the startup sweep checks it)
  fs.symlinkSync(elsewhere, dir);
  hc.setHelperSettingsDir(dir, () => hive);
  r = await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir() });
  assert.equal(r.ok, false);
  assert.match(r.error, /link/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing written through the link');

  hc.setHelperSettingsDir(path.join(hive, 'helper-sessions'), () => hive);
  r = await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir() });
  assert.equal(r.ok, false);
  assert.match(r.error, /overlaps the hive/);
  assert.ok(!fs.existsSync(path.join(hive, 'helper-sessions')));

  assert.equal(spawns.length, 0, 'the CLI was never started');
});

// Review of #102, MED: once the per-call folder exists, every failure removes it; a removal that fails is logged once
// with its path; leftovers of a crashed run are swept when the folder is set.
test('a settings write that fails after the folder exists leaves nothing behind, and no helper starts', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const hc = loadTs('src/main/hiddenClaude.ts');
  const { dir } = privateDir(t, hc);
  const realFs = require('node:fs');
  const open = realFs.openSync;
  t.after(() => { realFs.openSync = open; });
  realFs.openSync = (p, ...rest) => {
    if (String(p).includes('settings.json')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return open(p, ...rest);
  };
  const r = await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir() });
  realFs.openSync = open;
  assert.equal(r.ok, false);
  assert.match(r.error, /helper settings: .*ENOSPC/);
  assert.equal(spawns.length, 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'the per-call folder was removed');
});

test('a per-call folder that cannot be removed is logged once with its path; the result is still returned', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const hc = loadTs('src/main/hiddenClaude.ts');
  const { hive, dir } = privateDir(t, hc);
  const logs = [];
  hc.setHelperSettingsDir(dir, () => hive, (e) => logs.push(e));
  const realFs = require('node:fs');
  const rm = realFs.rmSync;
  t.after(() => { realFs.rmSync = rm; });
  realFs.rmSync = (p, ...rest) => {
    if (path.basename(String(p)).startsWith('helper-')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return rm(p, ...rest);
  };
  const r = await hc.runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir() });
  realFs.rmSync = rm;
  assert.equal(r.ok, false);
  assert.match(r.error, /stubbed spawn/, 'the helper result, not the cleanup failure');
  const folder = path.dirname(spawns[0].settingsPath);
  assert.deepEqual(logs, [{ kind: 'helper-settings-left', path: folder, why: 'EACCES: permission denied' }]);
});

test('setting the folder sweeps per-call folders a crashed run left, and nothing else', (t) => {
  const hc = loadTs('src/main/hiddenClaude.ts');
  const { hive, dir } = privateDir(t, hc);
  fs.mkdirSync(path.join(dir, 'helper-aB3xY9'));
  fs.writeFileSync(path.join(dir, 'helper-aB3xY9', 'settings.json'), '{}');
  fs.mkdirSync(path.join(dir, 'keep-me'));
  fs.writeFileSync(path.join(dir, 'helper-notes.txt'), 'x');
  hc.setHelperSettingsDir(dir, () => hive);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['helper-notes.txt', 'keep-me']);
});
