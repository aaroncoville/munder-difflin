'use strict';

/**
 * A Codex worker starts a new thread for each new request it is sent, and keeps
 * its thread for the follow-ups to the work already in it (codexThread.ts).
 * The boundary tests use the message shapes the hive actually routes: a fix
 * round arrives as a request replying to the worker's own report, while a new
 * review can reply to some other agent's message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { CodexThreads, newThreadWrites, typeWrites } = loadTs('src/main/codexThread.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { inboxNudgeText, isInboxNudge } = loadTs('src/shared/hiveNudge.ts');

const WORKER = 'reviewer';
const isAgent = (id) => ['god', WORKER, 'dev'].includes(id);
const isWorker = (id) => id === WORKER;

function records(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (id) => path.join(dir, id, 'hive-thread.json');
  return { threads: new CodexThreads(at), reopen: () => new CodexThreads(at) };
}

const request = (id, extra = {}) => ({ id, from: 'god', act: 'request', ...extra });
const routeTo = (threads, msg, to = WORKER, inbox = []) => threads.observe(msg, [to], isWorker, isAgent, () => inbox);

/** A worker that has finished one review: the request came in, its report went out. */
function afterOneReview(threads) {
  threads.spawned(WORKER, false);
  routeTo(threads, request('review-1'));
  routeTo(threads, { id: 'report-1', from: WORKER, act: 'done', in_reply_to: 'review-1' }, 'god');
}

test('a new request starts a new thread once the current one has had one', (t) => {
  const { threads } = records(t);
  threads.spawned(WORKER, false);
  routeTo(threads, request('review-1'));
  assert.deepEqual(threads.due(WORKER, [request('review-1')], isAgent), [], 'a new process takes its first request itself');
  routeTo(threads, { id: 'report-1', from: WORKER, act: 'done', in_reply_to: 'review-1' }, 'god');
  routeTo(threads, request('review-2'));
  assert.deepEqual(threads.due(WORKER, [request('review-2')], isAgent), ['review-2']);
});

test('a new process takes mail that was waiting when it started', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  // Delivered while the worker was down, so nothing routed it past this run.
  threads.spawned(WORKER, false);
  assert.deepEqual(threads.due(WORKER, [request('review-2')], isAgent), []);
});

test('a fix round replying to the worker’s own report continues its thread', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  const fixRound = request('fix-1', { in_reply_to: 'report-1' });
  routeTo(threads, fixRound);
  assert.deepEqual(threads.due(WORKER, [fixRound], isAgent), []);
  // And the round after that still does: the follow-up is part of the thread now.
  routeTo(threads, { id: 'report-2', from: WORKER, act: 'done', in_reply_to: 'fix-1' }, 'god');
  const second = request('fix-2', { in_reply_to: 'fix-1' });
  routeTo(threads, second);
  assert.deepEqual(threads.due(WORKER, [second], isAgent), []);
});

test('a request replying to another agent’s message is new work', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  // god forwards a developer's "ready for review" as a review request.
  const review = request('review-2', { in_reply_to: 'dev-ready' });
  routeTo(threads, review);
  assert.deepEqual(threads.due(WORKER, [review], isAgent), ['review-2']);
});

test('only a request from an agent opens a thread', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  const pending = [
    { id: 'steer', from: 'breaker', act: 'request' },
    { id: 'job', from: 'scheduler', act: 'request' },
    { id: 'fyi', from: 'god', act: 'inform' }
  ];
  for (const m of pending) {
    // Delivered while the worker is idle, each is still about the current thread.
    assert.deepEqual(threads.due(WORKER, [m], isAgent), [], m.id);
  }
});

