#!/usr/bin/env node
'use strict';
/**
 * hive-mr: how an agent talks to the merge-request pipeline (spec 5.1 and 5.2).
 *
 *   hive-mr submit  --card C --repo R --mr N --kind initial|fix|rebase|pipeline-fix --summary TEXT
 *                   [--answers REQUEST] [--dispositions-file F] [--tests-file F]
 *                   [--decisions-file F] [--needs-owner QUESTION]
 *   hive-mr verdict --request MESSAGE-ID --verdict CONFIRMED|BLOCK|ABSTAIN
 *                   [--findings-file F] [--abstain-reason R] [--report PATH]
 *   hive-mr verify-log --file PATH [--card C]
 *
 * It fills every sha itself: `submit` reads the head from git in the current folder
 * and refuses unless the branch's upstream has the same commit; `verdict` copies the
 * card, round, sha and request id from the review request it answers, which must be in
 * this agent's inbox and come from the pipeline. It validates the payload with the same
 * core the app uses, and writes the outbox message whole (a temp file, then a rename).
 * Anything it cannot fill or that does not validate is refused (exit 2) and nothing is
 * written. Files given to it are read as strict JSON: a name given twice is refused.
 *
 * Run by agents, never by the app. Exit codes: 0 done, 1 a log that does not verify,
 * 2 refused.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function loadCore() {
  const candidates = [
    path.join(__dirname, 'mr-core.cjs'),                                // packaged: beside this file in resources
    path.join(__dirname, '..', 'src', 'main', 'pipeline', 'mr-core.cjs'), // dev repo: resources/ -> src/main/pipeline/
    path.join(__dirname, '..', 'main', 'mr-core.cjs'),                  // built: out/main next to a copied cli
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* try the next */ }
  }
  refuse(['the pipeline core (mr-core.cjs) was not found beside hive-mr']);
}

