'use strict';
// The pipeline's stage machine for the steel thread (spec 6.2, steel-thread 1.2 ST-5
// and the acceptance list in 1.5). step(state, event, ctx) is pure: the conductor runs
// every probe and hands its result in with the event, so each guard below is a probe
// result, never an agent's claim. Off the straight path, every outcome sets a hold and
// wakes god once.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { step, initialState } = loadTs('src/main/pipeline/stage.ts');
const { WAYFARER } = loadTs('src/main/pipeline/config.ts');

const S = 'eecd72bae05026701fee211b6c96774e33585587';
const S2 = '1111111111111111111111111111111111111111';
const M = '2222222222222222222222222222222222222222';
const D = '3333333333333333333333333333333333333333';
const CARD = 'WF-FB-VEHICLES';
const GOD = 'god';
const IMPL = 'marinette-mtcz0zuv';
const BRANCH = 'feat/vehicles';

const roster = [
  { id: 'orsolina-mtx', name: 'orsolina', provider: 'claude', archived: false },
  { id: 'jannings-mtx', name: 'jannings', provider: 'codex', archived: false },
  { id: 'tryphon-mtx', name: 'tryphon', provider: 'codex', archived: false },
];
const ctx = (over = {}) => ({ now: '2026-11-12T10:00:00.000Z', repoId: 'wayfarer', repo: WAYFARER, autoMerge: true, deadlineMin: 60, godId: GOD, roster, ...over });

const forge = (over = {}) => ({
  state: 'opened', draft: false, head: S, source: BRANCH, target: 'main',
  pipeline: { id: 99, sha: S, status: 'success' }, mergeCommit: null, ...over,
});
const enrol = (over = {}) => ({
  kind: 'command', msgId: 'god-1', from: GOD, openMrsForBranch: 0,
  payload: { schema: 'mr.command/1', card: CARD, command: 'enrol', args: { repo: 'wayfarer', implementer: IMPL, branch: BRANCH } },
  ...over,
});
const submit = (over = {}, probe = {}) => ({
  kind: 'submit', msgId: 'impl-1', from: IMPL,
  payload: { schema: 'mr.submit/1', card: CARD, repo: 'wayfarer', mr: 181, head_sha: S, kind: 'initial', answers: null, dispositions: [], tests: [], summary: 's', decisions_taken: [], needs_owner: null, ...over },
  forge: forge(), mergeTree: 'clean', ...probe,
});
const finding = (over = {}) => ({ id: 'f1', severity: 'MED', must_fix: true, title: 't', file: 'web/a.ts', line: 1, class: 'defect', body: 'b', ...over });
const verdict = (from, word, over = {}, probe = {}) => ({
  kind: 'verdict', msgId: `${from}-v`, from, model: null,
  payload: { schema: 'mr.verdict/1', card: CARD, answers: `${CARD}:r1:${from}`, reviewed_sha: S, round: 1, verdict: word,
    findings: word === 'BLOCK' ? [finding()] : [], abstain_reason: word === 'ABSTAIN' ? 'capacity' : null, ...over },
  forge: forge(), ...probe,
});
const tick = (over = {}) => ({ kind: 'tick', forge: forge(), mergeTree: 'clean', changedFiles: ['web/src/a.ts'], live: null, ...over });

/** Runs events in order from a fresh card, collecting every effect and log entry. */
function run(events, c = ctx()) {
  let state = initialState(CARD);
  const effects = [];
  const log = [];
  for (const e of events) {
    const out = step(state, e, typeof c === 'function' ? c(e) : c);
    state = out.state;
    effects.push(...out.effects);
    log.push(...out.log);
  }
  return { state, effects, log, transitions: log.filter((l) => l.type === 'transition').map((l) => `${l.from ?? '∅'}→${l.to}`) };
}
const kinds = (effects, kind) => effects.filter((e) => e.kind === kind);
/** The causes a card is held for, sorted. */
const held = (state) => Object.keys(state.holds).sort();
const codes = (effects) => kinds(effects, 'exception').map((e) => e.code);

const toReview = [enrol(), submit()];
const bothConfirm = [verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'CONFIRMED')];
const toMergeable = [...toReview, ...bothConfirm];
const ATTEMPT = `${CARD}:merge:1`;
const mergeOk = { kind: 'merge-result', attempt: ATTEMPT, ok: true, mergeCommit: M, secondParent: S };
const liveOk = tick({ live: { deployed: D, mergeIsAncestor: true } });

// --- The straight path (acceptance 1.5, first block) ---

