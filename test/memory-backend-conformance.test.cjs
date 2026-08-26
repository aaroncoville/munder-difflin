'use strict';

/**
 * One contract, run against every backend.
 *
 * The manager treats backends interchangeably, so anything it relies on has to
 * hold for all of them — including the awkward parts: a broken backend reports
 * failure rather than throwing (a throw would abort the whole mine pass and
 * take the other agents down with it), and status() answers even with no hive
 * home, because the settings panel polls it before one is chosen.
 *
 * Each case supplies a backend that is healthy and one that is broken, so the
 * degraded path is exercised the same way for both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const { MemPalaceAdapter } = loadTs('src/main/memPalaceAdapter.ts');
const { HindsightAdapter } = loadTs('src/main/hindsightAdapter.ts');

const HIT = 'Sales sits on floor two.';

function agentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-'));
  fs.writeFileSync(path.join(dir, 'memory.md'), `## A fact\n\n${HIT}\n`, 'utf8');
  return dir;
}

/** A stand-in `mempalace` executable: succeeds, and prints a hit when asked. */
function fakeCli(t, { broken } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-cli-'));
  const bin = path.join(dir, 'mempalace');
  fs.writeFileSync(bin, broken
    ? '#!/bin/sh\necho "backend is down" >&2\nexit 1\n'
    : `#!/bin/sh\ncase "$1" in mine) : ;; *) echo "${HIT}" ;; esac\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}

async function hindsightStub(t, { broken } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (/\/memories\/recall$/.test(req.url)) {
        res.end(JSON.stringify({ results: [{ text: HIT, scores: { final: 0.77 } }] }));
      } else {
        res.end(JSON.stringify({ success: true, bank_id: 'b1', total_nodes: 1 }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (broken) await new Promise((resolve) => server.close(resolve));
  else t.after(() => new Promise((resolve) => server.close(resolve)));
  return url;
}

const CASES = [
  {
    id: 'mempalace',
    make: async (t, opts = {}) => {
      const palace = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-palace-'));
      t.after(() => fs.rmSync(palace, { recursive: true, force: true }));
      const adapter = new MemPalaceAdapter(() => palace, () => 'minilm');
      const bin = fakeCli(t, opts);
      adapter.bin = () => bin; // the real one probes this machine's PATH
      return adapter;
    }
  },
  {
    id: 'hindsight',
    make: async (t, opts = {}) => {
      const url = await hindsightStub(t, opts);
      const adapter = new HindsightAdapter(() => ({ url, bank: 'b1' }), () => '/tmp/home');
      await adapter.probeHealth();
      return adapter;
    }
  }
];

for (const { id, make } of CASES) {
  test(`${id}: a healthy backend accepts a mined memory`, async (t) => {
    assert.deepEqual(await (await make(t)).mineAgent(agentDir(), 'pam'), { ok: true });
  });

  test(`${id}: a broken backend reports failure instead of throwing`, async (t) => {
    const adapter = await make(t, { broken: true });
    const result = await adapter.mineAgent(agentDir(), 'pam');
    assert.equal(result.ok, false, 'a mine pass must survive one bad backend');
  });

  test(`${id}: search returns the seeded hit as text`, async (t) => {
    const result = await (await make(t)).search('floor', { agentId: 'pam', results: 3 });
    assert.equal(result.ok, true);
    assert.match(result.output, /floor two/);
  });

  test(`${id}: wake-up returns text`, async (t) => {
    const result = await (await make(t)).wakeUp('pam');
    assert.equal(result.ok, true);
    assert.match(result.output, /floor two/);
  });

  test(`${id}: a broken backend answers a search without throwing`, async (t) => {
    const adapter = await make(t, { broken: true });
    const result = await adapter.search('floor', { agentId: 'pam' });
    assert.equal(result.ok, false);
    assert.equal(result.output, '');
    assert.ok(result.error, 'a failure has to say something about itself');
  });

  test(`${id}: the spawn environment names this backend`, async (t) => {
    assert.equal((await make(t)).agentEnv().HIVE_MEMORY_BACKEND, id);
  });

  test(`${id}: status answers before a hive home exists`, async (t) => {
    const adapter = await make(t);
    const status = adapter.status(true, null);
    assert.equal(status.backend, id);
    assert.equal(status.enabled, true);
    assert.equal(status.active, false, 'no home means nothing to mine');
    assert.equal(typeof status.available, 'boolean');
    assert.equal(typeof status.initialized, 'boolean');
  });

  test(`${id}: init does not throw against a broken backend`, async (t) => {
    const adapter = await make(t, { broken: true });
    adapter.init();
    assert.equal(adapter.status(true, null).active, false);
  });
}
