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
      // A key ending in `*` matches any path that starts with it.
      const route = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
      if (!route) { res.statusCode = 404; res.end('{}'); return; }
      // A route may answer with a promise; one that never settles plays a server that hangs.
      void Promise.resolve(typeof route === 'function' ? route(entry, res) : route).then((reply) => {
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

/** A fresh folder of the app's own for the retain ledger. */
function ledgerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-ledger-'));
}

const make = (url, bank = 'b1', home = '/tmp/home', now = clock(), dir = ledgerDir()) =>
  new HindsightAdapter(() => ({ url, bank }), () => home, now, () => dir);

const RETAIN = 'POST /v1/default/banks/b1/memories';
const OPERATION = 'GET /v1/default/banks/b1/operations/*';
/** A server that takes every retain and reports each operation as `status`. */
const server = (status = 'completed') => ({ [RETAIN]: { json: { success: true, async: true } }, [OPERATION]: { json: { status } } });
const retains = (s) => s.seen.filter((r) => r.method === 'POST' && r.url.endsWith('/memories'));
/** Past the rest the miner leaves after any retain, and the status poll interval. */
const PASS = 10 * 60_000;
/** The verdict of a mine call, without its backlog count. */
const brief = ({ ok, sent }) => (sent ? { ok, sent } : { ok });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('mining posts each memory section to the bank as an async retain under an operation id', async (t) => {
  const s = await stub(t, server());
  const result = await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');

  assert.deepEqual(brief(result), { ok: true, sent: true });
  const [post] = retains(s);
  assert.equal(post.url, '/v1/default/banks/b1/memories');
  assert.equal(post.body.async, true);
  assert.match(post.body.operation_id, UUID);
  assert.equal(post.body.items.length, 2);
  assert.match(post.body.items[0].content, /Budgets are set quarterly/);
  assert.equal(post.body.items[0].metadata.agent, 'pam');
  assert.equal(post.body.items[0].metadata.heading, 'The first thing');
  assert.deepEqual(post.body.items[0].tags, ['owner:pam']);
  assert.equal(s.seen[1].url, `/v1/default/banks/b1/operations/${post.body.operation_id}`, 'the outcome is asked for, not assumed');
});

test('the first id a section gets is the one earlier builds gave it', async (t) => {
  const s = await stub(t, server());
  await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  const legacy = require('node:crypto').createHash('sha256')
    .update('pam\nThe first thing\nBudgets are set quarterly.').digest('hex').slice(0, 32);
  const ids = retains(s)[0].body.items.map((i) => i.document_id);
  assert.equal(ids[0], legacy);
  assert.equal(new Set(ids).size, 2, 'distinct sections need distinct ids');
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('an unchanged memory is not sent again', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: true });
  assert.equal(retains(s).length, 1);
});

test('an edited section is resent alone, under the id it already had', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  fs.appendFileSync(path.join(dir, 'memory.md'), 'Lunch is at noon.\n');
  now.advance(PASS);
  await adapter.mineAgent(dir, 'pam');

  const [first, second] = retains(s);
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.items[0].metadata.heading, 'The second thing');
  assert.equal(second.body.items[0].document_id, first.body.items[1].document_id);
});

test('mining a different agent id produces different document ids', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  now.advance(PASS);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');

  const [pam, jim] = retains(s);
  assert.notDeepEqual(pam.body.items.map((i) => i.document_id), jim.body.items.map((i) => i.document_id));
});

test('a second retain waits until the server has had its rest', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim')), { ok: false });
  now.advance(31_000);
  assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim')), { ok: true, sent: true });
  assert.equal(retains(s).length, 2);
});

test('a memory.md still being written is left until it goes quiet', async (t) => {
  const s = await stub(t, server());
  const result = await make(s.url, 'b1', '/tmp/home', Date.now).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.deepEqual(brief(result), { ok: false });
  assert.equal(s.seen.length, 0);
});