test('the straight path: implementing → review → mergeable → merged → live, with one merge call at S', () => {
  const r = run([...toMergeable, tick(), mergeOk, tick({ forge: forge({ state: 'merged', mergeCommit: M }) }), liveOk]);
  assert.deepEqual(r.transitions, ['∅→implementing', 'implementing→review', 'review→mergeable', 'mergeable→merged', 'merged→live']);
  assert.deepEqual(kinds(r.effects, 'merge'), [{ kind: 'merge', mr: 181, sha: S, attempt: ATTEMPT }]);
  assert.equal(r.state.stage, 'live');
  assert.equal(r.state.mergeCommit, M);
  assert.equal(r.state.deployed, D);
  assert.deepEqual(codes(r.effects), [], 'god is not woken on the straight path');
});

test('T2 sends one review request to each panel reviewer, naming the full sha and the round', () => {
  const r = run(toReview);
  assert.deepEqual(kinds(r.effects, 'review-request').map((e) => [e.reviewer, e.vendor, e.sha, e.round]),
    [['orsolina-mtx', 'anthropic', S, 1], ['jannings-mtx', 'openai', S, 1]]);
  assert.equal(r.state.sha, S);
  assert.equal(r.state.mr, 181);
});

test('T3 records each counted verdict\'s reviewer, vendor and model, and the rule that fired', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', {}, {}), { ...verdict('jannings-mtx', 'CONFIRMED'), model: 'gpt-5.6-sol' }]);
  const t3 = r.log.find((l) => l.type === 'transition' && l.to === 'mergeable');
  assert.equal(t3.evidence.rule, 'confirm');
  assert.deepEqual(t3.evidence.verdicts.map((v) => [v.reviewer, v.vendor, v.model, v.verdict]),
    [['orsolina-mtx', 'anthropic', null, 'CONFIRMED'], ['jannings-mtx', 'openai', 'gpt-5.6-sol', 'CONFIRMED']]);
});

test('T6 checks that the merge commit\'s second parent is S, and holds if it is not', () => {
  const r = run([...toMergeable, tick(), { ...mergeOk, secondParent: S2 }]);
  assert.equal(r.state.stage, 'mergeable');
  assert.deepEqual(codes(r.effects), ['MERGE_REFUSED']);
});

test('T7 waits for the deployed commit to contain M; an unknown answer is neither live nor not live', () => {
  const at = [...toMergeable, tick(), mergeOk];
  assert.equal(run([...at, tick({ live: { deployed: null, mergeIsAncestor: null } })]).state.stage, 'merged');
  assert.equal(run([...at, tick({ live: { deployed: D, mergeIsAncestor: false } })]).state.stage, 'merged');
  assert.equal(run([...at, liveOk]).state.stage, 'live');
});

test('non-blocking findings are kept for the follow-up card, and do not hold the merge', () => {
  const low = finding({ id: 'o-L1', severity: 'LOW', must_fix: false });
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { findings: [low] }), verdict('jannings-mtx', 'CONFIRMED')]);
  assert.equal(r.state.stage, 'mergeable');
  assert.deepEqual(r.state.followups.map((f) => f.id), ['o-L1']);
});

// --- T1 guards ---

const ENROL_REFUSALS = [
  ['from anyone but god', enrol({ from: 'jc-mtx' })],
  ['for a repo not in the operator config', enrol({ payload: { ...enrol().payload, args: { repo: 'dog-eared', implementer: IMPL, branch: BRANCH } } })],
  ['when the branch already has two open MRs', enrol({ openMrsForBranch: 2 })],
];
for (const [what, event] of ENROL_REFUSALS) {
  test(`T1: enrol is refused ${what}, and nothing starts`, () => {
    const r = run([event]);
    assert.equal(r.state.stage, null);
    assert.equal(kinds(r.effects, 'refuse').length, 1);
  });
}

test('T1: a second enrol of the same card is refused', () => {
  const r = run([enrol(), enrol({ msgId: 'god-2' })]);
  assert.deepEqual(r.transitions, ['∅→implementing']);
  assert.equal(kinds(r.effects, 'refuse').length, 1);
});

// --- T2 guards: a submit is a claim, the forge is the evidence ---

const T2_WAITS = [
  ['head_pipeline is null', { forge: forge({ pipeline: null }) }],
  ['the pipeline is on another sha', { forge: forge({ pipeline: { id: 1, sha: S2, status: 'success' } }) }],
  ['the pipeline is still running', { forge: forge({ pipeline: { id: 1, sha: S, status: 'running' } }) }],
];
for (const [what, probe] of T2_WAITS) {
  test(`T2 does not fire while ${what}: the card waits in implementing, and nobody is woken`, () => {
    const r = run([enrol(), submit({}, probe)]);
    assert.equal(r.state.stage, 'implementing');
    assert.deepEqual(kinds(r.effects, 'review-request'), []);
    assert.deepEqual(codes(r.effects), []);
  });
}