function refuse(errors) {
  process.stderr.write(`hive-mr: refused:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(2);
}

/** --name value pairs; a flag given twice, or without a value, is refused. */
function flags(argv, allowed) {
  const out = new Map();
  const errors = [];
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (typeof k !== 'string' || !k.startsWith('--') || !allowed.includes(k.slice(2))) { errors.push(`unknown argument ${JSON.stringify(k)}`); continue; }
    if (v === undefined || v.startsWith('--')) { errors.push(`${k} needs a value`); continue; }
    if (out.has(k.slice(2))) { errors.push(`${k} given twice`); continue; }
    out.set(k.slice(2), v);
  }
  if (errors.length) refuse(errors);
  return out;
}

/** A JSON file given on the command line, read strictly. */
function jsonFile(core, file, what) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { refuse([`${what}: cannot read ${file}: ${e.code ?? e.message}`]); }
  const r = core.parseJson(text);
  if (!r.ok) refuse([`${what}: ${r.reason}`]);
  return r.value;
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  } catch {
    return null;
  }
}

function agent() {
  const id = process.env.AGENT_ID;
  const dir = process.env.AGENT_DIR;
  if (!id || !dir || !path.isAbsolute(dir)) refuse(['AGENT_ID and AGENT_DIR must be set (they are, in an agent\'s session)']);
  return { id, dir };
}

/** Writes [msg] into this agent's outbox whole: a temp file, synced, then renamed. Returns the file's name. */
function writeOutbox(dir, msg) {
  const outbox = path.join(dir, 'outbox');
  const name = `${msg.id}.json`;
  const tmp = path.join(outbox, `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
  try {
    fs.writeSync(fd, `${JSON.stringify(msg, null, 1)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(outbox, name));
  return name;
}

const messageId = (who) => `${who.replace(/[^A-Za-z0-9-]/g, '')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function validated(core, payload) {
  const r = core.validatePayload(payload);
  if (!r.ok) refuse(r.errors);
  return r.value;
}

function submit(core, argv) {
  const f = flags(argv, ['card', 'repo', 'mr', 'kind', 'summary', 'answers', 'dispositions-file', 'tests-file', 'decisions-file', 'needs-owner']);
  const me = agent();
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (!head || !core.SHA_RE.test(head)) refuse(['this folder is not a git worktree with a commit checked out']);
  const upstream = git(['rev-parse', '--verify', '@{upstream}']);
  if (!upstream) refuse(['the branch has no upstream: push it first (git push -u origin <branch>)']);
  if (upstream !== head) refuse([`the remote branch head is ${upstream}, not ${head}: push first, then submit`]);
  const mrText = f.get('mr');
  const payload = {
    schema: 'mr.submit/1',
    card: f.get('card'),
    repo: f.get('repo'),
    mr: mrText !== undefined && /^[0-9]+$/.test(mrText) ? Number(mrText) : mrText,
    head_sha: head,
    kind: f.get('kind'),
    answers: f.get('answers') ?? null,
    dispositions: f.has('dispositions-file') ? jsonFile(core, f.get('dispositions-file'), 'dispositions') : [],
    tests: f.has('tests-file') ? jsonFile(core, f.get('tests-file'), 'tests') : [],
    summary: f.get('summary'),
    decisions_taken: f.has('decisions-file') ? jsonFile(core, f.get('decisions-file'), 'decisions') : [],
    needs_owner: f.has('needs-owner') ? { question: f.get('needs-owner') } : null,
  };
  const value = validated(core, payload);
  const id = messageId(me.id);
  const name = writeOutbox(me.dir, {
    id, conversation: value.card, in_reply_to: value.answers, from: me.id, to: 'pipeline', act: 'done',
    subject: `${value.card}: ${value.kind} submit of !${value.mr} at ${head.slice(0, 12)}`,
    body: `Submitted !${value.mr} at ${head} (${value.kind}) with hive-mr.`, requires_reply: false, payload: value,
  });
  process.stdout.write(`hive-mr: submitted !${value.mr} at ${head} as outbox/${name}\n`);
}

/** The review request [id] in this agent's inbox (or its .done), read strictly; it must come from the pipeline. */
function readRequest(core, dir, id) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || id.startsWith('.')) refuse([`--request: ${JSON.stringify(id).slice(0, 60)} is not a message id`]);
  for (const where of ['inbox', path.join('inbox', '.done')]) {
    const file = path.join(dir, where, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    const r = core.parseJson(fs.readFileSync(file, 'utf8'));
    if (!r.ok) refuse([`the request ${id}: ${r.reason}`]);
    const m = r.value;
    const own = (o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined);
    if (own(m, 'from') !== 'pipeline') refuse([`the message ${id} is not from the pipeline`]);
    const p = own(m, 'payload');
    const errors = [];
    if (own(p, 'schema') !== 'mr.review-request/1') errors.push('its payload is not a review request');
    if (typeof own(p, 'card') !== 'string' || !core.CARD_RE.test(own(p, 'card'))) errors.push('its card is not a card id');
    if (typeof own(p, 'sha') !== 'string' || !core.SHA_RE.test(own(p, 'sha'))) errors.push('its sha is not a full sha');
    if (!Number.isSafeInteger(own(p, 'round')) || own(p, 'round') < 1) errors.push('its round is not a round');
    if (typeof own(p, 'request_id') !== 'string' || own(p, 'request_id') === '') errors.push('it has no request id');
    if (errors.length) refuse(errors.map((e) => `the request ${id}: ${e}`));
    return { card: own(p, 'card'), sha: own(p, 'sha'), round: own(p, 'round'), requestId: own(p, 'request_id') };
  }
  refuse([`no message ${id} in this agent's inbox`]);
}

function verdict(core, argv) {
  const f = flags(argv, ['request', 'verdict', 'findings-file', 'abstain-reason', 'report']);
  const me = agent();
  if (!f.has('request')) refuse(['--request: the id of the review request this answers']);
  const req = readRequest(core, me.dir, f.get('request'));
  const payload = {
    schema: 'mr.verdict/1',
    card: req.card,
    answers: req.requestId,
    reviewed_sha: req.sha,
    round: req.round,
    verdict: f.get('verdict'),
    findings: f.has('findings-file') ? jsonFile(core, f.get('findings-file'), 'findings') : [],
    abstain_reason: f.get('abstain-reason') ?? null,
    ...(f.has('report') ? { report: f.get('report') } : {}),
  };
  const value = validated(core, payload);
  const name = writeOutbox(me.dir, {
    id: messageId(me.id), conversation: value.card, in_reply_to: f.get('request'), from: me.id, to: 'pipeline', act: 'done',
    subject: `${value.card}: ${value.verdict} at ${value.reviewed_sha.slice(0, 12)}, round ${value.round}`,
    body: `Verdict ${value.verdict} on ${value.reviewed_sha}, round ${value.round}, with hive-mr.`, requires_reply: false, payload: value,
  });
  process.stdout.write(`hive-mr: ${value.verdict} at ${value.reviewed_sha} as outbox/${name}\n`);
}

function verifyLog(core, argv) {
  const f = flags(argv, ['file', 'card']);
  if (!f.has('file')) refuse(['--file: the card log to check (<app data>/pipeline/_export/<card>/log.jsonl)']);
  let text;
  try { text = fs.readFileSync(f.get('file'), 'utf8'); } catch (e) { refuse([`cannot read ${f.get('file')}: ${e.code ?? e.message}`]); }
  const r = core.verifyLogText(text, f.has('card') ? { card: f.get('card') } : {});
  if (!r.ok) {
    process.stdout.write(`hive-mr: the log does not verify: line ${r.line}: ${r.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`hive-mr: the chain is whole: ${r.count} lines\n`);
}

function main() {
  const core = loadCore();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'submit') return submit(core, rest);
  if (cmd === 'verdict') return verdict(core, rest);
  if (cmd === 'verify-log') return verifyLog(core, rest);
  refuse([`unknown command ${JSON.stringify(cmd ?? '')}: use submit, verdict or verify-log`]);
}

main();