test('a big memory drains a few sections per retain', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const big = Array.from({ length: 11 }, (_, i) => `## Note ${i}\n\nFact ${i}.\n`).join('\n');
  const dir = agentDirWith(big);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false, sent: true });
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: true, sent: true });
  assert.deepEqual(retains(s).map((r) => r.body.items.length), [8, 3]);
});

// ─── The open retain: one at a time, freed only by the server's word ───────

test('while the server is still working, nothing else is sent, however long it takes', async (t) => {
  const s = await stub(t, server('processing'));
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false, sent: true });
  for (let pass = 0; pass < 12; pass++) {
    now.advance(PASS); // two hours, far past the 12–42 min jobs seen on the floor
    assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim')), { ok: false });
  }
  assert.equal(retains(s).length, 1);
});

test('a restarted app finds the open retain on disk and asks about it instead of sending', async (t) => {
  const s = await stub(t, server('processing'));
  const now = clock();
  const dir = ledgerDir();
  await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  const op = retains(s)[0].body.operation_id;
  now.advance(PASS);
  const restarted = make(s.url, 'b1', '/tmp/home', now, dir);
  assert.deepEqual(brief(await restarted.mineAgent(agentDirWith(MEMORY_MD), 'jim')), { ok: false });
  assert.equal(retains(s).length, 1, 'two app instances never have two retains open');
  assert.ok(s.seen.some((r) => r.url.endsWith(`/operations/${op}`)));
});

test('a retain whose claim cannot be written is not sent', async (t) => {
  const s = await stub(t, server());
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-ledger-'));
  const blocked = path.join(parent, 'not-a-folder');
  fs.writeFileSync(blocked, 'a file where the ledger folder should be');
  const now = clock();
  for (const adapter of [make(s.url, 'b1', '/tmp/home', now, blocked), make(s.url, 'b1', '/tmp/home', now, blocked)]) {
    assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false });
  }
  assert.equal(s.seen.length, 0);
});

test('without a ledger folder the miner sends nothing', async (t) => {
  const s = await stub(t, server());
  const adapter = new HindsightAdapter(() => ({ url: s.url, bank: 'b1' }), () => '/tmp/home', clock());
  assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false });
  assert.equal(s.seen.length, 0);
});

test('a retain with no answer is held open, not recorded, until the server is asked', async (t) => {
  let retainMode = 'reset';
  let operation = 'processing';
  const s = await stub(t, {
    // The connection drops after the server read the request: it may or may not be working on it.
    [RETAIN]: (_entry, res) => {
      if (retainMode === 'ok') return { json: { success: true } };
      res.socket.destroy();
      return new Promise(() => {});
    },
    [OPERATION]: () => ({ json: { status: operation } })
  });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false, sent: true });
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false }, 'no resend inside the poll interval');

  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false }, 'the server says it is working on it');
  assert.equal(retains(s).length, 1);

  // The server has no record of it: the same request goes again under the same id, never a new one.
  operation = 'not_found';
  retainMode = 'ok';
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false });
  const [first, second] = retains(s);
  assert.equal(second.body.operation_id, first.body.operation_id);
  assert.deepEqual(second.body.items, first.body.items);

  operation = 'completed';
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false }, 'the pass that hears "completed" records it');
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: true });
  assert.equal(retains(s).length, 2);
});

const DOCUMENT = 'GET /v1/default/banks/b1/documents/*';

test('an acknowledged retain the server has no record of, whose documents are missing, goes again under the same id', async (t) => {
  let operation = 'processing';
  const s = await stub(t, { [RETAIN]: { json: { success: true } }, [OPERATION]: () => ({ json: { status: operation } }), [DOCUMENT]: { status: 404, json: { detail: 'Document not found' } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  operation = 'not_found';
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false });
  const [first, second] = retains(s);
  assert.equal(second.body.operation_id, first.body.operation_id);
  assert.deepEqual(second.body.items, first.body.items);
  assert.ok(s.seen.some((r) => r.url.startsWith('/v1/default/banks/b1/documents/')), 'the documents were asked about first');
});

test('a pruned operation whose documents hold the claimed text is recorded, not sent again', async (t) => {
  let operation = 'processing';
  const texts = new Map();
  const s = await stub(t, {
    [RETAIN]: (entry) => { for (const i of entry.body.items) texts.set(i.document_id, i.content); return { json: { success: true } }; },
    [OPERATION]: () => ({ json: { status: operation } }),
    [DOCUMENT]: (entry) => ({ json: { original_text: texts.get(entry.url.split('/').pop()) } })
  });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  operation = 'not_found';
  now.advance(PASS);
  await adapter.mineAgent(dir, 'pam');
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: true }, 'recorded as retained');
  assert.equal(retains(s).length, 1);
});