test('T2 fires on a later tick once the pipeline on the submitted head turns green', () => {
  const r = run([enrol(), submit({}, { forge: forge({ pipeline: { id: 1, sha: S, status: 'running' } }) }), tick()]);
  assert.deepEqual(r.transitions, ['∅→implementing', 'implementing→review']);
});

const T2_HOLDS = [
  ['the pipeline is red', { forge: forge({ pipeline: { id: 1, sha: S, status: 'failed' } }) }, 'PIPELINE_RED'],
  ['the forge head is not the submitted sha', { forge: forge({ head: S2, pipeline: { id: 1, sha: S2, status: 'success' } }) }, 'HEAD_MOVED'],
  ['merge-tree reports a conflict', { mergeTree: 'conflict' }, 'CONFLICT'],
  ['the MR is a draft', { forge: forge({ draft: true }) }, 'OFF_PATH'],
  ['the MR targets another branch', { forge: forge({ target: 'release' }) }, 'OFF_PATH'],
  ['the MR comes from another branch', { forge: forge({ source: 'other' }) }, 'OFF_PATH'],
];
for (const [what, probe, code] of T2_HOLDS) {
  test(`T2 holds with ${code} when ${what}`, () => {
    const r = run([enrol(), submit({}, probe)]);
    assert.equal(r.state.stage, 'implementing');
    assert.deepEqual(held(r.state), [code]);
    assert.deepEqual(codes(r.effects), [code]);
    assert.deepEqual(kinds(r.effects, 'review-request'), []);
  });
}

test('a submit from anyone but the card\'s implementer is refused and moves nothing', () => {
  const r = run([enrol(), { ...submit(), from: 'ysabet-mtx' }]);
  assert.equal(r.state.stage, 'implementing');
  assert.equal(kinds(r.effects, 'refuse').length, 1);
});

test('a submit that needs the owner holds with OWNER_DECISION', () => {
  const r = run([enrol(), submit({ needs_owner: { question: 'VIN optional?' } })]);
  assert.deepEqual(codes(r.effects), ['OWNER_DECISION']);
});

// --- T3 and the panel ---

test('one CONFIRMED and one BLOCK: no merge, one hold for god to route the fix by hand', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'BLOCK'), tick()]);
  assert.equal(r.state.stage, 'review');
  assert.deepEqual(codes(r.effects), ['REVIEW_BLOCK_MANUAL']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
});

test('one CONFIRMED and one ABSTAIN: no merge and one REVIEW_DEGRADED', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'ABSTAIN'), tick()]);
  assert.deepEqual(codes(r.effects), ['REVIEW_DEGRADED']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
});

test('nothing is decided on the first verdict, even a block: the panel waits for every reviewer', () => {
  const r = run([...toReview, verdict('jannings-mtx', 'BLOCK')]);
  assert.equal(r.state.stage, 'review');
  assert.deepEqual(held(r.state), []);
});

test('a verdict on a sha that is not the current S is recorded, refused, and not counted', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { reviewed_sha: S2 }), verdict('jannings-mtx', 'CONFIRMED')]);
  assert.equal(r.state.stage, 'review');
  assert.equal(kinds(r.effects, 'refuse').length, 1);
  assert.ok(r.log.some((l) => l.type === 'fact' && l.fact === 'verdict-stale'));
});

test('a verdict from an agent that was not asked is refused and not counted', () => {
  const r = run([...toReview, verdict('tryphon-mtx', 'CONFIRMED'), verdict('orsolina-mtx', 'CONFIRMED')]);
  assert.equal(r.state.stage, 'review');
  assert.equal(kinds(r.effects, 'refuse').length, 1);
});

test('a byte-identical resend of a verdict is dropped; a changed one replaces it while still in review', () => {
  const once = verdict('orsolina-mtx', 'BLOCK');
  const r = run([...toReview, once, once, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'CONFIRMED')]);
  assert.equal(r.state.stage, 'mergeable');
  assert.ok(r.log.some((l) => l.fact === 'verdict-duplicate'));
});

test('a confirmation when the forge head has moved from S does not make the card mergeable', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'CONFIRMED', {}, { forge: forge({ head: S2 }) })]);
  assert.equal(r.state.stage, 'review');
  assert.deepEqual(codes(r.effects), ['HEAD_MOVED']);
});

test('a product-decision finding holds the card for the owner, whatever the verdict', () => {
  const pd = finding({ class: 'product-decision', must_fix: false, severity: 'LOW' });
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] }), verdict('jannings-mtx', 'CONFIRMED')]);
  assert.deepEqual(codes(r.effects), ['OWNER_DECISION']);
  assert.notEqual(r.state.stage, 'merged');
});

