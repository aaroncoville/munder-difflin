'use strict';

/**
 * The router polls outboxes, so it can read a message file while its sender is
 * still writing it. A half-written file must get a second read before it is
 * dropped, and a sender whose message is dropped must be told.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-retry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });
  const outbox = path.join(home, 'hive', 'agents', 'worker-1', 'outbox');
  return { hive, outbox };
}

const T0 = 1_000_000;
const FULL = JSON.stringify({ to: 'god', act: 'done', subject: 'verdict', body: 'approved' });
const HALF = FULL.slice(0, 20);

test('a file that becomes valid within 2 s is delivered', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'verdict.json');
  fs.writeFileSync(file, HALF);

  assert.equal(hive.routeOnce(T0), 0);
  assert.equal(fs.existsSync(file), true, 'the half-written file is left for the sender to finish');
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-verdict.json')), false);

  fs.writeFileSync(file, FULL);
  assert.equal(hive.routeOnce(T0 + 2_000), 1);
  assert.equal(hive.inbox('god-1')[0].body, 'approved');
  assert.equal(hive.inbox('worker-1').length, 0, 'no drop notice for a delivered message');
});

test('a file that stays invalid is dropped after 2 s with a notice to the sender', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'verdict.json');
  fs.writeFileSync(file, HALF);

  assert.equal(hive.routeOnce(T0), 0);
  assert.equal(hive.routeOnce(T0 + 1_999), 0);
  assert.equal(fs.existsSync(file), true, 'not dropped before 2 s have passed');

  assert.equal(hive.routeOnce(T0 + 2_000), 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-verdict.json')), true);
  assert.equal(hive.inbox('god-1').length, 0);

  const notices = hive.inbox('worker-1');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].from, 'router');
  assert.match(notices[0].body, /verdict\.json/);
});

test('a .tmp file is never read', async (t) => {
  const { hive, outbox } = await floor(t);
  fs.writeFileSync(path.join(outbox, 'verdict.json.tmp'), FULL);
  fs.writeFileSync(path.join(outbox, 'verdict.tmp'), FULL);

  assert.equal(hive.routeOnce(T0), 0);
  assert.equal(hive.routeOnce(T0 + 5_000), 0);
  assert.equal(fs.existsSync(path.join(outbox, 'verdict.json.tmp')), true);
  assert.equal(fs.existsSync(path.join(outbox, 'verdict.tmp')), true);
  assert.equal(hive.inbox('worker-1').length, 0);
});

test('a later file of the same name gets its own retry after a drop', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'verdict.json');
  fs.writeFileSync(file, HALF);
  hive.routeOnce(T0);
  hive.routeOnce(T0 + 2_000);
  assert.equal(fs.existsSync(file), false, 'the first file was dropped');

  fs.writeFileSync(file, HALF);
  hive.routeOnce(T0 + 10_000);
  assert.equal(fs.existsSync(file), true, 'the new file is not dropped on its first read');
  hive.routeOnce(T0 + 12_000);
  assert.equal(fs.existsSync(file), false);
});

test('a later file of the same name gets its own retry after a delivery', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'verdict.json');
  fs.writeFileSync(file, HALF);
  hive.routeOnce(T0);
  fs.writeFileSync(file, FULL);
  assert.equal(hive.routeOnce(T0 + 1_000), 1);

  fs.writeFileSync(file, HALF);
  hive.routeOnce(T0 + 10_000);
  assert.equal(fs.existsSync(file), true, 'the new file is not dropped on its first read');
});

test('a malformed file its sender removed does not mark a later file of the same name', async (t) => {
  const { hive, outbox } = await floor(t);
  const file = path.join(outbox, 'verdict.json');
  fs.writeFileSync(file, HALF);
  hive.routeOnce(T0);
  fs.rmSync(file); // the sender gave up on it and will write it again
  hive.routeOnce(T0 + 1_000);

  fs.writeFileSync(file, HALF);
  hive.routeOnce(T0 + 10_000);
  assert.equal(fs.existsSync(file), true, 'the new file is not dropped on its first read');
  fs.writeFileSync(file, FULL);
  assert.equal(hive.routeOnce(T0 + 11_000), 1);
  assert.equal(hive.inbox('worker-1').length, 0, 'no drop notice');
});
