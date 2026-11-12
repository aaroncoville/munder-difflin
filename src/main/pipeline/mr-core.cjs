'use strict';
// The merge-request pipeline's message rules and log chain, in plain JavaScript.
//
// Two programs need exactly these rules: the main process, which accepts or
// refuses each structured message, and the agent-side `hive-mr` CLI, which
// checks a message before writing it. The CLI runs under plain `node` outside
// the app bundle, so the rules live in this one sidecar and both require it
// (the kg-core.cjs pattern). schema.ts gives the main process its types.
//
// Nothing here touches the disk or the network.

const crypto = require('node:crypto');

const SHA_RE = /^[0-9a-f]{40}$/;
/** A card id is also a directory name, so it is held to a safe alphabet. */
const CARD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const SUBMIT_KINDS = ['initial', 'fix', 'rebase', 'pipeline-fix'];
const DISPOSITIONS = ['fixed', 'declined', 'deferred'];
const VERDICTS = ['CONFIRMED', 'BLOCK', 'ABSTAIN'];
const SEVERITIES = ['HIGH', 'MED', 'LOW'];
const FINDING_CLASSES = ['defect', 'security', 'test-gap', 'product-decision', 'style'];
const ABSTAIN_REASONS = ['safety-refusal', 'tooling', 'capacity', 'out-of-scope'];
/** The commands the steel thread accepts. The rest of section 5.2's list comes later. */
const COMMANDS = ['enrol', 'resume', 'pause', 'abandon'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min) => Number.isInteger(v) && v >= min;

/** Collects what is wrong with a message, field by field, so a refusal can list every one. */
function checker(value) {
  const errors = [];
  const fail = (field, why) => errors.push(`${field}: ${why}`);
  const str = (field, v, max, { optional = false, nullable = false } = {}) => {
    if (v === undefined && optional) return;
    if (v === null && nullable) return;
    if (typeof v !== 'string' || v.length === 0) return fail(field, 'must be a non-empty string');
    if (max !== undefined && v.length > max) fail(field, `must be at most ${max} characters`);
  };
  const oneOf = (field, v, allowed) => {
    if (!allowed.includes(v)) fail(field, `must be one of ${allowed.join(', ')}`);
  };
  const sha = (field, v, { nullable = false } = {}) => {
    if (v === null && nullable) return;
    if (typeof v !== 'string' || !SHA_RE.test(v)) fail(field, 'must be a full 40-character lowercase hex sha');
  };
  const card = (field, v) => {
    if (typeof v !== 'string' || !CARD_RE.test(v)) fail(field, 'must be a card id (letters, digits, . _ -; at most 80)');
  };
  return { value, errors, fail, str, oneOf, sha, card };
}

function result(c) {
  return c.errors.length === 0 ? { ok: true, value: c.value } : { ok: false, errors: c.errors };
}

/** mr.submit/1, section 5.2: an implementer says its MR is ready at a sha. */
function validateSubmit(m) {
  const c = checker(m);
  if (!isObject(m)) return { ok: false, errors: ['payload: must be an object'] };
  if (m.schema !== 'mr.submit/1') c.fail('schema', 'must be mr.submit/1');
  c.card('card', m.card);
  c.str('repo', m.repo, 80);
  if (!isInt(m.mr, 1)) c.fail('mr', 'must be a positive integer');
  c.sha('head_sha', m.head_sha);
  c.oneOf('kind', m.kind, SUBMIT_KINDS);
  c.str('answers', m.answers, 200, { nullable: true });
  if (!Array.isArray(m.dispositions)) c.fail('dispositions', 'must be a list');
  else m.dispositions.forEach((d, i) => {
    const at = `dispositions[${i}]`;
    if (!isObject(d)) return c.fail(at, 'must be an object');
    c.str(`${at}.finding`, d.finding, 200);
    c.oneOf(`${at}.status`, d.status, DISPOSITIONS);
    c.sha(`${at}.commit`, d.commit, { nullable: true });
    c.str(`${at}.note`, d.note, 300, { optional: true, nullable: true });
  });
  if (!Array.isArray(m.tests)) c.fail('tests', 'must be a list');
  else m.tests.forEach((t, i) => {
    const at = `tests[${i}]`;
    if (!isObject(t)) return c.fail(at, 'must be an object');
    c.str(`${at}.suite`, t.suite, 80);
    if (!isInt(t.passed, 0)) c.fail(`${at}.passed`, 'must be a whole number');
    if (!isInt(t.failed, 0)) c.fail(`${at}.failed`, 'must be a whole number');
    c.str(`${at}.evidence`, t.evidence, 400, { optional: true, nullable: true });
  });
  c.str('summary', m.summary, 1500);
  if (!Array.isArray(m.decisions_taken)) c.fail('decisions_taken', 'must be a list');
  else m.decisions_taken.forEach((d, i) => c.str(`decisions_taken[${i}]`, d, 300));
  if (m.needs_owner !== null) {
    if (!isObject(m.needs_owner)) c.fail('needs_owner', 'must be null or { question }');
    else c.str('needs_owner.question', m.needs_owner.question, 500);
  }
  return result(c);
}

/**
 * mr.verdict/1, sections 5.2 and 7.3. The vocabulary is strict: CONFIRMED means
 * "merge this exact sha as it is", so it cannot carry a must-fix finding; a HIGH
 * finding is always must-fix; BLOCK needs a must-fix finding to block on; ABSTAIN
 * gives a reason and no findings.
 */