test('a panel with a vendor nobody can fill holds as REVIEW_DEGRADED at once, asking only the vendor there is', () => {
  const r = run(toReview, ctx({ roster: roster.filter((a) => a.provider === 'claude') }));
  assert.deepEqual(codes(r.effects), ['REVIEW_DEGRADED']);
});

test('a requested reviewer who leaves the roster is UNAVAILABLE, and the review degrades once the other answers', () => {
  const gone = (e) => (e.kind === 'tick' ? ctx({ roster: roster.filter((a) => a.id !== 'jannings-mtx') }) : ctx());
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), tick()], gone);
  assert.deepEqual(codes(r.effects), ['REVIEW_DEGRADED']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
});

// --- T6 guards (acceptance: refusals) ---

test('given two confirmations, a push before the merge tick means no merge call and a hold', () => {
  const r = run([...toMergeable, tick({ forge: forge({ head: S2, pipeline: { id: 2, sha: S2, status: 'success' } }) })]);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.deepEqual(codes(r.effects), ['HEAD_MOVED']);
});

const T6_WAITS = [
  ['the pipeline on S is not green any more', { forge: forge({ pipeline: { id: 3, sha: S, status: 'running' } }) }],
  ['head_pipeline is null', { forge: forge({ pipeline: null }) }],
];
for (const [what, probe] of T6_WAITS) {
  test(`T6 does not fire while ${what}`, () => {
    const r = run([...toMergeable, tick(probe)]);
    assert.deepEqual(kinds(r.effects, 'merge'), []);
    assert.equal(r.state.stage, 'mergeable');
    // It waits for green; a pipeline still running is not red, and wakes nobody.
    assert.deepEqual(codes(r.effects), []);
    assert.deepEqual(held(r.state), []);
  });
}

test('T6 holds on a merge-tree conflict at merge time, and on a diff that touches a human-only path', () => {
  assert.deepEqual(codes(run([...toMergeable, tick({ mergeTree: 'conflict' })]).effects), ['CONFLICT']);
  assert.deepEqual(codes(run([...toMergeable, tick({ changedFiles: ['web/a.ts', 'deploy/fly/web.toml'] })]).effects), ['OWNER_DECISION']);
});

test('a merge call in flight is not repeated by the next tick', () => {
  const r = run([...toMergeable, tick(), tick(), tick()]);
  assert.equal(kinds(r.effects, 'merge').length, 1);
});

test('the forge refusing the merge (head no longer S) holds the card', () => {
  const r = run([...toMergeable, tick(), { kind: 'merge-result', attempt: ATTEMPT, ok: false, mergeCommit: null, secondParent: null, error: 'SHA does not match HEAD of source branch' }]);
  assert.equal(r.state.stage, 'mergeable');
  assert.deepEqual(codes(r.effects), ['MERGE_REFUSED']);
});

test('with autoMerge off the card waits at mergeable and god is told once that it is ready at S', () => {
  const off = ctx({ autoMerge: false });
  const r = run([...toMergeable, tick(), tick()], off);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.deepEqual(codes(r.effects), ['MERGE_READY']);
  assert.equal(kinds(r.effects, 'exception')[0].sha, S);
});

test('a merge by hand at S (shadow mode) is recorded as merged by out-of-band, and the live check follows', () => {
  const off = ctx({ autoMerge: false });
  const r = run([...toMergeable, tick(), tick({ forge: forge({ state: 'merged', mergeCommit: M }), secondParent: S }), liveOk], off);
  assert.deepEqual(r.transitions.slice(-2), ['mergeable→merged', 'merged→live']);
  assert.equal(r.log.find((l) => l.to === 'merged').by, 'out-of-band');
});

test('a merge by hand from mergeable whose second parent is not S is OUT_OF_BAND, not merged', () => {
  const r = run([...toMergeable, tick({ forge: forge({ state: 'merged', mergeCommit: M }), secondParent: S2 })], ctx({ autoMerge: false }));
  assert.equal(r.state.stage, 'mergeable');
  assert.deepEqual(codes(r.effects), ['OUT_OF_BAND']);
});

test('a merge by hand at a sha nobody confirmed is OUT_OF_BAND', () => {
  const r = run([...toReview, tick({ forge: forge({ state: 'merged', head: S2, mergeCommit: M }), secondParent: S2 })]);
  assert.deepEqual(codes(r.effects), ['OUT_OF_BAND']);
});

// --- T8, holds, pause and resume ---

test('T8: abandon from god, or the MR closed on the forge, ends the card', () => {
  assert.equal(run([...toReview, { kind: 'command', msgId: 'g2', from: GOD, payload: { schema: 'mr.command/1', card: CARD, command: 'abandon' } }]).state.stage, 'abandoned');
  assert.equal(run([...toReview, tick({ forge: forge({ state: 'closed' }) })]).state.stage, 'abandoned');
});

