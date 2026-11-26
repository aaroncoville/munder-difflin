'use strict';
// Shared pieces for the scheduler tests: a temporary hive and core.db, a task definition, a finished headless run as
// a stub runner returns it, and readers for the cost ledger and the seat's mail. Used by the tests and by the child
// processes they start (scheduler-child.cjs).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT = 'sched1';
const SESSION = '8c1d2f3a-0000-4000-8000-0000000000aa';

/** Epoch ms of a local wall-clock time on 2026-11-(20 + day). */
const at = (day, h, m = 0) => new Date(2026, 10, 20 + day, h, m).getTime();

/** A temporary hive (with the seat's folder) and a separate state folder for core.db, both removed after the test. */
function floor(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-sched-')));
  if (t) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hiveRoot = path.join(base, 'hive');
  fs.mkdirSync(path.join(hiveRoot, 'agents', AGENT, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(hiveRoot, 'cost-ledger.jsonl'), `${JSON.stringify({ agent_id: 'other', session_id: 's0', ts: 1, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 1 })}\n`);
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir);
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  return { base, hiveRoot, stateDir, work, dbPath: path.join(stateDir, 'core.db'), calls: path.join(base, 'calls.log'), ledger: path.join(hiveRoot, 'cost-ledger.jsonl'), outbox: path.join(hiveRoot, 'agents', AGENT, 'outbox') };
}

/** A task definition in the import format. */
function taskDef(f, more = {}) {
  return {
    id: 'daily-scan', agentId: AGENT, prompt: 'Write today\'s scan to the output file.', schedule: { daily: '07:19' },
    model: 'sonnet', maxBudgetUsd: 3, outputFile: path.join(f.work, 'scan.md'), cwd: f.work, roots: [], ...more,
  };
}

/** A finished run, in the shape runHeadlessSeat resolves it, that reported `usd`. */
function headlessRun(usd = 0.0042, more = {}) {
  const result = {
    type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION, total_cost_usd: usd,
    usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 560, cache_creation_input_tokens: 78 },
    modelUsage: { 'claude-sonnet-x': { costUSD: usd } },
  };
  return {
    ok: true, outcome: 'success', exitCode: 0, signal: null, result: 'ok', sessionId: SESSION, totalCostUsd: usd, subtype: 'success',
    error: null, stdout: `${JSON.stringify(result)}\n`, stderr: '', argv: ['claude', '-p', '--model', 'sonnet', 'x'],
    cwd: '/w', settingsFile: '/s.json', outputFile: null, timedOut: false, killSignal: null, startedAt: 0, swept: 0, sweepError: null, ...more,
  };
}

/** Rows of the cost ledger. */
const ledgerRows = (f) => fs.readFileSync(f.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Every message the seat has written: still in its outbox, or filed by the router under outbox/.sent. */
function mail(f) {
  const out = [];
  for (const dir of [f.outbox, path.join(f.outbox, '.sent')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.json')) out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
  }
  return out;
}

/** The lines the stub runner wrote, one per call: "<runId> <prompt>". */
const calls = (f) => (fs.existsSync(f.calls) ? fs.readFileSync(f.calls, 'utf8').split('\n').filter(Boolean) : []);

module.exports = { AGENT, SESSION, at, floor, taskDef, headlessRun, ledgerRows, mail, calls };