test('a thread is not replaced while mail delivered into it is unhandled', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  routeTo(threads, request('review-2'));
  // review-1 is still in the inbox: the worker has not finished it.
  assert.deepEqual(threads.due(WORKER, [request('review-1'), request('review-2')], isAgent), []);
  // A waiting follow-up goes into the current thread, and the new request with it.
  const fix = request('fix-1', { in_reply_to: 'report-1' });
  assert.deepEqual(threads.due(WORKER, [fix, request('review-2')], isAgent), []);
});

test('a new thread starts with what was pending, and its follow-ups stay in it', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  routeTo(threads, request('review-2'));
  threads.opened(WORKER, ['review-2']);
  routeTo(threads, { id: 'report-2', from: WORKER, act: 'done', in_reply_to: 'review-2' }, 'god');
  const fix = request('fix-2', { in_reply_to: 'report-2' });
  routeTo(threads, fix);
  assert.deepEqual(threads.due(WORKER, [fix], isAgent), []);
  // The first review is not part of the new thread: a late fix round for it is new work there.
  const late = request('fix-1', { in_reply_to: 'report-1' });
  assert.deepEqual(threads.due(WORKER, [late], isAgent), ['fix-1']);
});

test('a request that arrives while the worker is on another joins the current thread', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  routeTo(threads, request('review-2'));
  // review-3 lands while review-2 is still in the inbox: no new thread can
  // start, so the worker takes both in the thread it is in.
  routeTo(threads, request('review-3'), WORKER, [request('review-2')]);
  routeTo(threads, { id: 'report-3', from: WORKER, act: 'done', in_reply_to: 'review-3' }, 'god');
  const correction = request('fix-3', { in_reply_to: 'review-3' });
  assert.deepEqual(threads.due(WORKER, [correction], isAgent), []);
});

test('a request the worker answers from its current thread belongs to it', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  // Handled alongside an inform, with no nudge in between: only the reply shows it.
  routeTo(threads, request('review-2'));
  routeTo(threads, { id: 'fyi', from: 'god', act: 'inform' });
  routeTo(threads, { id: 'report-2', from: WORKER, act: 'done', in_reply_to: 'review-2' }, 'god');
  const correction = request('fix-2', { in_reply_to: 'review-2' });
  assert.deepEqual(threads.due(WORKER, [correction], isAgent), []);
});

test('a new process that answers the mail it found has had its request', (t) => {
  const { threads } = records(t);
  threads.spawned(WORKER, false);
  // review-1 was waiting before the spawn, so nothing routed it in this run.
  routeTo(threads, { id: 'report-1', from: WORKER, act: 'done', in_reply_to: 'review-1' }, 'god');
  assert.deepEqual(threads.due(WORKER, [request('review-2')], isAgent), ['review-2'], 'the next request is new work');
  assert.deepEqual(threads.due(WORKER, [request('fix-1', { in_reply_to: 'review-1' })], isAgent), [], 'a correction to the first is not');
});

test('mail a nudge hands to the current thread joins it', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  routeTo(threads, request('fix-1', { in_reply_to: 'report-1' }));
  routeTo(threads, request('review-2'));
  threads.adopt(WORKER, [request('fix-1', { in_reply_to: 'report-1' }), request('review-2')], isAgent);
  assert.deepEqual(threads.due(WORKER, [request('fix-2', { in_reply_to: 'review-2' })], isAgent), []);
  // And a new process that is nudged about mail that was waiting has had its request.
  threads.spawned(WORKER, false);
  threads.adopt(WORKER, [request('review-3')], isAgent);
  assert.deepEqual(threads.due(WORKER, [request('review-4')], isAgent), ['review-4']);
});

test('a fix round after an app restart still finds its thread', (t) => {
  const { threads, reopen } = records(t);
  afterOneReview(threads);
  const restarted = reopen();
  restarted.spawned(WORKER, true); // the respawn resumed the session
  const fix = request('fix-1', { in_reply_to: 'report-1' });
  assert.deepEqual(restarted.due(WORKER, [fix], isAgent), []);
  assert.deepEqual(restarted.due(WORKER, [request('review-2')], isAgent), ['review-2']);
});