function validateVerdict(m) {
  const c = checker(m);
  if (!isObject(m)) return { ok: false, errors: ['payload: must be an object'] };
  if (m.schema !== 'mr.verdict/1') c.fail('schema', 'must be mr.verdict/1');
  c.card('card', m.card);
  c.str('answers', m.answers, 200);
  c.sha('reviewed_sha', m.reviewed_sha);
  if (!isInt(m.round, 1)) c.fail('round', 'must be a positive integer');
  c.oneOf('verdict', m.verdict, VERDICTS);
  const findings = Array.isArray(m.findings) ? m.findings : null;
  if (!findings) c.fail('findings', 'must be a list');
  else findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isObject(f)) return c.fail(at, 'must be an object');
    c.str(`${at}.id`, f.id, 200);
    c.oneOf(`${at}.severity`, f.severity, SEVERITIES);
    if (typeof f.must_fix !== 'boolean') c.fail(`${at}.must_fix`, 'must be true or false');
    c.str(`${at}.title`, f.title, 120);
    c.str(`${at}.file`, f.file, 400, { optional: true, nullable: true });
    if (f.line !== undefined && f.line !== null && !isInt(f.line, 1)) c.fail(`${at}.line`, 'must be a positive integer or null');
    c.oneOf(`${at}.class`, f.class, FINDING_CLASSES);
    c.str(`${at}.body`, f.body, 600);
    if (f.severity === 'HIGH' && f.must_fix !== true) c.fail(`${at}.must_fix`, 'a HIGH finding must be must_fix: true');
  });
  const mustFix = findings ? findings.filter((f) => isObject(f) && f.must_fix === true).length : 0;
  if (m.verdict === 'CONFIRMED' && mustFix > 0) {
    c.fail('verdict', 'CONFIRMED cannot carry a must-fix finding: send BLOCK, or mark the finding must_fix: false');
  }
  if (m.verdict === 'BLOCK' && mustFix === 0) c.fail('verdict', 'BLOCK needs at least one must-fix finding');
  if (m.verdict === 'ABSTAIN') {
    c.oneOf('abstain_reason', m.abstain_reason, ABSTAIN_REASONS);
    if (findings && findings.length > 0) c.fail('findings', 'ABSTAIN carries no findings');
  } else if (m.abstain_reason !== null && m.abstain_reason !== undefined) {
    c.fail('abstain_reason', 'must be null unless the verdict is ABSTAIN');
  }
  c.str('report', m.report, 400, { optional: true, nullable: true });
  return result(c);
}

/** mr.command/1, section 5.2, as far as the steel thread goes: enrol, resume, pause, abandon. */
function validateCommand(m) {
  const c = checker(m);
  if (!isObject(m)) return { ok: false, errors: ['payload: must be an object'] };
  if (m.schema !== 'mr.command/1') c.fail('schema', 'must be mr.command/1');
  c.card('card', m.card);
  c.oneOf('command', m.command, COMMANDS);
  const args = m.args === undefined ? {} : m.args;
  if (!isObject(args)) c.fail('args', 'must be an object');
  else if (m.command === 'enrol') {
    c.str('args.repo', args.repo, 80);
    if (typeof args.implementer !== 'string' || !NAME_RE.test(args.implementer)) c.fail('args.implementer', 'must be an agent id');
    c.str('args.branch', args.branch, 200);
    c.str('args.review_hints', args.review_hints, 800, { optional: true, nullable: true });
    c.str('args.risk', args.risk, 40, { optional: true, nullable: true });
  }
  c.str('reason', m.reason, 300, { optional: true, nullable: true });
  return result(c);
}

const VALIDATORS = { 'mr.submit/1': validateSubmit, 'mr.verdict/1': validateVerdict, 'mr.command/1': validateCommand };

/** Validates any agent-sent payload by its schema name. Unknown schemas are refused. */
function validatePayload(m) {
  if (!isObject(m) || typeof m.schema !== 'string') return { ok: false, errors: ['payload.schema: must name a schema'] };
  const v = VALIDATORS[m.schema];
  if (!v) return { ok: false, errors: [`payload.schema: unknown schema ${JSON.stringify(m.schema).slice(0, 60)}`] };
  return v(m);
}

// The log chain, section 12.3. Each line carries `prev`, the sha256 of the line
// before it exactly as written; the first line's `prev` is the hash of nothing.
const GENESIS = crypto.createHash('sha256').update('').digest('hex');
const hashLine = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Checks a whole log file's text: every line parses, `seq` counts up from 1,
 * and each `prev` is the hash of the line before. A file must end in a newline
 * (each line is flushed whole), so a torn last line is reported, not skipped.
 */
function verifyLogText(text) {
  if (text === '') return { ok: true, count: 0 };
  if (!text.endsWith('\n')) return { ok: false, line: text.split('\n').length, reason: 'the last line is incomplete' };
  const lines = text.slice(0, -1).split('\n');
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { return { ok: false, line: i + 1, reason: 'not JSON' }; }
    if (!isObject(entry)) return { ok: false, line: i + 1, reason: 'not an object' };
    if (entry.seq !== i + 1) return { ok: false, line: i + 1, reason: `seq is ${entry.seq}, expected ${i + 1}` };
    if (entry.prev !== prev) return { ok: false, line: i + 1, reason: 'prev does not match the line before' };
    prev = hashLine(lines[i]);
  }
  return { ok: true, count: lines.length, last: prev };
}

module.exports = {
  SHA_RE, CARD_RE, NAME_RE, SUBMIT_KINDS, VERDICTS, SEVERITIES, FINDING_CLASSES, ABSTAIN_REASONS, COMMANDS,
  validateSubmit, validateVerdict, validateCommand, validatePayload,
  GENESIS, hashLine, verifyLogText,
};
