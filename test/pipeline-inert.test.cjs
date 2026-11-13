'use strict';
// The pipeline ships inert: nothing in the app attaches a conductor yet, so every
// message to "pipeline" is refused and no agent is told about hive-mr. These tests
// hold that line until the conductor lands; the change that wires it must change them
// on purpose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const ROOT = path.join(__dirname, '..');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(c|m)?[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('nothing in the app attaches a conductor: setPipelineSink has no caller', () => {
  const callers = [];
  for (const file of [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'resources'))]) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes('setPipelineSink')) return;
      if (/^\s*setPipelineSink\(sink:/.test(line)) return; // the definition in hive.ts
      callers.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(callers, []);
});

test('the refusal with no conductor attached is still tested', () => {
  const router = fs.readFileSync(path.join(__dirname, 'pipeline-router.test.cjs'), 'utf8');
  assert.ok(router.includes("test('with no conductor attached, a message to the pipeline is refused to its sender, and god hears nothing'"));
});

test('a new floor has no hive-mr path and tells no agent about it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pipe-inert-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  assert.equal(hive.pipelineCli, null);
  const agent = await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  const brief = agent.args[agent.args.indexOf('--append-system-prompt') + 1];
  assert.ok(typeof brief === 'string' && brief.length > 100, 'the brief was found');
  assert.doesNotMatch(brief, /hive-mr/);
  hive.setPipelineSink(null, '/abs/hive-mr.cjs');
  assert.equal(hive.pipelineCli, null, 'a path without a conductor is not kept');
  hive.setPipelineSink(() => {}, 'relative/hive-mr.cjs');
  assert.equal(hive.pipelineCli, null, 'a relative path is not kept');
});
