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
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** List caps, so a message cannot be grown without bound (memory, the log, the review bundle). */
const MAX = { findings: 50, dispositions: 50, tests: 20, decisions: 20 };

/**
 * Collects what is wrong with a message, field by field, so a refusal can list every
 * one, and builds a fresh value holding only the schema's own fields. A validator
 * never hands back the sender's object: anything it did not check is not in the result.
 */
function checker() {
  const errors = [];
  const fail = (field, why) => errors.push(`${field}: ${why}`);
  /** Refuses keys outside [allowed] on [obj], reported under [at]. */
  const closed = (obj, allowed, at) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(at ? `${at}.${k}` : k, 'is not a field of this message');
  };
  const str = (field, v, max, { optional = false, nullable = false } = {}) => {
    if (v === undefined && optional) return v;
    if (v === null && nullable) return null;
    if (typeof v !== 'string' || v.length === 0) { fail(field, 'must be a non-empty string'); return v; }
    if (max !== undefined && v.length > max) fail(field, `must be at most ${max} characters`);
    return v;
  };
  const name = (field, v, { nullable = false } = {}) => {
    if (v === null && nullable) return null;
    if (typeof v !== 'string' || !NAME_RE.test(v)) fail(field, 'must be an id (letters, digits, . _ -; at most 80)');
    return v;
  };
  const oneOf = (field, v, allowed) => {
    if (!allowed.includes(v)) fail(field, `must be one of ${allowed.join(', ')}`);
    return v;
  };
  const sha = (field, v, { nullable = false } = {}) => {
    if (v === null && nullable) return null;
    if (typeof v !== 'string' || !SHA_RE.test(v)) fail(field, 'must be a full 40-character lowercase hex sha');
    return v;
  };
  const card = (field, v) => {
    if (typeof v !== 'string' || !CARD_RE.test(v)) fail(field, 'must be a card id (letters, digits, . _ -; at most 80)');
    return v;
  };
  /** A list of at most [max] items, each checked by [each]; returns the rebuilt list. */
  const list = (field, v, max, each) => {
    if (!Array.isArray(v)) { fail(field, 'must be a list'); return []; }
    if (v.length > max) { fail(field, `must have at most ${max} items`); return []; }
    return v.map((item, i) => each(item, `${field}[${i}]`, i));
  };
  /** Refuses a repeated value of [key] across [items], naming the repeat. */
  const unique = (field, items, key) => {
    const seen = new Set();
    items.forEach((it, i) => {
      const k = it && typeof it[key] === 'string' ? it[key] : null;
      if (k === null) return;
      if (seen.has(k)) fail(`${field}[${i}].${key}`, `repeats ${JSON.stringify(k).slice(0, 60)}`);
      seen.add(k);
    });
  };
  const result = (value) => (errors.length === 0 ? { ok: true, value } : { ok: false, errors: [...errors] });
  return { errors, fail, closed, str, name, oneOf, sha, card, list, unique, result };
}

const SUBMIT_KEYS = ['schema', 'card', 'repo', 'mr', 'head_sha', 'kind', 'answers', 'dispositions', 'tests', 'summary', 'decisions_taken', 'needs_owner'];
const VERDICT_KEYS = ['schema', 'card', 'answers', 'reviewed_sha', 'round', 'verdict', 'findings', 'abstain_reason', 'report'];
const FINDING_KEYS = ['id', 'severity', 'must_fix', 'title', 'file', 'line', 'class', 'body'];
const COMMAND_KEYS = ['schema', 'card', 'command', 'args', 'reason'];
const ENROL_KEYS = ['repo', 'implementer', 'branch', 'review_hints', 'risk'];

