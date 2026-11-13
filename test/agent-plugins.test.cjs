'use strict';
// Hive agents load only an allowlisted set of Claude plugins: the per-agent settings file sets enabledPlugins, which
// outranks the owner's user-level `true` for that session (shown on Claude Code 2.1.322 with a scratch session).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const P = loadTs('src/main/agentPlugins.ts');

function claudeDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, 'plugins', 'synced', 'org_x', 'engineering~g3', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ enabledPlugins: { 'terraform@claude-plugins-official': true, 'superpowers@claude-plugins-official': true, 'warp@claude-code-warp': true } }));
  fs.writeFileSync(path.join(d, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'github@claude-plugins-official': [], 'aws-core@claude-plugins-official': [] } }));
  fs.writeFileSync(path.join(d, 'plugins', 'synced', 'org_x', 'engineering~g3', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engineering' }));
  return d;
}

test('every plugin the owner has (settings, installed, synced) is listed; only the kept names are on', (t) => {
  const d = claudeDir(t);
  const ids = P.knownPluginIds(d);
  assert.deepEqual([...ids].sort(), ['aws-core@claude-plugins-official', 'engineering@synced', 'github@claude-plugins-official', 'superpowers@claude-plugins-official', 'terraform@claude-plugins-official', 'warp@claude-code-warp']);
  assert.deepEqual(P.agentEnabledPlugins(ids, ['superpowers', 'github']), {
    'aws-core@claude-plugins-official': false, 'engineering@synced': false, 'github@claude-plugins-official': true,
    'superpowers@claude-plugins-official': true, 'terraform@claude-plugins-official': false, 'warp@claude-code-warp': false
  });
});

test('the default keep-list is the six named plugins; built-ins are left to the CLI', () => {
  assert.deepEqual([...P.DEFAULT_AGENT_PLUGINS].sort(), ['chrome-devtools-mcp', 'claude-md-management', 'frontend-design', 'github', 'gitlab', 'superpowers']);
  assert.deepEqual(P.agentEnabledPlugins(['cc-plugin-privacy@builtin', 'x@m'], []), { 'x@m': false });
  // The spawn core hands the Settings list to ensureAgent (live line, not commented out).
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /^          agentPlugins: readConfig\(\)\.agentPlugins,$/m);
});

test('missing or broken sources read as no plugins, never a throw', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.deepEqual(P.knownPluginIds(d), []);
  fs.writeFileSync(path.join(d, 'settings.json'), '{not json');
  fs.mkdirSync(path.join(d, 'plugins'));
  fs.writeFileSync(path.join(d, 'plugins', 'installed_plugins.json'), '[]');
  assert.deepEqual(P.knownPluginIds(d), []);
});

test('a Claude agent\'s generated settings carry the map: kept plugins on, every other plugin the owner has off', async (t) => {
  const d = claudeDir(t);
  const electron = require.resolve('electron');
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = d; // the owner's Claude folder, as the app reads it
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; });
  const hive = new HiveManager(() => home);
  const read = async (id, opts) => {
    const inj = await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home }, opts);
    const i = inj.args.indexOf('--settings');
    assert.ok(i >= 0);
    return JSON.parse(fs.readFileSync(inj.args[i + 1], 'utf8')).enabledPlugins;
  };
  assert.deepEqual(await read('p1', {}), {
    'aws-core@claude-plugins-official': false, 'engineering@synced': false, 'github@claude-plugins-official': true,
    'superpowers@claude-plugins-official': true, 'terraform@claude-plugins-official': false, 'warp@claude-code-warp': false
  }, 'unset: the default keep-list');
  const own = await read('p2', { agentPlugins: ['terraform'] });
  assert.equal(own['terraform@claude-plugins-official'], true, 'the Settings list is what is kept');
  assert.equal(own['superpowers@claude-plugins-official'], false);
});
