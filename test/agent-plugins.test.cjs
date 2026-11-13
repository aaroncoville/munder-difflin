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

test('a kept entry may be the name or the full id, in any case', () => {
  const ids = ['github@claude-plugins-official', 'Superpowers@claude-plugins-official', 'terraform@claude-plugins-official', 'engineering@synced'];
  assert.deepEqual(P.agentEnabledPlugins(ids, ['GitHub', 'superpowers@CLAUDE-plugins-official', 'Engineering@Synced']), {
    'github@claude-plugins-official': true, 'Superpowers@claude-plugins-official': true, 'terraform@claude-plugins-official': false, 'engineering@synced': true
  });
  assert.equal(P.agentEnabledPlugins(['github@claude-plugins-official'], ['git'])['github@claude-plugins-official'], false, 'never a substring');
});

test('the setting is validated on read: anything but a bounded list of plain strings is the default list, logged once, never a throw', () => {
  const logs = [];
  const log = (why) => logs.push(why);
  assert.deepEqual(P.agentPluginList(undefined, log), [...P.DEFAULT_AGENT_PLUGINS], 'unset: the default, not logged');
  assert.equal(logs.length, 0);
  assert.deepEqual(P.agentPluginList(['github', ' gitlab '], log), ['github', 'gitlab']);
  assert.deepEqual(P.agentPluginList([], log), [], 'an empty list is a choice: every plugin off');
  for (const bad of ['github,gitlab', { github: true }, ['github', 1], ['x'.repeat(201)], Array.from({ length: 201 }, (_, i) => `p${i}`), [''], null, 42]) {
    assert.deepEqual(P.agentPluginList(bad, log), [...P.DEFAULT_AGENT_PLUGINS], JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(logs.length, 8, 'one log row per bad read');
  assert.doesNotThrow(() => P.agentPluginList({ toString() { throw new Error('x'); } }, () => { throw new Error('log failed'); }));
});

test('a hand-edited setting never makes ensureAgent throw', async (t) => {
  const electron = require.resolve('electron');
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  for (const bad of [{ github: true }, 'github', [1, 2]]) {
    const inj = await hive.ensureAgent({ id: `h${Math.random().toString(36).slice(2, 7)}`, name: 'h', provider: 'claude', cwd: home }, { agentPlugins: bad });
    assert.ok(inj.args.includes('--settings'));
  }
  // The same agent spawned again with the same bad setting: still one row for it this run.
  for (let i = 0; i < 3; i++) await hive.ensureAgent({ id: 'same', name: 'same', provider: 'claude', cwd: home }, { agentPlugins: 'github' });
  const log = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8');
  assert.equal((log.match(/"kind":"agent-plugins-setting"/g) ?? []).length, 4, 'one row per agent per run');
});

test('Settings offers Reset to default, and the hint says what an empty list and other settings files do', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  // One button: its click restores the default list, and it shows the Reset label.
  assert.match(ui, /<PixelButton[^>]*onClick=\{\(\) => \{ setAgentPluginsText\(DEFAULT_AGENT_PLUGINS\.join\('\\n'\)\); stage\(\{ agentPlugins: \[\.\.\.DEFAULT_AGENT_PLUGINS\] \}\); \}\}>\s*\{t\('settings\.agentsModels\.agentPluginsReset'\)\}\s*<\/PixelButton>/);
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales', 'en.json'), 'utf8')).settings.agentsModels;
  assert.ok(en.agentPluginsReset);
  assert.match(en.agentPluginsDesc, /empty list turns every plugin off/i);
  assert.match(en.agentPluginsDesc, /project or managed settings/i);
});