test('a pruned operation whose documents hold other text is sent again under the same id', async (t) => {
  let operation = 'processing';
  const s = await stub(t, { [RETAIN]: { json: { success: true } }, [OPERATION]: () => ({ json: { status: operation } }), [DOCUMENT]: { json: { original_text: 'older text' } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(dir, 'pam');
  operation = 'not_found';
  now.advance(PASS);
  await adapter.mineAgent(dir, 'pam');
  const [first, second] = retains(s);
  assert.equal(second.body.operation_id, first.body.operation_id);
});

test('status reads that keep failing hold the slot, are logged once, and end only in a cancel the server confirms', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  let readable = false;
  let cancelled = false;
  const s = await stub(t, {
    [RETAIN]: { json: { success: true } },
    [OPERATION]: () => (readable ? { json: { status: cancelled ? 'cancelled' : 'processing' } } : { status: 500, json: {} }),
    'DELETE /v1/default/banks/b1/operations/*': () => { cancelled = true; return { json: {} }; }
  });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  for (let pass = 0; pass < 36; pass++) { // six hours of unreadable answers
    now.advance(PASS);
    await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  }
  const lines = warn.mock.calls.map((c) => c.arguments[0]);
  assert.equal(lines.filter((m) => /reports unreadable \(HTTP 500\)/.test(m)).length, 1, 'the same poll outcome is logged once');
  assert.ok(lines.some((m) => /still open \(unreadable \(HTTP 500\)\) after \d+ min/.test(m)), 'an old claim is logged with its age');
  assert.ok(s.seen.some((r) => r.method === 'DELETE'), 'no progress for two hours: cancelled on the server');
  assert.ok(lines.some((m) => /did not confirm the cancel/.test(m)));
  assert.equal(retains(s).length, 1, 'a cancel that cannot be confirmed keeps the slot held');

  readable = true;
  now.advance(PASS);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  now.advance(PASS);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  assert.equal(retains(s).length, 2, 'once the server confirms the cancel, the slot frees');
});

test('an unknown status counts as unreadable: the slot stays held', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  const s = await stub(t, { [RETAIN]: { json: { success: true } }, [OPERATION]: { json: { status: 'mystery' } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  for (let pass = 0; pass < 6; pass++) {
    now.advance(PASS);
    assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim')), { ok: false });
  }
  assert.equal(retains(s).length, 1);
});

/** A server whose one operation stays `processing` with the same updated_at, and that may or may not honour a cancel. */
function strandedServer({ honoursCancel }) {
  const cancelled = new Set();
  const opOf = (entry) => entry.url.split('/').pop();
  return {
    routes: {
      [RETAIN]: { json: { success: true } },
      [OPERATION]: (entry) => ({ json: { status: cancelled.has(opOf(entry)) ? 'cancelled' : 'processing', updated_at: '2026-11-13T02:00:00Z' } }),
      'DELETE /v1/default/banks/b1/operations/*': (entry) => { if (honoursCancel) cancelled.add(opOf(entry)); return { json: { success: honoursCancel } }; }
    }
  };
}

test('a stranded operation is cancelled after two hours without change, and the slot frees only on the server\'s word', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const s = await stub(t, strandedServer({ honoursCancel: false }).routes);
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  for (let pass = 0; pass < 300; pass++) { // 50 hours of 10-minute passes
    now.advance(PASS);
    await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  }
  assert.equal(retains(s).length, 1, 'a cancel the server does not confirm keeps the slot held');
  assert.ok(s.seen.some((r) => r.method === 'DELETE'), 'the stranded operation is cancelled');
  const said = warn.mock.calls.map((c) => c.arguments[0]).join('\n');
  assert.match(said, /still open \(processing\) after \d+ min/);
  assert.match(said, /did not confirm the cancel/);
});

test('a stranded operation the server cancels frees the slot', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const s = await stub(t, strandedServer({ honoursCancel: true }).routes);
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  let deletes = 0;
  for (let pass = 0; pass < 11; pass++) { // 110 min: not yet
    now.advance(PASS);
    await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  }
  deletes = s.seen.filter((r) => r.method === 'DELETE').length;
  assert.equal(deletes, 0, 'not cancelled before two hours without change');
  now.advance(PASS);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  assert.equal(s.seen.filter((r) => r.method === 'DELETE').length, 1);
  now.advance(PASS);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  assert.equal(retains(s).length, 2, 'after the confirmed cancel the next retain goes');
});

test('a slow operation that keeps moving is never cancelled', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let tick = 0;
  const s = await stub(t, {
    [RETAIN]: { json: { success: true } },
    [OPERATION]: () => ({ json: { status: 'processing', updated_at: `2026-11-13T02:${String(tick++ % 60).padStart(2, '0')}:00Z` } })
  });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
  for (let pass = 0; pass < 30; pass++) {
    now.advance(PASS);
    await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim');
  }
  assert.equal(s.seen.filter((r) => r.method === 'DELETE').length, 0);
  assert.equal(retains(s).length, 1);
});

test('a refusal the server repeats backs off and is logged once', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const s = await stub(t, { [RETAIN]: { status: 422, json: { detail: 'bad item' } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  for (let pass = 0; pass < 18; pass++) { // three hours of passes
    await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam');
    now.advance(PASS);
  }
  assert.ok(retains(s).length <= 5, `sent ${retains(s).length} times in three hours`);
  assert.equal(error.mock.calls.filter((c) => /HTTP 422/.test(c.arguments[0])).length, 1);
});

test('only a completed operation records its sections; a failed one sends them again', async (t) => {
  let operation = 'failed';
  const s = await stub(t, { [RETAIN]: { json: { success: true } }, [OPERATION]: () => ({ json: { status: operation, error_message: 'model fell over' } }) });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(MEMORY_MD);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: false, sent: true });
  now.advance(PASS);
  operation = 'completed';
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: true, sent: true });
  assert.equal(retains(s).length, 2);
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(dir, 'pam')), { ok: true });
  assert.equal(retains(s).length, 2);
});