test('the same hold raised twice with the card and sha unchanged reaches god once', () => {
  const r = run([...toMergeable, tick({ mergeTree: 'conflict' }), tick({ mergeTree: 'conflict' }), tick({ mergeTree: 'conflict' })]);
  assert.deepEqual(codes(r.effects), ['CONFLICT']);
});

test('while held nothing moves and nothing merges, however green the probes', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'ABSTAIN'), tick(), tick()]);
  assert.equal(r.state.stage, 'review');
  assert.deepEqual(kinds(r.effects, 'merge'), []);
});

test('pause stops every effect until resume; resume clears a hold', () => {
  const cmd = (command) => ({ kind: 'command', msgId: `g-${command}`, from: GOD, payload: { schema: 'mr.command/1', card: CARD, command } });
  const paused = run([...toMergeable, cmd('pause'), tick()]);
  assert.deepEqual(kinds(paused.effects, 'merge'), []);
  const resumed = run([...toMergeable, cmd('pause'), tick(), cmd('resume'), tick()]);
  assert.equal(kinds(resumed.effects, 'merge').length, 1);
  const held = run([...toMergeable, tick({ mergeTree: 'conflict' }), cmd('resume'), tick()]);
  assert.equal(kinds(held.effects, 'merge').length, 1);
});

test('after a manual fix round (block, fix submitted, god resumes) the card goes round again at the new sha', () => {
  const cmd = (command) => ({ kind: 'command', msgId: `g-${command}`, from: GOD, payload: { schema: 'mr.command/1', card: CARD, command } });
  const fixed = submit({ head_sha: S2, kind: 'fix', dispositions: [{ finding: 'f1', status: 'fixed', commit: S2 }] }, { forge: forge({ head: S2, pipeline: { id: 5, sha: S2, status: 'success' } }) });
  const r2 = (from) => verdict(from, 'CONFIRMED', { reviewed_sha: S2, round: 2, answers: `${CARD}:r2:${from}` }, { forge: forge({ head: S2 }) });
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'BLOCK'), fixed, cmd('resume'),
    tick({ forge: forge({ head: S2, pipeline: { id: 5, sha: S2, status: 'success' } }) }), r2('orsolina-mtx'), r2('jannings-mtx')]);
  assert.equal(r.state.stage, 'mergeable');
  assert.equal(r.state.sha, S2);
  assert.equal(r.state.round, 2);
  assert.deepEqual(kinds(r.effects, 'review-request').map((e) => e.round), [1, 1, 2, 2]);
});

test('a stage past its deadline raises STALLED once', () => {
  const late = (e) => ctx({ now: e.kind === 'tick' ? '2026-11-12T11:30:00.000Z' : '2026-11-12T10:00:00.000Z' });
  const r = run([...toReview, tick(), tick()], late);
  assert.deepEqual(codes(r.effects), ['STALLED']);
});

test('a TAMPER event holds the card', () => {
  const r = run([...toReview, { kind: 'tamper', detail: 'mirror differs' }]);
  assert.deepEqual(codes(r.effects), ['TAMPER']);
});

test('step is pure: the state handed in is never changed', () => {
  const before = run(toReview).state;
  const copy = JSON.parse(JSON.stringify(before));
  step(before, verdict('orsolina-mtx', 'CONFIRMED'), ctx());
  assert.deepEqual(JSON.parse(JSON.stringify(before)), copy);
});

// --- Review of #86: owner decisions, absent evidence, MR shape, merge results, DRIFTED, missing config ---

let cmdSeq = 0;
const cmd = (command) => ({ kind: 'command', msgId: `g-${command}-${++cmdSeq}`, from: GOD, payload: { schema: 'mr.command/1', card: CARD, command } });
const approve = (sha) => ({ kind: 'owner-approval', sha, ref: 'humanQA-1' });
const pd = finding({ id: 'o-PD', class: 'product-decision', severity: 'MED', must_fix: false });

test('A3: a product decision delivered while paused still holds for the owner after resume; nothing merges', () => {
  const r = run([...toReview, cmd('pause'), verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] }), verdict('jannings-mtx', 'CONFIRMED'), cmd('resume'), tick(), tick()]);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  assert.notEqual(r.state.stage, 'mergeable');
});

test('A4: a needs_owner submit delivered while paused still holds after resume', () => {
  const r = run([enrol(), cmd('pause'), submit({ needs_owner: { question: 'VIN optional?' } }), cmd('resume'), tick(), tick()]);
  assert.equal(r.state.stage, 'implementing');
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
});

test('B1: god\'s resume does not clear OWNER_DECISION; it is refused and the card stays held', () => {
  const r = run([enrol(), submit({ needs_owner: { question: 'q' } }), cmd('resume'), tick()]);
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  assert.ok(kinds(r.effects, 'refuse').some((e) => /owner/.test(e.errors.join(' '))));
});