test('a respawn that did not resume starts its own thread', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  threads.spawned(WORKER, false);
  routeTo(threads, request('review-2'));
  assert.deepEqual(threads.due(WORKER, [request('review-2')], isAgent), []);
});

test('a worker with no record has a thread with history', (t) => {
  const { threads } = records(t);
  assert.deepEqual(threads.due(WORKER, [request('review-1')], isAgent), ['review-1']);
});

test('the new thread is typed as /new, then the brief and the nudge as one message', () => {
  const nudge = inboxNudgeText(['review-2']);
  const writes = newThreadWrites('You are Reviewer.\nRead PROTOCOL.md.', nudge);
  assert.deepEqual(writes.map((w) => w.data), [
    '/new',
    '\r',
    `\x1b[200~You are Reviewer.\nRead PROTOCOL.md.\n\n${nudge}\x1b[201~`,
    '\r'
  ]);
  // Each Enter is its own write, after its text, and the paste waits for the new thread.
  assert.ok(writes[1].delayMs > 0 && writes[3].delayMs > 0);
  assert.ok(writes[2].delayMs >= 1_000);
});

test('the writes go out in order, and a failed one stops the rest', () => {
  const now = () => 0;
  const typed = [];
  let result;
  typeWrites([{ data: 'a', delayMs: 0 }, { data: 'b', delayMs: 5 }], (d) => { typed.push(d); return true; }, (ok) => { result = ok; }, (fn) => fn(now()));
  assert.deepEqual(typed, ['a', 'b']);
  assert.equal(result, true);
  typed.length = 0;
  typeWrites([{ data: 'a', delayMs: 0 }, { data: 'b', delayMs: 5 }], (d) => { typed.push(d); return false; }, (ok) => { result = ok; }, (fn) => fn(now()));
  assert.deepEqual(typed, ['a']);
  assert.equal(result, false);
});

test('a Codex spawn keeps the brief it was started with', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/mdth-'));
  const fakeHome = path.join(home, 'h');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent({ id: 'cx', name: 'Cx', provider: 'codex', cwd });
  const brief = hive.initialPromptOf('cx');
  assert.ok(brief && brief.includes('Cx'), 'the brief names the worker');
  assert.equal(injection.args[injection.args.length - 1], brief, 'the same text the process was started with');
  await hive.ensureAgent({ id: 'cl', name: 'Cl', provider: 'claude', cwd });
  assert.equal(hive.initialPromptOf('cl'), undefined);
});

// ── the call sites in index.ts, run as written ────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