test('a server error leaves the outcome unknown; a refused connection frees the slot', async (t) => {
  const s = await stub(t, { [RETAIN]: { status: 503 }, [OPERATION]: { json: { status: 'processing' } } });
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false, sent: true });
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim')), { ok: false });
  assert.equal(retains(s).length, 1, 'a 503 may have been taken: no resend while the server says it is working');

  const gone = await stub(t, {});
  await gone.close();
  const fresh = make(gone.url, 'b1', '/tmp/home', now);
  assert.deepEqual(brief(await fresh.mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false, sent: true });
  now.advance(PASS);
  assert.deepEqual(brief(await fresh.mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false, sent: true }, 'never sent, so free to try again');
});

// ─── The ledger is the app's, and nothing in it is taken on trust ──────────

const ledgerFile = (dir) => path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('retained-')));

test('a forged document id in the ledger is refused, not sent', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const dir = ledgerDir();
  const agent = agentDirWith(MEMORY_MD);
  await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
  const file = ledgerFile(dir);
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = Object.keys(ledger.sections)[0];
  ledger.sections[key] = { id: 'victim-document', hash: '0'.repeat(64) };
  fs.writeFileSync(file, JSON.stringify(ledger));
  now.advance(PASS);
  await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
  const ids = retains(s).flatMap((r) => r.body.items.map((i) => i.document_id));
  assert.ok(!ids.includes('victim-document'));
});