test('an owner approval naming the card\'s exact sha clears OWNER_DECISION, and one for another sha does not', () => {
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] }), verdict('jannings-mtx', 'CONFIRMED'), approve(S2), tick()]);
  assert.deepEqual(held(r.state), ['OWNER_DECISION'], 'approval for another sha');
  const ok = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] }), verdict('jannings-mtx', 'CONFIRMED'), approve(S), tick(), tick()]);
  assert.deepEqual(held(ok.state), []);
  assert.equal(ok.state.stage, 'mergeable');
  assert.equal(kinds(ok.effects, 'merge').length, 1);
});

test('a human-only diff waits for an owner approval at S, then merges', () => {
  const human = { changedFiles: ['deploy/fly/web.toml'] };
  const r = run([...toMergeable, tick(human), cmd('resume'), tick(human)]);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  const ok = run([...toMergeable, tick(human), approve(S), tick(human)]);
  assert.equal(kinds(ok.effects, 'merge').length, 1);
});

test('holds are a set: a second cause is not hidden behind the first, and resume clears only what it may', () => {
  const r = run([...toMergeable, tick({ mergeTree: 'conflict' }), tick({ changedFiles: ['.gitlab-ci.yml'] }), cmd('resume'), tick({ changedFiles: ['.gitlab-ci.yml'] })]);
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
});

test('C1: T6 does not merge when the changed-file probe is absent; the card waits, nobody is woken', () => {
  const r = run([...toMergeable, tick({ changedFiles: undefined }), tick({ changedFiles: null })]);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.deepEqual(codes(r.effects), []);
});

test('C4 / J-M3: an enrolled card whose repo is no longer configured holds, on every event, and never throws', () => {
  const gone = (e) => (e.kind === 'command' && e.payload.command === 'enrol' ? ctx() : ctx({ repo: null }));
  const events = [enrol(), submit(), verdict('orsolina-mtx', 'CONFIRMED'), tick(), mergeOk, cmd('resume'), cmd('pause'), approve(S), { kind: 'tamper', detail: 'x' }];
  let r;
  assert.doesNotThrow(() => { r = run(events, gone); });
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.ok(held(r.state).includes('OFF_PATH'));
  const inReview = (e) => (e.kind === 'verdict' || (e.kind === 'command' && e.payload.command === 'resume') ? ctx({ repo: null }) : ctx());
  assert.doesNotThrow(() => run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'ABSTAIN'), cmd('resume'), verdict('orsolina-mtx', 'BLOCK')], inReview));
});

for (const [what, mr] of [['C3: retargeted to another branch', { target: 'production' }], ['C5: turned into a draft', { draft: true }], ['moved to another source branch', { source: 'other' }]]) {
  test(`T6 re-checks the MR's shape: ${what} after confirmation holds, no merge`, () => {
    const r = run([...toMergeable, tick({ forge: forge(mr) })]);
    assert.deepEqual(kinds(r.effects, 'merge'), []);
    assert.deepEqual(codes(r.effects), ['OFF_PATH']);
  });
}

test('A2 / M3: a stalled card resumes and moves; resume restarts the stage clock', () => {
  const at = (min) => ctx({ now: new Date(Date.parse('2026-11-12T10:00:00.000Z') + min * 60_000).toISOString() });
  const steps = [[enrol(), 0], [submit(), 0], [tick(), 70], [verdict('orsolina-mtx', 'CONFIRMED'), 71], [verdict('jannings-mtx', 'CONFIRMED'), 72], [cmd('resume'), 73], [tick(), 74], [tick(), 75]];
  let state = initialState(CARD); const effects = [];
  for (const [e, min] of steps) { const out = step(state, e, at(min)); state = out.state; effects.push(...out.effects); }
  assert.equal(state.stage, 'mergeable');
  assert.equal(kinds(effects, 'merge').length, 1);
});

test('a hold that comes back after resume tells god again', () => {
  const r = run([...toMergeable, tick({ mergeTree: 'conflict' }), cmd('resume'), tick({ mergeTree: 'conflict' })]);
  assert.deepEqual(codes(r.effects), ['CONFLICT', 'CONFLICT']);
});

test('D8 / M4: one unreadable forge answer is no move and wakes nobody; three in a row hold with OFF_PATH', () => {
  const one = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'CONFIRMED', {}, { forge: null }), tick()]);
  assert.deepEqual(codes(one.effects), []);
  assert.equal(one.state.stage, 'mergeable');
  const three = run([enrol(), submit({}, { forge: null }), tick({ forge: null }), tick({ forge: null })]);
  assert.deepEqual(codes(three.effects), ['OFF_PATH']);
  const two = run([enrol(), submit({}, { forge: null }), tick({ forge: null }), tick()]);
  assert.deepEqual(codes(two.effects), []);
  assert.equal(two.state.stage, 'review');
});

