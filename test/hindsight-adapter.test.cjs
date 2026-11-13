'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HindsightAdapter } = loadTs('src/main/hindsightAdapter.ts');

/** A stub Hindsight server that records every request it is handed. */
async function stub(t, routes = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null };
      seen.push(entry);
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const route = routes[key];
      if (!route) { res.statusCode = 404; res.end('{}'); return; }
      // A route may answer with a promise; one that never settles plays a server that hangs.
      void Promise.resolve(typeof route === 'function' ? route(entry) : route).then((reply) => {
        res.statusCode = reply.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply.json ?? {}));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, server, close: () => new Promise((resolve) => server.close(resolve)) };
}

function agentDirWith(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-adapter-'));
  fs.writeFileSync(path.join(dir, 'memory.md'), body, 'utf8');
  return dir;
}

const MEMORY_MD = '# Memory\n\n## The first thing\n\nBudgets are set quarterly.\n\n## The second thing\n\nSales sits on floor two.\n';

/** A hand-wound clock that starts well past the quiet period of a just-written memory.md. */
function clock() {
  let t = Date.now() + 60 * 60_000;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const make = (url, bank = 'b1', home = '/tmp/home', now = clock(), mineTimeoutMs) =>
  new HindsightAdapter(() => ({ url, bank }), () => home, now, mineTimeoutMs);

/** Past the gap the miner leaves after any retain. */
const GAP = 31 * 60_000;

test('mining posts each memory section to the bank', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true, items_count: 2 } } });
  const result = await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');

  assert.equal(result.ok, true);
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0].url, '/v1/default/banks/b1/memories');
  assert.equal(s.seen[0].body.async, false);
  assert.equal(s.seen[0].body.items.length, 2);
  assert.match(s.seen[0].body.items[0].content, /Budgets are set quarterly/);
  assert.equal(s.seen[0].body.items[0].metadata.agent, 'pam');
  assert.equal(s.seen[0].body.items[0].metadata.heading, 'The first thing');
  assert.deepEqual(s.seen[0].body.items[0].tags, ['owner:pam']);
});

test('the first id a section gets is the one earlier builds gave it', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  const legacy = require('node:crypto').createHash('sha256')
    .update('pam\nThe first thing\nBudgets are set quarterly.').digest('hex').slice(0, 32);
  assert.equal(s.seen[0].body.items[0].document_id, legacy);
  const ids = s.seen[0].body.items.map((i) => i.document_id);
  assert.equal(new Set(ids).size, 2, 'distinct sections need distinct ids');
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('an unchanged memory is not sent again', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  now.advance(GAP);
  assert.deepEqual(await adapter.mineAgent(dir, 'pam'), { ok: true });
  assert.equal(s.seen.length, 1);
});

test('an edited section is resent alone, under the id it already had', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  fs.appendFileSync(path.join(dir, 'memory.md'), 'Lunch is at noon.\n');
  now.advance(GAP);
  await adapter.mineAgent(dir, 'pam');

  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[1].body.items.length, 1);
  assert.equal(s.seen[1].body.items[0].metadata.heading, 'The second thing');
  assert.equal(s.seen[1].body.items[0].document_id, s.seen[0].body.items[1].document_id);
});

test('mining a different agent id produces different document ids', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  now.advance(GAP);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');

  assert.notDeepEqual(
    s.seen[0].body.items.map((i) => i.document_id),
    s.seen[1].body.items.map((i) => i.document_id)
  );
});

test('a second retain waits until the server has had its rest', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.deepEqual(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim'), { ok: false });
  assert.equal(s.seen.length, 1);
  now.advance(31_000);
  assert.deepEqual(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim'), { ok: true });
  assert.equal(s.seen.length, 2);
});

test('a memory.md still being written is left until it goes quiet', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const result = await make(s.url, 'b1', '/tmp/home', Date.now).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.deepEqual(result, { ok: false });
  assert.equal(s.seen.length, 0);
});