test('a malformed ledger is treated as empty without throwing', async (t) => {
  for (const bad of ['{', 'null', '{"v":1,"server":"x","busyUntil":0,"sections":7,"claim":null}', JSON.stringify({ v: 1, sections: { a: 'b' } })]) {
    const s = await stub(t, server());
    const dir = ledgerDir();
    const agent = agentDirWith(MEMORY_MD);
    const now = clock();
    await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
    fs.writeFileSync(ledgerFile(dir), bad);
    now.advance(PASS);
    const result = await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
    assert.equal(result.sent, true, `ledger ${bad} counts as empty`);
  }
});

test('a ledger that is a link is neither read nor written through', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const dir = ledgerDir();
  const agent = agentDirWith(MEMORY_MD);
  await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
  const file = ledgerFile(dir);
  const victim = path.join(ledgerDir(), 'owner-file');
  fs.writeFileSync(victim, 'precious');
  fs.rmSync(file);
  fs.symlinkSync(victim, file);
  fs.appendFileSync(path.join(agent, 'memory.md'), 'More.\n');
  now.advance(PASS);
  assert.deepEqual(brief(await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam')), { ok: false });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.equal(retains(s).length, 1, 'with no safe place for the claim, nothing is sent');
});

test('a ledger folder that is a link is refused', async (t) => {
  const s = await stub(t, server());
  const real = ledgerDir();
  const link = path.join(ledgerDir(), 'ledger');
  fs.symlinkSync(real, link);
  assert.deepEqual(brief(await make(s.url, 'b1', '/tmp/home', clock(), link).mineAgent(agentDirWith(MEMORY_MD), 'pam')), { ok: false });
  assert.equal(s.seen.length, 0);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('an oversized ledger is refused, not parsed', async (t) => {
  const s = await stub(t, server());
  const now = clock();
  const dir = ledgerDir();
  const agent = agentDirWith(MEMORY_MD);
  await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
  fs.writeFileSync(ledgerFile(dir), ' '.repeat(4 * 1024 * 1024 + 1));
  now.advance(PASS);
  assert.equal((await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam')).sent, true);
});

test('the ledger folder is private to this user', async (t) => {
  const s = await stub(t, server());
  const dir = path.join(ledgerDir(), 'made-here');
  await make(s.url, 'b1', '/tmp/home', clock(), dir).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(ledgerFile(dir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
});

test('another bank, or another server, starts from an empty ledger', async (t) => {
  const s = await stub(t, { ...server(), 'POST /v1/default/banks/b2/memories': { json: { success: true } }, 'GET /v1/default/banks/b2/operations/*': { json: { status: 'completed' } } });
  const now = clock();
  const dir = ledgerDir();
  const cfg = { url: s.url, bank: 'b1' };
  const adapter = new HindsightAdapter(() => cfg, () => '/tmp/home', now, () => dir);
  const agent = agentDirWith(MEMORY_MD);
  await adapter.mineAgent(agent, 'pam');
  cfg.bank = 'b2';
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(agent, 'pam')), { ok: true, sent: true });
  assert.equal(s.seen.filter((r) => r.url === '/v1/default/banks/b2/memories').length, 1);
  cfg.url = `${s.url}/`;
  cfg.bank = 'b1';
  now.advance(PASS);
  assert.deepEqual(brief(await adapter.mineAgent(agent, 'pam')), { ok: true }, 'the same server spelled with a slash is the same ledger');
});

test('the backlog says how many sections are still waiting', async (t) => {
  const s = await stub(t, server('processing'));
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const big = Array.from({ length: 11 }, (_, i) => `## Note ${i}\n\nFact ${i}.\n`).join('\n');
  assert.equal((await adapter.mineAgent(agentDirWith(big), 'pam')).backlog, 11, 'nothing counts until the server confirms it');
  assert.equal((await adapter.mineAgent(agentDirWith(MEMORY_MD), 'jim')).backlog, 2);
});

// ─── What the ledger writes, it can read back ───────────────────────────────

const LIMIT = 256 * 1024;

test('a section over the claim limit is left out and logged once; the rest still go', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const s = await stub(t, server());
  const now = clock();
  const adapter = make(s.url, 'b1', '/tmp/home', now);
  const dir = agentDirWith(`## Huge\n\n${'x'.repeat(LIMIT + 1)}\n\n## Small\n\nA fact.\n`);
  await adapter.mineAgent(dir, 'pam');
  fs.appendFileSync(path.join(dir, 'memory.md'), 'Another fact.\n');
  now.advance(PASS);
  await adapter.mineAgent(dir, 'pam');

  const sent = retains(s).flatMap((r) => r.body.items.map((i) => i.metadata.heading));
  assert.deepEqual(sent, ['Small', 'Small']);
  const said = warn.mock.calls.map((c) => c.arguments[0]).filter((m) => /Huge/.test(m));
  assert.equal(said.length, 1);
  assert.match(said[0], /pam/);
  assert.match(said[0], new RegExp(String(LIMIT + 1)));
});

test('a restart during the claim of a section at the limit reads the claim back and does not resend', async (t) => {
  const s = await stub(t, server('processing'));
  const now = clock();
  const dir = ledgerDir();
  const agent = agentDirWith(`## Big\n\n${'y'.repeat(LIMIT)}\n`);
  await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam');
  now.advance(PASS);
  assert.deepEqual(brief(await make(s.url, 'b1', '/tmp/home', now, dir).mineAgent(agent, 'pam')), { ok: false });
  assert.equal(retains(s).length, 1);
});

test('save never writes a ledger that load would refuse, and keeps the previous file', async () => {
  const { RetainLedger, emptyLedger } = loadTs('src/main/hindsightLedger.ts');
  const dir = ledgerDir();
  const ledger = new RetainLedger(dir);
  const server = 'http://h\nb1';
  const sha = (x) => require('node:crypto').createHash('sha256').update(x).digest('hex');
  const item = (content, heading = 'h') => ({ key: `pam\n${heading}\n0`, id: 'a'.repeat(32), hash: sha(content), agent: 'pam', heading, content });
  const claim = (items) => ({ op: '6f1c1a8e-1b2c-4d3e-8f90-123456789abc', since: 1, items, acked: false, seen: '', changedAt: 1 });
  const good = [
    emptyLedger(server),
    { ...emptyLedger(server), sections: { 'pam\nh\n0': { id: 'b'.repeat(32), hash: 'c'.repeat(64) } } },
    { ...emptyLedger(server), claim: claim([item('z'.repeat(LIMIT))]) },
    { ...emptyLedger(server), claim: claim([item('q', 'k'.repeat(1024 - 'pam\n\n0'.length))]) }
  ];
  for (const state of good) {
    assert.equal(await ledger.save(state), true);
    assert.deepEqual(await ledger.load(server), state, 'what save wrote, load reads back unchanged');
  }
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('retained-')));
  const before = fs.readFileSync(file, 'utf8');
  const err = console.error;
  console.error = () => {};
  try {
    const bad = [
      { ...emptyLedger(server), claim: claim([item('z'.repeat(LIMIT + 1))]) },
      { ...emptyLedger(server), claim: claim([{ ...item('q'), hash: 'd'.repeat(64) }]) },
      { ...emptyLedger(server), sections: { ['k'.repeat(1025)]: { id: 'b'.repeat(32), hash: 'c'.repeat(64) } } },
      { ...emptyLedger(server), claim: { ...claim([item('q')]), seen: 's'.repeat(257) } }
    ];
    for (const state of bad) assert.equal(await ledger.save(state), false);
  } finally {
    console.error = err;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the previous ledger is kept');
});

test('the retain path does no synchronous file I/O', () => {
  for (const file of ['src/main/hindsightLedger.ts', 'src/main/hindsightAdapter.ts']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(text, /\b[a-zA-Z]+Sync\(/, `${file} must not block the main process`);
  }
});

test('mining reports failure instead of throwing when the server is gone', async (t) => {
  const s = await stub(t, {});
  await s.close();
  const result = await make(s.url).mineAgent(agentDirWith(MEMORY_MD), 'pam');
  assert.equal(result.ok, false);
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
