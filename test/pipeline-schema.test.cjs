'use strict';
// The pipeline's structured messages (spec sections 5.2 and 7.3). A message that
// breaks a rule is refused with every failed field named, so the sender can fix it
// in one go. The verdict vocabulary is the important part: CONFIRMED means "merge
// this exact sha as it is", so it may not carry a must-fix finding.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/main/pipeline/mr-core.cjs');

const S = 'eecd72bae05026701fee211b6c96774e33585587';

const submit = (over = {}) => ({
  schema: 'mr.submit/1', card: 'WF-FB-VEHICLES', repo: 'wayfarer', mr: 181, head_sha: S,
  kind: 'initial', answers: null, dispositions: [], tests: [{ suite: 'api', passed: 1964, failed: 0, evidence: 'hive/evidence/x.txt' }],
  summary: 'Vehicles: VIN is optional.', decisions_taken: [], needs_owner: null, ...over,
});
const finding = (over = {}) => ({
  id: 'orsolina-R1-M1', severity: 'MED', must_fix: true, title: 'Odometer can go back', file: 'web/src/a.ts', line: 88,
  class: 'defect', body: 'A reading lower than the last is accepted.', ...over,
});
const verdict = (over = {}) => ({
  schema: 'mr.verdict/1', card: 'WF-FB-VEHICLES', answers: 'pipeline-req-1', reviewed_sha: S, round: 1,
  verdict: 'CONFIRMED', findings: [], abstain_reason: null, report: 'hive/evidence/r.md', ...over,
});
const command = (over = {}) => ({
  schema: 'mr.command/1', card: 'WF-FB-VEHICLES', command: 'enrol',
  args: { repo: 'wayfarer', implementer: 'marinette-mtcz0zuv', branch: 'feat/vehicles' }, reason: 'pilot', ...over,
});

const errorsOf = (r) => (r.ok ? [] : r.errors.join(' | '));

test('a well-formed submit, verdict and command are accepted as they are', () => {
  for (const m of [submit(), verdict(), command()]) {
    const r = core.validatePayload(m);
    assert.equal(r.ok, true, errorsOf(r));
    assert.equal(r.value, m);
  }
});

// [description, verdict overrides, field the refusal must name]
const VERDICT_RULES = [
  ['CONFIRMED with a must-fix finding', { verdict: 'CONFIRMED', findings: [finding()] }, 'verdict'],
  ['a HIGH finding that is not must-fix', { verdict: 'CONFIRMED', findings: [finding({ severity: 'HIGH', must_fix: false })] }, 'findings[0].must_fix'],
  ['BLOCK with no must-fix finding', { verdict: 'BLOCK', findings: [finding({ must_fix: false })] }, 'verdict'],
  ['BLOCK with no findings at all', { verdict: 'BLOCK', findings: [] }, 'verdict'],
  ['ABSTAIN with no reason', { verdict: 'ABSTAIN', abstain_reason: null }, 'abstain_reason'],
  ['ABSTAIN with findings', { verdict: 'ABSTAIN', abstain_reason: 'tooling', findings: [finding({ must_fix: false })] }, 'findings'],
  ['a reason on a verdict that is not ABSTAIN', { verdict: 'CONFIRMED', abstain_reason: 'capacity' }, 'abstain_reason'],
  ['a short sha', { reviewed_sha: S.slice(0, 8) }, 'reviewed_sha'],
  ['an uppercase sha', { reviewed_sha: S.toUpperCase() }, 'reviewed_sha'],
  ['round 0', { round: 0 }, 'round'],
  ['an unknown verdict word', { verdict: 'LGTM' }, 'verdict'],
  ['a finding of an unknown class', { verdict: 'BLOCK', findings: [finding({ class: 'nit' })] }, 'findings[0].class'],
  ['a finding body over 600 characters', { verdict: 'BLOCK', findings: [finding({ body: 'x'.repeat(601) })] }, 'findings[0].body'],
];

for (const [what, over, field] of VERDICT_RULES) {
  test(`a verdict is refused for ${what}, naming ${field}`, () => {
    const r = core.validateVerdict(verdict(over));
    assert.equal(r.ok, false, `${what} was accepted`);
    assert.ok(r.errors.some((e) => e.startsWith(`${field}:`)), `no error on ${field}: ${r.errors.join(' | ')}`);
  });
}