/** mr.submit/1, section 5.2: an implementer says its MR is ready at a sha. */
function validateSubmit(m) {
  if (!isObject(m)) return { ok: false, errors: ['payload: must be an object'] };
  const c = checker();
  c.closed(m, SUBMIT_KEYS, '');
  if (m.schema !== 'mr.submit/1') c.fail('schema', 'must be mr.submit/1');
  const value = {
    schema: 'mr.submit/1',
    card: c.card('card', m.card),
    repo: c.name('repo', m.repo),
    mr: isInt(m.mr, 1) ? m.mr : (c.fail('mr', 'must be a positive integer'), m.mr),
    head_sha: c.sha('head_sha', m.head_sha),
    kind: c.oneOf('kind', m.kind, SUBMIT_KINDS),
    answers: c.str('answers', m.answers, 200, { nullable: true }),
    dispositions: c.list('dispositions', m.dispositions, MAX.dispositions, (d, at) => {
      if (!isObject(d)) { c.fail(at, 'must be an object'); return null; }
      c.closed(d, ['finding', 'status', 'commit', 'note'], at);
      return {
        finding: c.name(`${at}.finding`, d.finding),
        status: c.oneOf(`${at}.status`, d.status, DISPOSITIONS),
        commit: c.sha(`${at}.commit`, d.commit, { nullable: true }),
        ...(own(d, 'note') ? { note: c.str(`${at}.note`, d.note, 300, { nullable: true }) } : {}),
      };
    }),
    tests: c.list('tests', m.tests, MAX.tests, (t, at) => {
      if (!isObject(t)) { c.fail(at, 'must be an object'); return null; }
      c.closed(t, ['suite', 'passed', 'failed', 'evidence'], at);
      if (!isInt(t.passed, 0)) c.fail(`${at}.passed`, 'must be a whole number');
      if (!isInt(t.failed, 0)) c.fail(`${at}.failed`, 'must be a whole number');
      return {
        suite: c.str(`${at}.suite`, t.suite, 80), passed: t.passed, failed: t.failed,
        ...(own(t, 'evidence') ? { evidence: c.str(`${at}.evidence`, t.evidence, 400, { nullable: true }) } : {}),
      };
    }),
    summary: c.str('summary', m.summary, 1500),
    decisions_taken: c.list('decisions_taken', m.decisions_taken, MAX.decisions, (d, at) => c.str(at, d, 300)),
    needs_owner: null,
  };
  c.unique('dispositions', value.dispositions, 'finding');
  // A fix answers a fix request, by its id.
  if (m.kind === 'fix' && m.answers === null) c.fail('answers', 'a fix names the request it answers');
  if (m.needs_owner !== null) {
    if (!isObject(m.needs_owner)) c.fail('needs_owner', 'must be null or { question }');
    else {
      c.closed(m.needs_owner, ['question'], 'needs_owner');
      value.needs_owner = { question: c.str('needs_owner.question', m.needs_owner.question, 500) };
    }
  }
  return c.result(value);
}

/**
 * mr.verdict/1, sections 5.2 and 7.3. The vocabulary is strict: CONFIRMED means
 * "merge this exact sha as it is", so it cannot carry a must-fix finding; every HIGH
 * is must-fix and no LOW is (the owner's rule: every HIGH blocks, a MED blocks when
 * the reviewer marks it, a LOW never does); BLOCK needs a must-fix finding to block
 * on; ABSTAIN gives a reason and no findings.
 */