const MERGE_RESULT_IGNORED = [
  ['unsolicited, with no merge in flight', [...toMergeable, mergeOk]],
  ['for another attempt', [...toMergeable, tick(), { ...mergeOk, attempt: `${CARD}:merge:9` }]],
  ['while held (a tamper after the call)', [...toMergeable, tick(), { kind: 'tamper', detail: 'x' }, mergeOk]],
  ['while paused', [...toMergeable, tick(), cmd('pause'), mergeOk]],
];
for (const [what, events] of MERGE_RESULT_IGNORED) {
  test(`J-M1: a merge result ${what} does not move the card`, () => {
    const r = run(events);
    assert.equal(r.state.stage, 'mergeable');
    assert.ok(r.log.some((l) => l.type === 'fact' && /^merge-result/.test(l.fact)));
  });
}

test('J-M1: a successful merge result with no merge commit holds instead of moving', () => {
  const r = run([...toMergeable, tick(), { ...mergeOk, mergeCommit: null }]);
  assert.equal(r.state.stage, 'mergeable');
  assert.deepEqual(codes(r.effects), ['MERGE_REFUSED']);
});

test('J-M1: a duplicate result for the same attempt is idempotent', () => {
  const r = run([...toMergeable, tick(), mergeOk, mergeOk]);
  assert.equal(r.log.filter((l) => l.type === 'transition' && l.to === 'merged').length, 1);
});

test('J-M2: a verdict from a model the vendor does not allow is DRIFTED: kept, not counted, and the review degrades', () => {
  const allowed = ctx({ allowedModels: { anthropic: ['claude-fable-5-2'], openai: ['gpt-5.6-sol'] } });
  const r = run([...toReview, { ...verdict('orsolina-mtx', 'CONFIRMED'), model: 'claude-fable-5-2' }, { ...verdict('jannings-mtx', 'CONFIRMED'), model: 'totally-disallowed' }], allowed);
  assert.notEqual(r.state.stage, 'mergeable');
  assert.equal(r.state.terminal['jannings-mtx'], 'DRIFTED');
  assert.deepEqual(codes(r.effects), ['REVIEW_DEGRADED']);
  assert.ok(r.log.some((l) => l.fact === 'verdict' && l.drifted === true));
  const unknown = run([...toReview, { ...verdict('orsolina-mtx', 'CONFIRMED'), model: null }, { ...verdict('jannings-mtx', 'CONFIRMED'), model: null }], allowed);
  assert.equal(unknown.state.stage, 'mergeable');
});

test('J-M2: a BLOCK from the vendor that is there supersedes the missing-vendor degraded hold', () => {
  const claudeOnly = ctx({ roster: roster.filter((a) => a.provider === 'claude') });
  const r = run([...toReview, verdict('orsolina-mtx', 'BLOCK')], claudeOnly);
  assert.ok(held(r.state).includes('REVIEW_BLOCK_MANUAL'), held(r.state).join(','));
  assert.deepEqual(codes(r.effects), ['REVIEW_DEGRADED', 'REVIEW_BLOCK_MANUAL']);
});

test('a confirmation from the one vendor there never merges past the degraded hold', () => {
  const claudeOnly = ctx({ roster: roster.filter((a) => a.provider === 'claude') });
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED'), tick(), cmd('resume'), tick()], claudeOnly);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.notEqual(r.state.stage, 'mergeable');
});

test('L1: a submit for another card or repo, and a verdict answering another request, are refused', () => {
  assert.equal(kinds(run([enrol(), submit({ card: 'OTHER' })]).effects, 'refuse').length, 1);
  assert.equal(kinds(run([enrol(), submit({ repo: 'dog-eared' })]).effects, 'refuse').length, 1);
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { answers: 'someone-else' })]);
  assert.equal(kinds(r.effects, 'refuse').length, 1);
});

test('L2: a submit after the merge is recorded and does not hold the live check', () => {
  const r = run([...toMergeable, tick(), mergeOk, submit({ head_sha: S2 }), liveOk]);
  assert.equal(r.state.stage, 'live');
});

test('L3: god may resume an OUT_OF_BAND merge at another sha on to the live check', () => {
  const r = run([...toMergeable, tick({ forge: forge({ state: 'merged', mergeCommit: M }), secondParent: S2 }), cmd('resume'), liveOk], ctx({ autoMerge: false }));
  assert.equal(r.state.stage, 'live');
});

test('an owner approval recorded for another sha does not cover a decision raised at S', () => {
  const r = run([...toReview, approve(S2), verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] }), verdict('jannings-mtx', 'CONFIRMED'), tick()]);
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
});

