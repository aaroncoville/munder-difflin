'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');
const { migrateMemorySettings } = loadTs('src/main/config.ts');

function hiveWithAgents(ids) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-fair-'));
  for (const id of ids) {
    const dir = path.join(home, 'hive', 'agents', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.md'), `## ${id}\n\nA fact.\n`, 'utf8');
  }
  return home;
}

/** A backend with one retain slot per pass, like Hindsight's: whoever is asked first takes it. */
function oneSlotBackend(backlog) {
  return {
    id: 'hindsight',
    served: [],
    slotFree: true,
    available: () => true,
    probesAsync: true,
    init() {},
    async mineAgent(_dir, agentId) {
      if (!backlog[agentId]) return { ok: true };
      if (!this.slotFree) return { ok: false };
      this.slotFree = false;
      this.served.push(agentId);
      backlog[agentId] -= 1;
      return { ok: backlog[agentId] === 0, sent: true };
    },
    async search() { return { ok: true, output: '' }; },
    async wakeUp() { return { ok: true, output: '' }; },
    status: (enabled, home) => ({ backend: 'hindsight', available: true, enabled, active: enabled && home !== null, initialized: true, location: 'x', model: null, bin: null }),
    agentEnv: () => ({ HIVE_MEMORY_BACKEND: 'hindsight' }),
    resetCaches() {}
  };
}

test('agents take turns at the retain slot, so one big memory cannot starve the rest', async () => {
  const home = hiveWithAgents(['angela', 'kevin', 'oscar']);
  const settings = migrateMemorySettings({ semanticMemory: true, memoryBackend: 'hindsight' });
  const backend = oneSlotBackend({ angela: 100, kevin: 2, oscar: 2 });
  const manager = new MemoryManager(() => home, () => settings, () => backend);
  manager.refresh();
  for (let pass = 0; pass < 6; pass++) {
    backend.slotFree = true;
    await manager.mineNow();
  }
  assert.deepEqual(backend.served, ['angela', 'kevin', 'oscar', 'angela', 'kevin', 'oscar']);
});

test('a new Hindsight bank makes every agent eligible again', async () => {
  const home = hiveWithAgents(['pam']);
  const settings = migrateMemorySettings({ semanticMemory: true, memoryBackend: 'hindsight' });
  const mined = [];
  const backend = { ...oneSlotBackend({}), async mineAgent(_d, id) { mined.push(id); return { ok: true }; } };
  const manager = new MemoryManager(() => home, () => settings, () => backend);
  manager.refresh();
  await manager.mineNow();
  await manager.mineNow();
  assert.deepEqual(mined, ['pam'], 'an unchanged memory.md is not offered twice');
  settings.hindsight.bank = 'another-bank';
  await manager.mineNow();
  assert.deepEqual(mined, ['pam', 'pam']);
});
