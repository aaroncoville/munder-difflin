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