test('a card read against another repo\'s settings holds rather than use them', () => {
  const other = (e) => (e.kind === 'command' ? ctx() : ctx({ repoId: 'dog-eared' }));
  const r = run([...toMergeable, tick()], (e) => (e === toMergeable[0] ? ctx() : other(e)));
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.ok(held(r.state).includes('OFF_PATH'));
});

// --- Second review of #86: an approval answers only what it was given for ---

const askOwner = submit({ needs_owner: { question: 'VIN optional?' } });
const ownerTold = (effects) => kinds(effects, 'exception').filter((e) => e.code === 'OWNER_DECISION');

test('E1: an approval of the implementer\'s question does not answer a product decision raised later at the same sha', () => {
  const r = run([enrol(), askOwner, approve(S), tick(), verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] }), verdict('jannings-mtx', 'CONFIRMED'), tick()]);
  assert.equal(r.state.stage, 'review');
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  assert.equal(ownerTold(r.effects).length, 2, 'the owner is asked again, about the new cause');
});

test('E2: an approval of the implementer\'s question does not cover a diff that touches a human-only path', () => {
  const human = { changedFiles: ['.gitlab-ci.yml'] };
  const r = run([enrol(), askOwner, approve(S), tick(), ...bothConfirm, tick(human)]);
  assert.equal(r.state.stage, 'mergeable');
  assert.deepEqual(held(r.state), ['OWNER_DECISION']);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  const ok = run([enrol(), askOwner, approve(S), tick(), ...bothConfirm, tick(human), approve(S), tick(human)]);
  assert.equal(kinds(ok.effects, 'merge').length, 1, 'approving the path itself lets it merge');
});

test('E3: a product decision inside a BLOCK still goes to the owner, beside the block', () => {
  const blockPd = finding({ id: 'o-PD2', class: 'product-decision', must_fix: true });
  const r = run([...toReview, verdict('orsolina-mtx', 'BLOCK', { findings: [blockPd] }), verdict('jannings-mtx', 'CONFIRMED'), tick()]);
  assert.deepEqual(held(r.state), ['OWNER_DECISION', 'REVIEW_BLOCK_MANUAL']);
  assert.deepEqual(codes(r.effects).sort(), ['OWNER_DECISION', 'REVIEW_BLOCK_MANUAL']);
});

test('a product decision in a degraded round still goes to the owner, beside the degraded hold', () => {
  const claudeOnly = ctx({ roster: roster.filter((a) => a.provider === 'claude') });
  const r = run([...toReview, verdict('orsolina-mtx', 'CONFIRMED', { findings: [pd] })], claudeOnly);
  assert.deepEqual(held(r.state), ['OWNER_DECISION', 'REVIEW_DEGRADED']);
});

test('N1: an MR the forge shows as locked is not merged; once open again it is', () => {
  const r = run([...toMergeable, tick({ forge: forge({ state: 'locked' }) })]);
  assert.deepEqual(kinds(r.effects, 'merge'), []);
  const ok = run([...toMergeable, tick({ forge: forge({ state: 'locked' }) }), tick()]);
  assert.equal(kinds(ok.effects, 'merge').length, 1);
});

test('N2: a refusal that arrives while held does not leave the merge in flight after resume', () => {
  const refused = { kind: 'merge-result', attempt: ATTEMPT, ok: false, mergeCommit: null, secondParent: null, error: 'conflict' };
  const r = run([...toMergeable, tick(), cmd('pause'), refused, cmd('resume'), tick()]);
  assert.deepEqual(kinds(r.effects, 'merge').map((e) => e.attempt), [ATTEMPT, `${CARD}:merge:2`]);
});

test('N3: resume does not send a card with a merge in flight back to implementing', () => {
  const r = run([...toMergeable, tick(), submit({ head_sha: S2 }), cmd('resume')]);
  assert.equal(r.state.stage, 'mergeable');
  assert.equal(r.state.mergeAttempt.id, ATTEMPT);
});

test('N4: an OWNER_DECISION hold lives only as long as its sha; a new head re-derives it', () => {
  const r = run([enrol(), askOwner, submit({ head_sha: S2 }, { forge: forge({ head: S2, pipeline: { id: 100, sha: S2, status: 'success' } }) })]);
  assert.deepEqual(held(r.state), []);
  assert.equal(r.state.stage, 'review');
  assert.equal(r.state.sha, S2);
  const again = run([enrol(), askOwner, submit({ head_sha: S2, needs_owner: { question: 'VIN optional?' } }, { forge: forge({ head: S2 }) })]);
  assert.deepEqual(held(again.state), ['OWNER_DECISION']);
  assert.equal(again.state.holds.OWNER_DECISION.sha, S2);
  assert.equal(ownerTold(again.effects).length, 2, 'asked again at the new sha');
});
