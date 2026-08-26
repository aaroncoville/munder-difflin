'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { migrateMemorySettings, DEFAULT_HINDSIGHT_URL, DEFAULT_HINDSIGHT_BANK } = loadTs('src/main/config.ts');
const { MemoryManager } = loadTs('src/main/memory.ts');

test('the pre-backend settings become a mempalace configuration', () => {
  assert.deepEqual(migrateMemorySettings({ semanticMemory: true, embeddingModel: 'embeddinggemma' }), {
    enabled: true,
    backend: 'mempalace',
    mempalace: { model: 'embeddinggemma' },
    hindsight: { url: DEFAULT_HINDSIGHT_URL, bank: DEFAULT_HINDSIGHT_BANK }
  });
});

test('an off switch survives the migration', () => {
  assert.equal(migrateMemorySettings({ semanticMemory: false, embeddingModel: 'minilm' }).enabled, false);
});

test('migrating an already-migrated shape changes nothing', () => {
  const migrated = migrateMemorySettings({ semanticMemory: true, embeddingModel: 'minilm' });
  assert.deepEqual(migrateMemorySettings(migrated), migrated);

  const hindsight = {
    enabled: true,
    backend: 'hindsight',
    mempalace: { model: 'minilm' },
    hindsight: { url: 'http://memories.example:9000', bank: 'floor-two' }
  };
  assert.deepEqual(migrateMemorySettings(hindsight), hindsight);
});

test('garbage migrates to a safe, disabled default', () => {
  for (const junk of [undefined, null, 'nonsense', 42, []]) {
    assert.deepEqual(migrateMemorySettings(junk), {
      enabled: false,
      backend: 'mempalace',
      mempalace: { model: 'minilm' },
      hindsight: { url: DEFAULT_HINDSIGHT_URL, bank: DEFAULT_HINDSIGHT_BANK }
    }, `for ${JSON.stringify(junk)}`);
  }
});

test('an unrecognised backend name falls back to the local one', () => {
  assert.equal(migrateMemorySettings({ semanticMemory: true, memoryBackend: 'telepathy' }).backend, 'mempalace');
});

test('a blank server address falls back to the default endpoint', () => {
  const migrated = migrateMemorySettings({ semanticMemory: true, memoryBackend: 'hindsight', hindsightUrl: '   ', hindsightBank: '' });
  assert.equal(migrated.backend, 'hindsight');
  assert.equal(migrated.hindsight.url, DEFAULT_HINDSIGHT_URL);
  assert.equal(migrated.hindsight.bank, DEFAULT_HINDSIGHT_BANK);
});

// ─── Backend selection and the swap ─────────────────────────────────────────

/** A MemoryBackend that records what the manager asked it to do. */
function stubBackend(id) {
  return {
    id,
    mined: [],
    available: () => true,
    probesAsync: true,
    init() {},
    async mineAgent(_dir, agentId) { this.mined.push(agentId); return { ok: true }; },
    async search() { return { ok: true, output: '' }; },
    async wakeUp() { return { ok: true, output: '' }; },
    status: (enabled, home) => ({
      backend: id, available: true, enabled, active: enabled && home !== null,
      initialized: true, location: id, model: null, bin: null
    }),
    agentEnv: () => ({ HIVE_MEMORY_BACKEND: id }),
    resetCaches() {}
  };
}

function hiveWithAgent(agentId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-swap-'));
  const dir = path.join(home, 'hive', 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), '## A fact\n\nSales sits on floor two.\n', 'utf8');
  return home;
}

test('switching backend re-mines memories the previous backend had already taken', async () => {
  const home = hiveWithAgent('pam');
  const settings = migrateMemorySettings({ semanticMemory: true, memoryBackend: 'mempalace' });
  const backends = { mempalace: stubBackend('mempalace'), hindsight: stubBackend('hindsight') };

  const manager = new MemoryManager(() => home, () => settings, (id) => backends[id]);
  manager.refresh();
  await manager.mineNow();
  assert.deepEqual(backends.mempalace.mined, ['pam']);

  // Unchanged memory.md: the same backend must NOT mine it a second time.
  await manager.mineNow();
  assert.deepEqual(backends.mempalace.mined, ['pam'], 'unchanged memory is skipped');

  settings.backend = 'hindsight';
  manager.refresh();
  await manager.mineNow();

  assert.deepEqual(backends.hindsight.mined, ['pam'], 'the new backend starts from scratch');
  assert.deepEqual(backends.mempalace.mined, ['pam'], 'the old backend is not asked again');
});

test('the manager routes searches to whichever backend the settings name', async () => {
  const home = hiveWithAgent('jim');
  const settings = migrateMemorySettings({ semanticMemory: true, memoryBackend: 'hindsight' });
  const backends = { mempalace: stubBackend('mempalace'), hindsight: stubBackend('hindsight') };
  const manager = new MemoryManager(() => home, () => settings, (id) => backends[id]);

  assert.equal(manager.status().backend, 'hindsight');
  assert.deepEqual(manager.env(), { HIVE_MEMORY_BACKEND: 'hindsight' });
});

test('with no factory supplied the manager builds the real adapter each setting names', () => {
  const home = hiveWithAgent('dwight');
  for (const backend of ['mempalace', 'hindsight']) {
    const settings = migrateMemorySettings({ semanticMemory: true, memoryBackend: backend });
    assert.equal(new MemoryManager(() => home, () => settings).status().backend, backend);
  }
});

test('a server backend arms its mine loop before the first health answer', async (t) => {
  // Availability for a remote backend is only knowable after a probe, and the
  // probe is part of arming it. Gating start() on availability the way a local
  // CLI is gated would mean it never starts and so never becomes available.
  const http = require('node:http');
  const server = http.createServer((req, res) => { req.resume(); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const home = hiveWithAgent('creed');
  const settings = migrateMemorySettings({
    semanticMemory: true, memoryBackend: 'hindsight',
    hindsightUrl: `http://127.0.0.1:${server.address().port}`, hindsightBank: 'b1'
  });
  const manager = new MemoryManager(() => home, () => settings);
  t.after(() => manager.stop());

  assert.equal(manager.available(), false, 'nothing has been probed yet');
  manager.refresh();
  assert.notEqual(manager.mineTimer, null, 'the loop must be armed anyway');
});