function validateVerdict(m) {
  if (!isObject(m)) return { ok: false, errors: ['payload: must be an object'] };
  const c = checker();
  c.closed(m, VERDICT_KEYS, '');
  if (m.schema !== 'mr.verdict/1') c.fail('schema', 'must be mr.verdict/1');
  const findings = c.list('findings', m.findings, MAX.findings, (f, at) => {
    if (!isObject(f)) { c.fail(at, 'must be an object'); return null; }
    c.closed(f, FINDING_KEYS, at);
    if (typeof f.must_fix !== 'boolean') c.fail(`${at}.must_fix`, 'must be true or false');
    if (f.severity === 'HIGH' && f.must_fix !== true) c.fail(`${at}.must_fix`, 'a HIGH finding must be must_fix: true');
    if (f.severity === 'LOW' && f.must_fix === true) c.fail(`${at}.must_fix`, 'a LOW finding never blocks: raise it to MED, or mark it must_fix: false');
    if (f.line !== undefined && f.line !== null && !isInt(f.line, 1)) c.fail(`${at}.line`, 'must be a positive integer or null');
    return {
      id: c.name(`${at}.id`, f.id),
      severity: c.oneOf(`${at}.severity`, f.severity, SEVERITIES),
      must_fix: f.must_fix,
      title: c.str(`${at}.title`, f.title, 120),
      file: c.str(`${at}.file`, f.file === undefined ? null : f.file, 400, { nullable: true }),
      line: f.line === undefined ? null : f.line,
      class: c.oneOf(`${at}.class`, f.class, FINDING_CLASSES),
      body: c.str(`${at}.body`, f.body, 600),
    };
  });
  c.unique('findings', findings, 'id');
  const mustFix = findings.filter((f) => f && f.must_fix === true).length;
  if (m.verdict === 'CONFIRMED' && mustFix > 0) {
    c.fail('verdict', 'CONFIRMED cannot carry a must-fix finding: send BLOCK, or mark the finding must_fix: false');
  }
  if (m.verdict === 'BLOCK' && mustFix === 0) c.fail('verdict', 'BLOCK needs at least one must-fix finding');
  let abstain = null;
  if (m.verdict === 'ABSTAIN') {
    abstain = c.oneOf('abstain_reason', m.abstain_reason, ABSTAIN_REASONS);
    if (findings.length > 0) c.fail('findings', 'ABSTAIN carries no findings');
  } else if (m.abstain_reason !== null && m.abstain_reason !== undefined) {
    c.fail('abstain_reason', 'must be null unless the verdict is ABSTAIN');
  }
  if (!isInt(m.round, 1)) c.fail('round', 'must be a positive integer');
  return c.result({
    schema: 'mr.verdict/1',
    card: c.card('card', m.card),
    answers: c.str('answers', m.answers, 200),
    reviewed_sha: c.sha('reviewed_sha', m.reviewed_sha),
    round: m.round,
    verdict: c.oneOf('verdict', m.verdict, VERDICTS),
    findings,
    abstain_reason: abstain,
    report: c.str('report', m.report === undefined ? null : m.report, 400, { nullable: true }),
  });
}

/** mr.command/1, section 5.2, as far as the steel thread goes: enrol, resume, pause, abandon. */
function validateCommand(m) {
  if (!isObject(m)) return { ok: false, errors: ['payload: must be an object'] };
  const c = checker();
  c.closed(m, COMMAND_KEYS, '');
  if (m.schema !== 'mr.command/1') c.fail('schema', 'must be mr.command/1');
  const value = {
    schema: 'mr.command/1',
    card: c.card('card', m.card),
    command: c.oneOf('command', m.command, COMMANDS),
    args: {},
    reason: c.str('reason', m.reason === undefined ? null : m.reason, 300, { nullable: true }),
  };
  const args = m.args === undefined ? {} : m.args;
  if (!isObject(args)) c.fail('args', 'must be an object');
  else if (m.command === 'enrol') {
    c.closed(args, ENROL_KEYS, 'args');
    value.args = {
      repo: c.name('args.repo', args.repo),
      implementer: c.name('args.implementer', args.implementer),
      branch: c.str('args.branch', args.branch, 200),
      review_hints: c.str('args.review_hints', args.review_hints === undefined ? null : args.review_hints, 800, { nullable: true }),
      risk: c.str('args.risk', args.risk === undefined ? null : args.risk, 40, { nullable: true }),
    };
  } else {
    // resume, pause and abandon take no arguments.
    c.closed(args, [], 'args');
  }
  return c.result(value);
}

/** Validators by schema name. A Map, so a name like "constructor" or "__proto__" finds nothing. */
const VALIDATORS = new Map([['mr.submit/1', validateSubmit], ['mr.verdict/1', validateVerdict], ['mr.command/1', validateCommand]]);

/** Validates any agent-sent payload by its schema name. Unknown schemas are refused. */
function validatePayload(m) {
  if (!isObject(m) || typeof m.schema !== 'string') return { ok: false, errors: ['payload.schema: must name a schema'] };
  const v = VALIDATORS.get(m.schema);
  if (!v) return { ok: false, errors: [`payload.schema: unknown schema ${JSON.stringify(m.schema).slice(0, 60)}`] };
  return v(m);
}

