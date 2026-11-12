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
const codes = (effects) => kinds(effects, 'exception').map((e) => e.code);

const toReview = [enrol(), submit()];
const bothConfirm = [verdict('orsolina-mtx', 'CONFIRMED'), verdict('jannings-mtx', 'CONFIRMED')];
const toMergeable = [...toReview, ...bothConfirm];
const mergeOk = { kind: 'merge-result', ok: true, mergeCommit: M, secondParent: S };
const liveOk = tick({ live: { deployed: D, mergeIsAncestor: true } });

// --- The straight path (acceptance 1.5, first block) ---

test('the straight path: implementing → review → mergeable → merged → live, with one merge call at S', () => {
  const r = run([...toMergeable, tick(), mergeOk, tick({ forge: forge({ state: 'merged', mergeCommit: M }) }), liveOk]);
  assert.deepEqual(r.transitions, ['∅→implementing', 'implementing→review', 'review→mergeable', 'mergeable→merged', 'merged→live']);
  assert.deepEqual(kinds(r.effects, 'merge'), [{ kind: 'merge', mr: 181, sha: S }]);
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
  ['the forge cannot be read', { forge: null }, 'OFF_PATH'],
];
for (const [what, probe, code] of T2_HOLDS) {
  test(`T2 holds with ${code} when ${what}`, () => {
    const r = run([enrol(), submit({}, probe)]);
    assert.equal(r.state.stage, 'implementing');
    assert.equal(r.state.hold.code, code);
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
  assert.equal(r.state.hold, null);
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
    assert.equal(r.state.hold, null);
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
  const r = run([...toMergeable, tick(), { kind: 'merge-result', ok: false, mergeCommit: null, secondParent: null, error: 'SHA does not match HEAD of source branch' }]);
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
