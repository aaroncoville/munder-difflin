'use strict';
/**
 * An agent owns its outbox, so its outbox/.sent can be anything, including a link to a folder
 * elsewhere. The router files every routed or refused message there, and a link would make it
 * create the sender's file wherever the link points. The router now files only into a real folder:
 * anything else at .sent is set aside under another name and a real folder made in its place.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const { moveWithoutReplacing } = loadTs('src/main/outboxFailure.ts');
const { RecentSends } = loadTs('src/main/outboxResend.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sent-link-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  const outbox = path.join(home, 'hive', 'agents', 'worker-1', 'outbox');
  const sent = path.join(outbox, '.sent');
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  let n = 0;
  const post = (msg) => {
    fs.writeFileSync(path.join(outbox, `m-${n++}.json`), JSON.stringify(msg));
    return hive.routeOnce();
  };
  const log = () => fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const linkSent = () => { fs.rmSync(sent, { recursive: true, force: true }); fs.symlinkSync(elsewhere, sent); };
  const setAside = () => fs.readdirSync(outbox).filter((f) => f.startsWith('.sent.'));
  return { home, hive, outbox, sent, elsewhere, post, log, linkSent, setAside };
}

const msg = { to: 'god', act: 'inform', subject: 'hello', body: 'b' };

test('a message is filed in a real .sent, never in the folder a linked .sent points to', async (t) => {
  const f = await floor(t);
  f.linkSent();
  assert.equal(f.post(msg), 1);
  assert.equal(f.hive.inbox('god-1').filter((m) => m.subject === 'hello').length, 1, 'still delivered');
  assert.deepEqual(fs.readdirSync(f.elsewhere), [], 'nothing created through the link');
  assert.ok(fs.lstatSync(f.sent).isDirectory(), '.sent is a real folder again');
  assert.deepEqual(fs.readdirSync(f.sent).filter((x) => x.endsWith('.json')), ['m-0.json']);
  assert.deepEqual(fs.readdirSync(f.outbox).filter((x) => x.endsWith('.json')), [], 'the outbox is empty');
  const aside = f.setAside();
  assert.equal(aside.length, 1);
  assert.ok(fs.lstatSync(path.join(f.outbox, aside[0])).isSymbolicLink(), 'the link is kept, under another name');
  const row = f.log().find((r) => r.kind === 'sent-folder-set-aside');
  assert.ok(row, 'and logged');
  assert.equal(row.from, 'worker-1');
  assert.equal(row.aside, aside[0]);
});

test('a .sent that is a file is set aside with its content, and the message filed in a real folder', async (t) => {
  const f = await floor(t);
  fs.rmSync(f.sent, { recursive: true, force: true });
  fs.writeFileSync(f.sent, 'kept');
  assert.equal(f.post(msg), 1);
  assert.ok(fs.lstatSync(f.sent).isDirectory());
  assert.deepEqual(fs.readdirSync(f.sent).filter((x) => x.endsWith('.json')), ['m-0.json']);
  const aside = f.setAside();
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(f.outbox, aside[0]), 'utf8'), 'kept');
});

test('a message refused through a linked .sent is set aside in a real .sent, not through the link', async (t) => {
  const f = await floor(t);
  f.linkSent();
  assert.equal(f.post({ ...msg, to: 'nobody-here' }), 0);
  assert.deepEqual(fs.readdirSync(f.elsewhere), []);
  assert.deepEqual(fs.readdirSync(f.sent).filter((x) => x.endsWith('.json')), ['bad-m-0.json']);
});

test('a real .sent is left alone and nothing is logged', async (t) => {
  const f = await floor(t);
  f.post(msg);
  f.post({ ...msg, body: 'again' });
  assert.deepEqual(f.setAside(), []);
  assert.equal(f.log().some((r) => r.kind === 'sent-folder-set-aside'), false);
});

test('a move into a folder that is a link is refused, and the file stays where it was', async (t) => {
  const f = await floor(t);
  f.linkSent();
  const source = path.join(f.outbox, 'm.json');
  fs.writeFileSync(source, '{}');
  assert.throws(() => moveWithoutReplacing(source, f.sent, (n) => (n === 0 ? 'm.json' : `${n}-m.json`)));
  assert.ok(fs.existsSync(source));
  assert.deepEqual(fs.readdirSync(f.elsewhere), []);
});

test('a linked .sent is not read back to recall what was sent', async (t) => {
  const f = await floor(t);
  fs.writeFileSync(path.join(f.elsewhere, 'm.json'), JSON.stringify(msg));
  f.linkSent();
  assert.equal(new RecentSends().isRepeat({ ...msg, from: 'worker-1' }, f.sent, Date.now()), false);
});

test('rewriting a filed copy refuses a .sent that is a link', async (t) => {
  const f = await floor(t);
  const { stampSentCopy } = loadTs('src/main/sentStamp.ts');
  fs.writeFileSync(path.join(f.elsewhere, 'm.json'), 'keep me');
  f.linkSent();
  assert.equal(stampSentCopy(f.sent, 'm.json', msg), 'refused');
  assert.equal(fs.readFileSync(path.join(f.elsewhere, 'm.json'), 'utf8'), 'keep me');
});
