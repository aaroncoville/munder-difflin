'use strict';

/**
 * The per-worker token cap reads TelemetryCollector.getAgentUsage(). A freshly
 * spawned worker has no live OTel yet, so the read falls through to the
 * transcript fallback, which scopes itself to the agent's recorded session id.
 *
 * When a worker id is re-used, the registry still holds the PREVIOUS run's
 * session id from spawn until the new session's first hook reports in. The
 * re-used id also gets the same worktree path, so the same Claude project dir,
 * so the previous run's transcript is right there to be read. The new worker
 * was billed for all of it and reaped about a second after it started.
 *
 * Separately, Claude Code writes one transcript line per content block, and
 * every line of one API response repeats that response's full `usage`. Summing
 * every line over-reported a session roughly twofold; each `message.id` must be
 * counted once.
 *
 * Sandboxes HOME so projectDir() maps into a throwaway dir, never the real
 * ~/.claude/projects (mirrors test/transcript-usage.test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const loadTs = require('./load-ts.cjs');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { projectDir, readAgentUsage } = loadTs('src/main/transcript.ts');

function assistantLine(sessionId, messageId, outputTokens) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      id: messageId,
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    }
  });
}

/** A worktree cwd whose project dir still holds the previous run's transcript. */
function makeReusedWorktree() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-'));
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 50 }, (_, i) => assistantLine('old-session', `msg_old_${i}`, 100_000));
  fs.writeFileSync(path.join(dir, 'old-session.jsonl'), `${lines.join('\n')}\n`);
  return { cwd, dir };
}

test('a re-spawned worker is not billed for the previous run\'s transcript', () => {
  const { cwd } = makeReusedWorktree();
  let recorded = 'old-session'; // the registry still holds the previous run's id
  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => recorded
  });

  telemetry.startFreshSession('worker-a');

  assert.equal(telemetry.getAgentUsage('worker-a'), null,
    'until the new session reports in, the fresh worker has used nothing');
});

test('a re-spawned worker is billed for its own session once that session is known', () => {
  const { cwd, dir } = makeReusedWorktree();
  let recorded = 'old-session';
  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => recorded
  });

  telemetry.startFreshSession('worker-a');
  fs.writeFileSync(path.join(dir, 'new-session.jsonl'), `${assistantLine('new-session', 'msg_new_0', 7)}\n`);
  recorded = 'new-session'; // the new session's first hook fired

  const sample = telemetry.getAgentUsage('worker-a');
  assert.ok(sample, 'expected the new session\'s usage');
  assert.equal(sample.output, 7);
  assert.equal(sample.input, 100);
});

test('a fresh start for one worker does not hide another worker\'s usage', () => {
  const { cwd } = makeReusedWorktree();
  const telemetry = new TelemetryCollector({
    resolveCwd: () => cwd,
    resolveSessionId: () => 'old-session'
  });

  telemetry.startFreshSession('worker-a');

  const other = telemetry.getAgentUsage('worker-b');
  assert.ok(other, 'worker-b really is on old-session');
  assert.equal(other.output, 50 * 100_000);
});

test('transcript usage counts each API response once, not once per streamed line', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-'));
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  // One response written as three content-block lines (thinking, text,
  // tool_use), each repeating the response's usage, then a second response.
  const lines = [
    assistantLine('s1', 'msg_a', 40),
    assistantLine('s1', 'msg_a', 40),
    assistantLine('s1', 'msg_a', 40),
    assistantLine('s1', 'msg_b', 5)
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), `${lines.join('\n')}\n`);

  const all = readAgentUsage(cwd);
  assert.equal(all.outputTokens, 45);
  assert.equal(all.inputTokens, 200);
  const scoped = readAgentUsage(cwd, { sessionId: 's1' });
  assert.equal(scoped.outputTokens, 45);
});

test('a response split across two incremental reads is still counted once', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-tail-'));
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's2.jsonl');
  fs.writeFileSync(file, `${assistantLine('s2', 'msg_a', 40)}\n`);
  assert.equal(readAgentUsage(cwd, { sessionId: 's2' }).outputTokens, 40);

  // The rest of the same response lands after the first read was cached.
  fs.appendFileSync(file, `${assistantLine('s2', 'msg_a', 40)}\n${assistantLine('s2', 'msg_b', 3)}\n`);
  assert.equal(readAgentUsage(cwd, { sessionId: 's2' }).outputTokens, 43);
});