// The ones that must be accepted, so the rules above are not just "refuse everything".
const VERDICT_ALLOWED = [
  ['CONFIRMED with non-blocking findings (a LOW and a MED the reviewer lets through)', { findings: [finding({ severity: 'LOW', must_fix: false }), finding({ id: 'o-M2', must_fix: false })] }],
  ['BLOCK on one MED', { verdict: 'BLOCK', findings: [finding()] }],
  ['BLOCK on a HIGH', { verdict: 'BLOCK', findings: [finding({ severity: 'HIGH' })] }],
  ['ABSTAIN with a reason and no findings', { verdict: 'ABSTAIN', abstain_reason: 'safety-refusal' }],
  ['a finding with no file or line', { verdict: 'BLOCK', findings: [finding({ file: null, line: null })] }],
];
for (const [what, over] of VERDICT_ALLOWED) {
  test(`a verdict is accepted for ${what}`, () => {
    const r = core.validateVerdict(verdict(over));
    assert.equal(r.ok, true, errorsOf(r));
  });
}

const SUBMIT_RULES = [
  ['a short head sha', { head_sha: S.slice(0, 12) }, 'head_sha'],
  ['an MR number of 0', { mr: 0 }, 'mr'],
  ['an unknown kind', { kind: 'hotfix' }, 'kind'],
  ['a summary over 1500 characters', { summary: 'x'.repeat(1501) }, 'summary'],
  ['a disposition with an unknown status', { dispositions: [{ finding: 'f', status: 'ignored', commit: null }] }, 'dispositions[0].status'],
  ['a disposition commit that is not a full sha', { dispositions: [{ finding: 'f', status: 'fixed', commit: 'abc' }] }, 'dispositions[0].commit'],
  ['a negative test count', { tests: [{ suite: 'web', passed: -1, failed: 0 }] }, 'tests[0].passed'],
  ['needs_owner with no question', { needs_owner: {} }, 'needs_owner.question'],
  ['a card id with a slash in it', { card: '../tasks' }, 'card'],
];
for (const [what, over, field] of SUBMIT_RULES) {
  test(`a submit is refused for ${what}, naming ${field}`, () => {
    const r = core.validateSubmit(submit(over));
    assert.equal(r.ok, false, `${what} was accepted`);
    assert.ok(r.errors.some((e) => e.startsWith(`${field}:`)), `no error on ${field}: ${r.errors.join(' | ')}`);
  });
}

test('a refusal lists every failed field at once, not just the first', () => {
  const r = core.validateSubmit(submit({ head_sha: 'abc', mr: -2, kind: 'x' }));
  assert.equal(r.ok, false);
  for (const field of ['head_sha', 'mr', 'kind']) assert.ok(r.errors.some((e) => e.startsWith(`${field}:`)), field);
});

const COMMAND_RULES = [
  ['a command the steel thread does not run', { command: 'waive-finding' }, 'command'],
  ['enrol without a branch', { args: { repo: 'wayfarer', implementer: 'm-1' } }, 'args.branch'],
  ['enrol with an implementer that is not an agent id', { args: { repo: 'wayfarer', implementer: 'a b', branch: 'x' } }, 'args.implementer'],
  ['review hints over 800 characters', { args: { repo: 'w', implementer: 'm', branch: 'b', review_hints: 'x'.repeat(801) } }, 'args.review_hints'],
];
for (const [what, over, field] of COMMAND_RULES) {
  test(`a command is refused for ${what}, naming ${field}`, () => {
    const r = core.validateCommand(command(over));
    assert.equal(r.ok, false, `${what} was accepted`);
    assert.ok(r.errors.some((e) => e.startsWith(`${field}:`)), `no error on ${field}: ${r.errors.join(' | ')}`);
  });
}

test('resume, pause and abandon need no args', () => {
  for (const c of ['resume', 'pause', 'abandon']) {
    const r = core.validateCommand(command({ command: c, args: undefined }));
    assert.equal(r.ok, true, `${c}: ${errorsOf(r)}`);
  }
});

test('an unknown or missing schema is refused by name, and nothing else is guessed', () => {
  assert.deepEqual(core.validatePayload({ schema: 'mr.merge/1' }).ok, false);
  assert.match(core.validatePayload({ schema: 'mr.merge/1' }).errors[0], /unknown schema/);
  assert.equal(core.validatePayload(null).ok, false);
  assert.equal(core.validatePayload({ card: 'x' }).ok, false);
  // A payload is routed by its schema: a verdict sent as a submit is a submit, and fails as one.
  assert.equal(core.validatePayload({ ...verdict(), schema: 'mr.submit/1' }).ok, false);
});
