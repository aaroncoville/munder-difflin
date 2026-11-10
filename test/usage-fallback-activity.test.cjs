'use strict';

/**
 * With no OpenTelemetry record for an agent (telemetry turned off, or none
 * arrived yet), TelemetryCollector.getAgentUsage falls back to the agent's
 * Claude transcript. That sample was stamped with the time it was read, and the
 * worker wake watchdog took a usage sample with tokens as proof of a turn at
 * its `ts`. So on every beat a Claude worker read as active "now", and the
 * stall rule (mail waiting with no session activity since it landed) could
 * never fire for it, however long the mail sat untouched.
 *
 * The fallback now also says when the transcript was last written, and the
 * watchdog's activity evidence reads that. `ts` stays the read time: the
 * circuit breaker divides output growth by the time between two samples' `ts`,
 * and the gap between two transcript writes would inflate that rate.
 *
 * Sandboxes HOME so projectDir() maps into a throwaway dir, never the real
 * ~/.claude/projects (mirrors test/telemetry-session-fallback.test.cjs).
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
const { projectDir } = loadTs('src/main/transcript.ts');
const { WorkerWakeWatchdog, activityEvidenceAt, isStalledWorker, WORKER_WAKE_COOLDOWN_MS } = loadTs('src/main/workerWake.ts');

function assistantRecord(sessionId, id) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  });
}

/** An agent whose current session's transcript was last written at `writtenAt`. */
function agentWithTranscript(writtenAt, { file = 'my-session.jsonl' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, file);
  fs.writeFileSync(transcript, `${assistantRecord('my-session', 'msg-1')}\n`);
  fs.utimesSync(transcript, new Date(writtenAt), new Date(writtenAt));
  return new TelemetryCollector({ resolveCwd: () => cwd, resolveSessionId: () => 'my-session' });
}

/** The facts the watchdog beat gathers for a quiet Claude worker with one message waiting. */
function quietWorker(telemetry, mailAt, now) {
  const usage = telemetry.getAgentUsage('worker-x');
  return {
    agentId: 'worker-x',
    isGod: false,
    ptyId: 'pty-x',
    lastOutputAt: now - 10 * 60_000,
    inboxIds: ['m1'],
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    lastActivityAt: activityEvidenceAt({ usage, spans: [] }),
    hasTelemetry: usage !== null,
    oldestMailAt: mailAt
  };
}

test('an idle worker whose transcript has not moved since its mail arrived reads as stalled', () => {
  const now = Date.now();
  const mailAt = now - 10 * 60_000;
  const telemetry = agentWithTranscript(now - 60 * 60_000);
  assert.equal(isStalledWorker(quietWorker(telemetry, mailAt, now), now), true);
});

test('so the watchdog announces that mail again after the cooldown, instead of holding it as announced', () => {
  const now = Date.now();
  const mailAt = now - 10 * 60_000;
  const telemetry = agentWithTranscript(now - 60 * 60_000);
  const watchdog = new WorkerWakeWatchdog();
  const first = watchdog.decideWithReasons([quietWorker(telemetry, mailAt, now)], now);
  assert.equal(first[0].nudge, true, 'the first beat announces the mail');
  const later = now + WORKER_WAKE_COOLDOWN_MS + 1_000;
  const second = watchdog.decideWithReasons([quietWorker(telemetry, mailAt, later)], later);
  assert.equal(second[0].nudge, true, `held as ${second[0].reason}`);
});

test('a worker whose transcript was written after its mail arrived is not stalled', () => {
  const now = Date.now();
  const mailAt = now - 10 * 60_000;
  const telemetry = agentWithTranscript(now - 30_000);
  assert.equal(isStalledWorker(quietWorker(telemetry, mailAt, now), now), false);
  const watchdog = new WorkerWakeWatchdog();
  watchdog.decideWithReasons([quietWorker(telemetry, mailAt, now)], now);
  const later = now + WORKER_WAKE_COOLDOWN_MS + 1_000;
  assert.equal(watchdog.decideWithReasons([quietWorker(telemetry, mailAt, later)], later)[0].reason, 'already-announced');
});

test('the activity time is the session transcript\'s mtime, to the millisecond it was given', () => {
  const writtenAt = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000;
  const sample = agentWithTranscript(writtenAt).getAgentUsage('worker-x');
  assert.equal(activityEvidenceAt({ usage: sample, spans: [] }), writtenAt);
});

test('the sample\'s ts stays the time it was read, which the breaker\'s rates are measured over', () => {
  const before = Date.now();
  const sample = agentWithTranscript(before - 60 * 60_000).getAgentUsage('worker-x');
  assert.ok(sample.ts >= before, `ts ${sample.ts} is before the read at ${before}`);
});

test('when the session has no transcript of its own name, the activity time is the read time, as before', () => {
  const before = Date.now();
  const sample = agentWithTranscript(before - 60 * 60_000, { file: 'other-name.jsonl' }).getAgentUsage('worker-x');
  assert.ok(sample, 'the session\'s records are still counted');
  assert.ok(activityEvidenceAt({ usage: sample, spans: [] }) >= before);
});