// The log chain, section 12.3. Each line carries `prev`, the sha256 of the line
// before it exactly as written; the first line's `prev` is the hash of nothing.
const GENESIS = crypto.createHash('sha256').update('').digest('hex');
const hashLine = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Checks a whole log file's text: every line parses, `seq` counts up from 1, `v`
 * is 1, `card` is [opts.card] when given, and each `prev` is the hash of the line
 * before. This cannot see the newest lines removed or edited: the store keeps a
 * head anchor for that. A file must end in a newline
 * (each line is flushed whole), so a torn last line is reported, not skipped.
 */
function verifyLogText(text, opts = {}) {
  if (text === '') return { ok: true, count: 0, last: GENESIS };
  if (!text.endsWith('\n')) return { ok: false, line: text.split('\n').length, reason: 'the last line is incomplete' };
  const lines = text.slice(0, -1).split('\n');
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { return { ok: false, line: i + 1, reason: 'not JSON' }; }
    if (!isObject(entry)) return { ok: false, line: i + 1, reason: 'not an object' };
    if (entry.seq !== i + 1) return { ok: false, line: i + 1, reason: `seq is ${entry.seq}, expected ${i + 1}` };
    if (entry.v !== 1) return { ok: false, line: i + 1, reason: `unknown log version ${JSON.stringify(entry.v)}` };
    if (opts.card !== undefined && entry.card !== opts.card) return { ok: false, line: i + 1, reason: `the line is for card ${JSON.stringify(entry.card)}` };
    if (entry.prev !== prev) return { ok: false, line: i + 1, reason: 'prev does not match the line before' };
    prev = hashLine(lines[i]);
  }
  return { ok: true, count: lines.length, last: prev };
}

// — strict JSON —
//
// JSON.parse keeps the last copy of a name given twice, and another reader may keep
// the first, so one text can mean two things. Text from outside the app (an agent's
// message, a forge or deploy answer) goes through this parser instead: a name given
// twice in one object is refused (names compared after unescaping), as is anything
// JSON.parse would reject, deeper than MAX_DEPTH or longer than MAX_TEXT. It returns
// a refusal and never throws. A "__proto__" name is an own property, as JSON.parse
// makes it, never a prototype.

const MAX_DEPTH = 64;
const MAX_TEXT = 4 * 1024 * 1024;

class JsonRefusal extends Error {}

function parseJson(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not text' };
  if (text.length > MAX_TEXT) return { ok: false, reason: `longer than ${MAX_TEXT} characters` };
  let i = 0;
  const fail = (why) => { throw new JsonRefusal(`${why} at offset ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    if (text[i] !== '"') fail('expected a string');
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c < ' ') fail('a control character in a string');
      if (c !== '\\') { out += c; i++; continue; }
      const e = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (e !== undefined && Object.hasOwn(simple, e)) {
        out += simple[e];
        i += 2;
      } else {
        fail('a bad escape');
      }
    }
  };
  const value = (depth) => {
    if (depth > MAX_DEPTH) fail(`nested deeper than ${MAX_DEPTH}`);
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) fail(`the name ${JSON.stringify(k).slice(0, 40)} given twice`);
        seen.add(k);
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        Object.defineProperty(obj, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('expected a value');
    i += m[0].length;
    return Number(m[0]);
  };
  try {
    const v = value(0);
    ws();
    if (i !== text.length) fail('text after the value');
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof JsonRefusal) return { ok: false, reason: e.message };
    return { ok: false, reason: 'not JSON' };
  }
}

module.exports = {
  SHA_RE, CARD_RE, NAME_RE, SUBMIT_KINDS, VERDICTS, SEVERITIES, FINDING_CLASSES, ABSTAIN_REASONS, COMMANDS,
  validateSubmit, validateVerdict, validateCommand, validatePayload,
  GENESIS, hashLine, verifyLogText,
  parseJson,
};
