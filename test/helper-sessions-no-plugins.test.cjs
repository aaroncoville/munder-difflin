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
  const { runHiddenClaude } = loadTs('src/main/hiddenClaude.ts');
  const r = await runHiddenClaude('hi', { model: 'claude-haiku-5-5', cwd: os.tmpdir() });
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
  const { runHiddenClaude } = loadTs('src/main/hiddenClaude.ts');
  await runHiddenClaude('hi', { model: 'm', cwd: os.tmpdir(), plugins: ['GitHub'], mcpConfigs: ['/x/mcp.json'] });
  const { args, settings } = spawns[0];
  assert.deepEqual(settings.enabledPlugins, { ...ALL_OFF, 'github@claude-plugins-official': true });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(args.slice(args.indexOf('--mcp-config')), ['--mcp-config', '/x/mcp.json']);
});

test('call site reflect.ts (memory condense): its helper loads no plugin and no MCP server', async (t) => {
  ownerDir(t);
  const spawns = capturePty(t);
  const { MemoryReflector } = loadTs('src/main/reflect.ts');
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
  }
});
