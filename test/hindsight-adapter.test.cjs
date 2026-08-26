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
      const reply = typeof route === 'function' ? route(entry) : route;
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply.json ?? {}));
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

const make = (url, bank = 'b1', home = '/tmp/home', now) =>
  new HindsightAdapter(() => ({ url, bank }), () => home, now);

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

test('mining the same memory twice sends the same document ids', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const adapter = make(s.url);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');

  assert.deepEqual(s.seen[0].body, s.seen[1].body);
  const ids = s.seen[0].body.items.map((i) => i.document_id);
  assert.equal(new Set(ids).size, 2, 'distinct sections need distinct ids');
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('mining a different agent id produces different document ids', async (t) => {
  const s = await stub(t, { 'POST /v1/default/banks/b1/memories': { json: { success: true } } });
  const adapter = make(s.url);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');

  assert.notDeepEqual(
    s.seen[0].body.items.map((i) => i.document_id),
    s.seen[1].body.items.map((i) => i.document_id)
  );
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