test('a big memory drains a few sections per retain', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const big = Array.from({ length: 11 }, (_, i) => `## Note ${i}\n\nFact ${i}.\n`).join('\n');
  const dir = agentDirWith(big);
  assert.deepEqual(await adapter.mineAgent(dir, 'pam'), { ok: false });
  now.advance(GAP);
  assert.deepEqual(await adapter.mineAgent(dir, 'pam'), { ok: true });
  assert.deepEqual(s.seen.map((r) => r.body.items.length), [8, 3]);
});

test('a retain that times out is not resent, and the server is left alone', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': () => new Promise(() => {}) });
  t.after(() => s.server.closeAllConnections());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now, 50);
  const dir = agentDirWith(MEMORY_MD);
  assert.deepEqual(await adapter.mineAgent(dir, 'pam'), { ok: false });
  now.advance(GAP - 2 * 60_000);
  assert.deepEqual(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim'), { ok: false }, 'still backing off');
  now.advance(4 * 60_000);
  assert.deepEqual(await adapter.mineAgent(dir, 'pam'), { ok: true }, 'the timed-out batch counts as sent');
  assert.equal(s.seen.length, 1);
});

test('what was sent survives a restart of the app', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-home-'));
  fs.mkdirSync(path.join(home, 'hive', 'agents'), { recursive: true });
  const now = clock();
  const dir = agentDirWith(MEMORY_MD);
  await make(s.url, 'b1', home, now).mineAgent(dir, 'pam');
  assert.equal((await make(s.url, 'b1', home, now).mineAgent(dir, 'pam')).ok, false, 'the restarted app waits out the gap');
  now.advance(GAP);
  assert.deepEqual(await make(s.url, 'b1', home, now).mineAgent(dir, 'pam'), { ok: true });
  assert.equal(s.seen.length, 1);
  assert.ok(fs.existsSync(path.join(home, 'hive', '.hindsight-retained.json')));
});

test('mining reports failure instead of throwing when the server is gone', async (t) => {
  const s = await stub(t, {});
  await s.close();
  const result = await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.deepEqual(result, { ok: false });
});

test('mining reports failure when the server rejects the write', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { status: 500, json: { detail: 'nope' } } });
  const result = await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.equal(result.ok, false);
});

