'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const SHIM = require.resolve('../resources/hive-memory.cjs');

const runShim = (env, args = ['search', 'anything']) => new Promise((resolve, reject) => {
  execFile(process.execPath, [SHIM, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve(stdout);
  });
});

test('unknown memory backend degrades without failing the agent', () => {
  const out = execFileSync(process.execPath, [SHIM, 'search', 'anything'], { env: { ...process.env, HIVE_MEMORY_BACKEND: 'missing' }, encoding: 'utf8' });
  assert.match(out, /memory recall unavailable — continue without it/);
});

test('mempalace search passes its arguments through', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-memory-'));
  const fake = path.join(dir, 'mempalace'); fs.writeFileSync(fake, '#!/bin/sh\necho "$@"\n'); fs.chmodSync(fake, 0o755);
  const out = execFileSync(process.execPath, [SHIM, 'search', 'q', '--results', '3'], { env: { ...process.env, HIVE_MEMORY_BACKEND: 'mempalace', PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.match(out, /search q --results 3/);
});

test('hindsight search renders recalled text and score', async (t) => {
  let request;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/default/banks/test-bank/memories/recall') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      request = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ text: 'A useful memory', score: 0.91 }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const out = await runShim({
    HIVE_MEMORY_BACKEND: 'hindsight',
    HINDSIGHT_URL: `http://127.0.0.1:${port}`,
    HINDSIGHT_BANK: 'test-bank'
  }, ['search', 'budget']);

  assert.equal(request.query, 'budget');
  assert.match(out, /A useful memory/);
  assert.match(out, /\(score 0\.91\)/);
});

test('unreachable hindsight degrades to the one-line fallback', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const out = await runShim({
    HIVE_MEMORY_BACKEND: 'hindsight',
    HINDSIGHT_URL: `http://127.0.0.1:${port}`,
    HINDSIGHT_BANK: 'test-bank'
  });

  assert.equal(out, 'memory recall unavailable — continue without it\n');
});

// The recall response carries per-result scores in a `scores` object whose
// `final` member is the ranked value; a flat `score` is not part of the shape.
test('hindsight search renders the final score from the scores object', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/default/banks/test-bank/memories/recall') {
      res.statusCode = 404;
      res.end();
      return;
    }
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ text: 'A useful memory', scores: { final: 0.91, semantic: 0.42 } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const out = await runShim({
    HIVE_MEMORY_BACKEND: 'hindsight',
    HINDSIGHT_URL: `http://127.0.0.1:${port}`,
    HINDSIGHT_BANK: 'test-bank'
  }, ['search', 'budget']);

  assert.match(out, /A useful memory {2}\(score 0\.91\)/);
});

// A stub that answers the way the real recall endpoint does: it refuses a
// request whose max_tokens is not a positive integer with HTTP 422.
async function strictRecallBackend(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      seen.push(request);
      if (!Number.isInteger(request.max_tokens) || request.max_tokens < 1) {
        res.statusCode = 422;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ detail: [{ loc: ['body', 'max_tokens'], msg: 'Input should be a valid integer' }] }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ text: `recalled for ${request.query}`, score: 0.5 }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { HIVE_MEMORY_BACKEND: 'hindsight', HINDSIGHT_URL: `http://127.0.0.1:${server.address().port}`, HINDSIGHT_BANK: 'test-bank' };
  return { env, seen };
}

const runShimFull = (env, args) => new Promise((resolve) => {
  execFile(process.execPath, [SHIM, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

test('search without --results asks for the default five results', async (t) => {
  const { env, seen } = await strictRecallBackend(t);
  const out = await runShimFull(env, ['search', 'heartbeat suppression']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].query, 'heartbeat suppression');
  assert.equal(seen[0].max_tokens, 5 * 512);
  assert.match(out.stdout, /recalled for heartbeat suppression/);
  assert.equal(out.code, 0);
});

test('search with --results N asks for N results', async (t) => {
  const { env, seen } = await strictRecallBackend(t);
  const out = await runShimFull(env, ['search', 'budget', '--results', '3']);
  assert.equal(seen[0].query, 'budget');
  assert.equal(seen[0].max_tokens, 3 * 512);
  assert.match(out.stdout, /recalled for budget/);
});

test('search with a non-numeric --results is a usage error and sends nothing', async (t) => {
  const { env, seen } = await strictRecallBackend(t);
  for (const junk of [['--results', 'many'], ['--results', '0'], ['--results']]) {
    const out = await runShimFull(env, ['search', 'budget', ...junk]);
    assert.equal(out.code, 2, `exit code for ${junk.join(' ')}`);
    assert.match(out.stderr, /--results/);
  }
  assert.equal(seen.length, 0);
});

test('a refusal from the backend is reported on stderr, not as unavailable', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.statusCode = 422; res.end('{"detail":"bad request"}'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const out = await runShimFull({ HIVE_MEMORY_BACKEND: 'hindsight', HINDSIGHT_URL: `http://127.0.0.1:${server.address().port}`, HINDSIGHT_BANK: 'test-bank' }, ['search', 'budget']);
  assert.match(out.stderr, /HTTP 422/);
  assert.doesNotMatch(out.stdout, /memory recall unavailable/);
  assert.equal(out.code, 1);
});