function slice(startMarker, endMarker) {
  const start = INDEX.indexOf(startMarker);
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} located in index.ts`);
  return ts.transpileModule(INDEX.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

/** One Codex worker on a floor, with the opener and both nudge paths loaded from index.ts. */
function floor(t, { provider = 'codex', inbox, brief = 'You are Reviewer.', later, switches = true } = {}) {
  const { threads } = records(t);
  afterOneReview(threads);
  const mail = inbox ?? [request('review-2')];
  for (const m of mail) routeTo(threads, m);
  const events = [];
  const agents = { god: {}, dev: {}, [WORKER]: { provider, sessionId: 'old-thread' } };
  const hive = {
    registry: () => ({ godId: 'god', agents }),
    inbox: () => mail,
    initialPromptOf: () => brief,
    appendCostLedger: (s) => events.push(['ledger', s.sessionId]),
    appendLog: (l) => events.push(['log', l.kind, l.ok, l.opening, l.switched])
  };
  let last = '';
  const ptyManager = { write: (_id, data) => {
    events.push(['write', data]);
    // Codex reports a new session id once the new thread's first prompt is submitted.
    if (switches && data === '\r' && last.startsWith('\x1b[200~')) agents[WORKER].sessionId = 'new-thread';
    last = data;
    return { ok: true };
  } };
  const usageProvider = { getAgentUsage: () => ({ agentId: WORKER, sessionId: 'old-thread', input: 10, output: 1 }) };
  const grokLedgerGate = { admits: () => true };
  const typeNow = (writes, write, done) => typeWrites(writes, write, done, later ? (fn) => later.push(fn) : (fn) => fn());
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const body = [
    slice('function openNewCodexThread(', '/** Type the renderer\'s guarded nudge'),
    slice('function nudgeWorker(', '/** Watchdog nudges whose text'),
    slice("ipcMain.handle('pty:write'", "ipcMain.handle('pty:resize'")
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'ptyToAgent', 'hive', 'openingThreads', 'codexThreads', 'usageProvider', 'grokLedgerGate',
    'inboxNudgeText', 'isInboxNudge', 'typeWrites', 'newThreadWrites', 'ptyManager', 'console', 'ipcMain',
    'pendingSubmits', 'NUDGE_SUBMIT_DELAY_MS', 'setTimeout', 'NEW_THREAD_CONFIRM_MS',
    `${body}\nreturn { nudgeWorker, pending: () => pendingSubmits };`
  )(
    new Map([['pty-1', WORKER]]), hive, new Set(), threads, usageProvider, grokLedgerGate,
    inboxNudgeText, isInboxNudge, typeNow, newThreadWrites, ptyManager, quiet, ipcMain,
    0, 0, later ? (fn) => later.push(fn) : (fn) => fn(), 0
  );
  return { events, threads, mail, rendererWrite: (data) => handlers['pty:write'](null, 'pty-1', data), ...api };
}

const writes = (events) => events.filter((e) => e[0] === 'write').map((e) => e[1]);

test('the renderer’s nudge for a new request becomes /new, the brief and the nudge', (t) => {
  const f = floor(t);
  const nudge = inboxNudgeText(['review-2']);
  assert.deepEqual(f.rendererWrite(nudge), { ok: true });
  assert.deepEqual(writes(f.events), newThreadWrites('You are Reviewer.', nudge).map((w) => w.data));
  // The old thread's last usage is recorded before it is left behind.
  assert.deepEqual(f.events[0], ['ledger', 'old-thread']);
  assert.deepEqual(f.events.at(-1), ['log', 'codex-new-thread', true, ['review-2'], true]);
  // Its Enter, a tick later, is written as usual onto the empty line.
  f.rendererWrite('\r');
  assert.equal(writes(f.events).at(-1), '\r');
  // The new thread holds what it was given: a fix round for it stays there.
  assert.deepEqual(f.threads.due(WORKER, [request('fix', { in_reply_to: 'review-2' })], isAgent), []);
  // The old thread is left behind: a late fix round for its review is new work.
  assert.deepEqual(f.threads.due(WORKER, [request('late', { in_reply_to: 'report-1' })], isAgent), ['late']);
  // And once the move is settled, the next nudge reaches the terminal as usual.
  const again = inboxNudgeText(['review-2']);
  f.rendererWrite(again);
  assert.equal(writes(f.events).at(-1), again);
});

test('a /new Codex refused leaves the mail with the thread it went to', (t) => {
  // Mid-turn, Codex drops the /new and the paste joins the running turn: same session.
  const f = floor(t, { switches: false });
  f.rendererWrite(inboxNudgeText(['review-2']));
  assert.deepEqual(f.events.at(-1), ['log', 'codex-new-thread', true, ['review-2'], false]);
  // The old thread is still the current one, so its follow-ups continue it...
  assert.deepEqual(f.threads.due(WORKER, [request('fix-1', { in_reply_to: 'report-1' })], isAgent), []);
  // ...and the request it was handed belongs to it now.
  assert.deepEqual(f.threads.due(WORKER, [request('fix-2', { in_reply_to: 'review-2' })], isAgent), []);
});

test('stall-line reads wait until the new thread is typed', (t) => {
  const later = [];
  const f = floor(t, { later });
  f.rendererWrite(inboxNudgeText(['review-2']));
  assert.equal(f.pending(), 1, 'its Enters are pending submissions');
  // A second nudge while it is being typed must not land inside it.
  f.nudgeWorker('pty-1', ['review-2']);
  while (later.length) later.shift()();
  assert.equal(f.pending(), 0);
  assert.deepEqual(writes(f.events), newThreadWrites('You are Reviewer.', inboxNudgeText(['review-2'])).map((w) => w.data));
});

test('the watchdog’s nudge takes the same path', (t) => {
  const f = floor(t);
  let outcome;
  f.nudgeWorker('pty-1', ['review-2'], (ok) => { outcome = ok; });
  assert.equal(writes(f.events)[0], '/new');
  assert.equal(outcome, true);
});

test('a follow-up, or a Claude agent, is nudged exactly as before', (t) => {
  const followUp = floor(t, { inbox: [request('fix-1', { in_reply_to: 'report-1' })] });
  const nudge = inboxNudgeText(['fix-1']);
  followUp.rendererWrite(nudge);
  assert.deepEqual(writes(followUp.events), [nudge]);
  assert.equal(followUp.events.some((e) => e[0] === 'ledger'), false);

  const claude = floor(t, { provider: 'claude' });
  claude.nudgeWorker('pty-1', ['review-2']);
  assert.deepEqual(writes(claude.events), [inboxNudgeText(['review-2']), '\r']);
});

test('a nudge into the current thread records what it hands over', (t) => {
  const f = floor(t, { inbox: [request('fix-1', { in_reply_to: 'report-1' }), request('review-2')] });
  f.rendererWrite(inboxNudgeText(['fix-1', 'review-2']));
  assert.equal(writes(f.events).length, 1, 'a plain nudge');
  assert.deepEqual(f.threads.due(WORKER, [request('fix-2', { in_reply_to: 'review-2' })], isAgent), []);
});

test('a worker with no brief is nudged into its thread, and that is recorded', (t) => {
  const f = floor(t, { brief: null });
  f.rendererWrite(inboxNudgeText(['review-2']));
  assert.deepEqual(writes(f.events), [inboxNudgeText(['review-2'])]);
  assert.deepEqual(f.threads.due(WORKER, [request('fix-2', { in_reply_to: 'review-2' })], isAgent), []);
});

test('other terminal input is never taken for a nudge', (t) => {
  const f = floor(t);
  f.rendererWrite('please review review-2');
  assert.deepEqual(writes(f.events), ['please review review-2']);
});

test('routing a message records it against the Codex worker’s thread', (t) => {
  const { threads } = records(t);
  afterOneReview(threads);
  let observer;
  const closing = [];
  const hive = {
    registry: () => ({ godId: 'god', agents: { god: {}, [WORKER]: { provider: 'codex' } } }),
    setRoutedObserver: (cb) => { observer = cb; },
    inbox: () => [request('review-1')]
  };
  const body = slice('hive.setRoutedObserver(', "ipcMain.handle('app:startClosingTime'");
  // eslint-disable-next-line no-new-func
  new Function('hive', 'closingTime', 'codexThreads', body)(hive, { onRouted: (m) => closing.push(m.id) }, threads);
  const fix = request('fix-1', { in_reply_to: 'report-1' });
  observer(fix, [WORKER]);
  assert.deepEqual(closing, ['fix-1'], 'closing time still hears every message');
  // fix-1 is part of the thread now, so while it is unhandled no new thread starts.
  assert.deepEqual(threads.due(WORKER, [fix, request('review-2')], isAgent), []);
  assert.ok(threads.get(WORKER).ids.includes('fix-1'));
  // A request routed while the thread still has mail pending joins it.
  observer(request('review-2'), [WORKER]);
  assert.ok(threads.get(WORKER).ids.includes('review-2'), 'the inbox reached the observer');
});