test('search recalls from the bank and renders text with its score', async (t) => {
  const s = await stub(t, {
    'POST /v1/default/banks/b1/memories/recall': {
      json: { results: [{ text: 'Budgets are set quarterly.', scores: { final: 0.91 } }] }
    }
  });
  const result = await make(s.url).search('budget', { agentId: 'pam', results: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.output, '— Budgets are set quarterly.  (score 0.91)');
  assert.equal(s.seen[0].url, '/v1/default/banks/b1/memories/recall');
  assert.equal(s.seen[0].body.query, 'budget');
  assert.deepEqual(s.seen[0].body.tags, ['owner:pam']);
  assert.equal(typeof s.seen[0].body.max_tokens, 'number');
  assert.equal('top_k' in s.seen[0].body, false, 'recall has no top_k; the budget is max_tokens');
});

test('wake-up recalls recent context and reports failure when the server is down', async (t) => {
  const s = await stub(t, {
    'POST /v1/default/banks/b1/memories/recall': { json: { results: [{ text: 'Sales sits on floor two.', scores: { final: 0.5 } }] } }
  });
  const adapter = make(s.url);
  const up = await adapter.wakeUp('pam');
  assert.equal(up.ok, true);
  assert.match(up.output, /Sales sits on floor two\./);
  assert.equal(typeof s.seen[0].body.query, 'string');
  assert.ok(s.seen[0].body.query.length > 0);

  await s.close();
  const down = await adapter.wakeUp('pam');
  assert.equal(down.ok, false);
  assert.equal(down.output, '');
  assert.ok(down.error);
});

test('availability follows the health endpoint once the cache expires', async (t) => {
  let clock = 1_000_000;
  const s = await stub(t, { 'GET /health': { json: { status: 'ok' } } });
  const adapter = make(s.url, 'b1', '/tmp/home', () => clock);

  assert.equal(await adapter.probeHealth(), true);
  assert.equal(adapter.available(), true);

  await s.close();
  assert.equal(adapter.available(), true, 'still cached');

  clock += 31_000;
  adapter.available();
  assert.equal(await adapter.probeHealth(), false);
  assert.equal(adapter.available(), false);
});

test('agent env names the backend and its endpoint', async (t) => {
  const s = await stub(t, {});
  assert.deepEqual(make(s.url, 'b1').agentEnv(), {
    HIVE_MEMORY_BACKEND: 'hindsight',
    HINDSIGHT_URL: s.url,
    HINDSIGHT_BANK: 'b1'
  });
});

test('status reports the backend and the bank it points at, even with no home', async (t) => {
  const s = await stub(t, {});
  const status = make(s.url, 'b1').status(true, null);
  assert.equal(status.backend, 'hindsight');
  assert.equal(status.enabled, true);
  assert.equal(status.active, false, 'no home means not active');
  assert.match(status.location, /b1/);
  assert.equal(status.model, null);
  assert.equal(status.bin, null);
});

test('init creates the bank when the server has never heard of it', async (t) => {
  let created = false;
  const s = await stub(t, {
    'GET /health': { json: {} },
    'GET /v1/default/banks/b1/stats': () => (created ? { json: { bank_id: 'b1', total_nodes: 1 } } : { status: 404, json: {} }),
    'PUT /v1/default/banks/b1': () => { created = true; return { json: { bank_id: 'b1', name: 'b1' } }; }
  });
  const adapter = make(s.url, 'b1');
  await adapter.ready();

  assert.ok(s.seen.some((r) => r.method === 'PUT' && r.url === '/v1/default/banks/b1'));
  assert.equal(adapter.status(true, '/tmp/home').initialized, true);
});

test('init does not recreate a bank that already exists', async (t) => {
  const s = await stub(t, {
    'GET /health': { json: {} },
    'GET /v1/default/banks/b1/stats': { json: { bank_id: 'b1', total_nodes: 7 } }
  });
  const adapter = make(s.url, 'b1');
  await adapter.ready();

  assert.equal(s.seen.filter((r) => r.method === 'PUT').length, 0);
  assert.equal(adapter.status(true, '/tmp/home').initialized, true);
});

test('the mempalace-only post-mine pass is absent', async (t) => {
  const s = await stub(t, {});
  assert.equal(make(s.url).postMinePass, undefined);
});

// ─── Test-connection probe (what the settings panel's button calls) ──────────

const { testHindsightConnection } = loadTs('src/main/hindsightAdapter.ts');

test('a reachable bank reports how much it is holding', async (t) => {
  const s = await stub(t, {
    'GET /health': { json: { status: 'ok' } },
    'GET /v1/default/banks/b1/stats': { json: { bank_id: 'b1', total_nodes: 42 } }
  });
  const result = await testHindsightConnection(s.url, 'b1');
  assert.equal(result.ok, true);
  assert.match(result.detail, /42/);
  assert.equal(result.url, s.url, 'the answer names the endpoint it actually reached');
  assert.equal(result.bank, 'b1');
});

test('a server that is up but has no such bank is reported as not ready', async (t) => {
  const s = await stub(t, { 'GET /health': { json: {} } });
  const result = await testHindsightConnection(s.url, 'nope');
  assert.equal(result.ok, false);
  assert.match(result.detail, /nope/);
});

test('an unreachable server is reported, not thrown', async (t) => {
  const s = await stub(t, {});
  await s.close();
  const result = await testHindsightConnection(s.url, 'b1');
  assert.equal(result.ok, false);
  assert.ok(result.detail.length > 0);
});

test('an empty address is refused without a network call', async () => {
  for (const [url, bank] of [['', 'b1'], ['http://x', ''], ['   ', '   ']]) {
    const result = await testHindsightConnection(url, bank);
    assert.equal(result.ok, false, `for ${JSON.stringify([url, bank])}`);
    assert.match(result.detail, /address|bank/i);
  }
});
