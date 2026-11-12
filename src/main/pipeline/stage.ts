/**
 * The merge-request pipeline's stage machine, as far as the steel thread goes
 * (spec 6.2; steel-thread ST-5). Pure: `step(state, event, ctx)` returns the next
 * state, the log entries to append, and the effects for the conductor to carry out.
 *
 * An agent's message is a claim; a probe is evidence. The conductor runs every
 * probe and hands its result in with the event, so each guard here reads a probe
 * result, never what an agent said.
 *
 * The thread automates the straight path only: T1 enrol, T2 implementing → review,
 * T3 review → mergeable, T6 mergeable → merged, T7 merged → live, T8 abandon.
 * Every other outcome sets a hold and wakes god once per (card, code, sha). While a
 * hold is set, or the card is paused, facts are still recorded but nothing moves
 * and no effect goes out. God clears a hold with `resume`.
 */
import { matchesAny, type RepoPipeline, type Vendor } from './config';
import { choosePanel, combine, type RosterAgent, type TerminalState } from './panel';
import type { CommandPayload, EnrolArgs, Finding, Sha, SubmitPayload, VerdictPayload } from './schema';
import type { LogEntry } from './store';

export type Stage = 'implementing' | 'review' | 'mergeable' | 'merged' | 'live' | 'abandoned';

/**
 * What can hold a card in the thread. REVIEW_BLOCK_MANUAL, HEAD_MOVED, MERGE_READY and
 * OFF_PATH exist only in the thread: a block waits for god to route the fix by hand,
 * any head change holds (no rebase classification yet), autoMerge-off tells god a card
 * is ready, and anything else off the straight path holds under one code.
 */
export type HoldCode =
  | 'REVIEW_BLOCK_MANUAL' | 'REVIEW_DEGRADED' | 'STALLED' | 'CONFLICT' | 'PIPELINE_RED' | 'HEAD_MOVED'
  | 'OUT_OF_BAND' | 'OWNER_DECISION' | 'MERGE_REFUSED' | 'TAMPER' | 'OFF_PATH';
export type NoticeCode = HoldCode | 'MERGE_READY';

export interface ForgeMr {
  state: 'opened' | 'merged' | 'closed' | 'locked';
  draft: boolean;
  head: Sha;
  source: string;
  target: string;
  pipeline: { id: number; sha: Sha; status: string } | null;
  mergeCommit: Sha | null;
}

export interface Request { reviewer: string; vendor: Vendor; requestId: string }
export interface CountedVerdict { reviewer: string; vendor: Vendor; model: string | null; msg: string; payload: VerdictPayload }

export interface CardState {
  card: string;
  repo: string | null;
  branch: string | null;
  implementer: string | null;
  mr: number | null;
  stage: Stage | null;
  stageSince: string | null;
  round: number;
  /** The head the current stage is about: S once a submit is accepted. */
  sha: Sha | null;
  hold: { code: HoldCode; sha: Sha | null; at: string } | null;
  paused: boolean;
  /** The latest submit claim, waiting for its probe (implementing) or for god (held). */
  submit: { msg: string; payload: SubmitPayload } | null;
  requests: Request[];
  terminal: Record<string, TerminalState>;
  verdicts: Record<string, CountedVerdict>;
  mergeInFlight: boolean;
  mergeCommit: Sha | null;
  deployed: Sha | null;
  followups: Finding[];
  /** Dedupe keys `${code}|${sha}` already sent to god. */
  raised: string[];
}

export interface StepCtx {
  now: string;
  /** The id of the repo the event's card is enrolled in, or is asking to be enrolled in. */
  repoId: string;
  /** That repo's settings, or null when it is not in the operator config. */
  repo: RepoPipeline | null;
  autoMerge: boolean;
  deadlineMin: number;
  godId: string;
  roster: RosterAgent[];
}

type Probe = { forge: ForgeMr | null; mergeTree?: 'clean' | 'conflict' | null };

export type StepEvent =
  | { kind: 'command'; msgId: string; from: string; payload: CommandPayload; openMrsForBranch?: number }
  | ({ kind: 'submit'; msgId: string; from: string; payload: SubmitPayload } & Probe)
  | { kind: 'verdict'; msgId: string; from: string; payload: VerdictPayload; model: string | null; forge: ForgeMr | null }
  | ({
      kind: 'tick';
      changedFiles?: string[];
      /** The second parent of the forge's merge commit, read from the mirror, when the forge shows the MR merged. */
      secondParent?: Sha | null;
      live?: { deployed: Sha | null; mergeIsAncestor: boolean | null } | null;
    } & Probe)
  | { kind: 'merge-result'; ok: boolean; mergeCommit: Sha | null; secondParent: Sha | null; error?: string }
  | { kind: 'tamper'; detail: string };

export type StepEffect =
  | { kind: 'review-request'; reviewer: string; vendor: Vendor; requestId: string; sha: Sha; round: number }
  | { kind: 'merge'; mr: number; sha: Sha }
  | { kind: 'exception'; code: NoticeCode; sha: Sha | null; stage: Stage | null; round: number; detail: string }
  | { kind: 'refuse'; to: string; msgId: string; errors: string[] };

export interface StepResult { state: CardState; log: LogEntry[]; effects: StepEffect[] }

export function initialState(card: string): CardState {
  return {
    card, repo: null, branch: null, implementer: null, mr: null, stage: null, stageSince: null, round: 1, sha: null,
    hold: null, paused: false, submit: null, requests: [], terminal: {}, verdicts: {}, mergeInFlight: false,
    mergeCommit: null, deployed: null, followups: [], raised: [],
  };
}

const TERMINAL: Stage[] = ['live', 'abandoned'];
const WAITING_PIPELINE = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual'];

/** One event in; the next state, log entries and effects out. The state handed in is not changed. */
export function step(prev: CardState, event: StepEvent, ctx: StepCtx): StepResult {
  const s: CardState = structuredClone(prev);
  const log: LogEntry[] = [];
  const effects: StepEffect[] = [];
  const quiet = () => s.hold !== null || s.paused;

  const move = (to: Stage, by: string, trigger: Record<string, unknown>, evidence: Record<string, unknown> = {}) => {
    log.push({ type: 'transition', repo: s.repo, mr: s.mr, from: s.stage, to, round: s.round, sha: s.sha, by, trigger, evidence });
    s.stage = to;
    s.stageSince = ctx.now;
  };
  const fact = (name: string, data: Record<string, unknown> = {}) => log.push({ type: 'fact', fact: name, ...data });
  const notify = (code: NoticeCode, detail: string) => {
    const key = `${code}|${s.sha ?? ''}`;
    if (s.raised.includes(key)) return;
    s.raised.push(key);
    effects.push({ kind: 'exception', code, sha: s.sha, stage: s.stage, round: s.round, detail });
  };
  const hold = (code: HoldCode, detail: string) => {
    if (s.hold === null) {
      s.hold = { code, sha: s.sha, at: ctx.now };
      log.push({ type: 'hold', code, sha: s.sha, detail });
    } else {
      fact('hold-also', { code, detail });
    }
    notify(code, detail);
  };
  const refuse = (to: string, msgId: string, errors: string[]) => {
    fact('refused', { msg: msgId, from: to, errors });
    effects.push({ kind: 'refuse', to, msgId, errors });
  };

  /** Sends the round's review requests to one reviewer per vendor (T2's last step). */
  const requestReviews = () => {
    const repo = ctx.repo as RepoPipeline;
    const { reviewers, missing } = choosePanel(repo.panel, ctx.roster);
    s.requests = reviewers.map((r) => ({ ...r, requestId: `${s.card}:r${s.round}:${r.reviewer}` }));
    s.terminal = Object.fromEntries(s.requests.map((r) => [r.reviewer, null]));
    s.verdicts = {};
    for (const r of s.requests) effects.push({ kind: 'review-request', reviewer: r.reviewer, vendor: r.vendor, requestId: r.requestId, sha: s.sha as Sha, round: s.round });
    if (missing.length > 0) hold('REVIEW_DEGRADED', `no live reviewer for ${missing.join(', ')}`);
  };

  /** T2's guards on the latest submit, against the forge as probed now. */
  const tryT2 = (probe: Probe, trigger: Record<string, unknown>) => {
    const claim = s.submit?.payload;
    if (!claim) return;
    const f = probe.forge;
    if (!f) return hold('OFF_PATH', 'the forge could not be read for the submitted MR');
    if (f.state === 'closed') return move('abandoned', 'harness', trigger, { forge: f });
    if (f.state !== 'opened') return hold('OUT_OF_BAND', `the MR is ${f.state} before review`);
    if (f.draft) return hold('OFF_PATH', 'the MR is a draft');
    if (f.source !== s.branch) return hold('OFF_PATH', `the MR's source branch is ${f.source}, not ${s.branch}`);
    if (f.target !== ctx.repo?.target) return hold('OFF_PATH', `the MR targets ${f.target}, not ${ctx.repo?.target}`);
    if (f.head !== claim.head_sha) return hold('HEAD_MOVED', `the forge head is ${f.head}, the submit names ${claim.head_sha}`);
    const p = f.pipeline;
    if (!p || p.sha !== f.head || WAITING_PIPELINE.includes(p.status)) {
      fact('awaiting-pipeline', { pipeline: p });
      return;
    }
    if (p.status !== 'success') return hold('PIPELINE_RED', `pipeline ${p.id} on ${p.sha} is ${p.status}`);
    if (probe.mergeTree === 'conflict') return hold('CONFLICT', 'merge-tree of the target and the head is not clean');
    if (probe.mergeTree !== 'clean') return;
    s.sha = f.head;
    move('review', 'harness', trigger, { forge: f, pipeline: p, mergeTree: 'clean' });
    requestReviews();
  };

  /** The panel rule, once every requested reviewer is terminal for S (T3, or a hold). */
  const decide = (forgeNow: ForgeMr | null, trigger: Record<string, unknown>) => {
    const repo = ctx.repo as RepoPipeline;
    const outcome = combine(s.requests.map((r) => ({ vendor: r.vendor, state: s.terminal[r.reviewer] ?? null })), repo.minVendors);
    if (outcome === 'pending') return;
    const counted = Object.values(s.verdicts);
    const evidence = {
      verdicts: counted.map((v) => ({ reviewer: v.reviewer, vendor: v.vendor, model: v.model, verdict: v.payload.verdict, msg: v.msg })),
      rule: outcome, forge_head: forgeNow?.head ?? null,
    };
    if (outcome === 'block') {
      fact('panel', evidence);
      return hold('REVIEW_BLOCK_MANUAL', `blocked at round ${s.round}: ${counted.flatMap((v) => v.payload.findings.filter((x) => x.must_fix).map((x) => x.id)).join(', ')}`);
    }
    if (outcome === 'degraded') {
      fact('panel', evidence);
      return hold('REVIEW_DEGRADED', 'not every vendor has a counted answer');
    }
    if (!forgeNow) return hold('OFF_PATH', 'the forge could not be read at confirmation');
    if (forgeNow.head !== s.sha) return hold('HEAD_MOVED', `confirmed ${s.sha} but the forge head is now ${forgeNow.head}`);
    s.followups = counted.flatMap((v) => v.payload.findings.filter((x) => !x.must_fix));
    move('mergeable', 'harness', trigger, evidence);
  };

  /** Requested reviewers who left the roster before answering are UNAVAILABLE. */
  const markGone = () => {
    for (const r of s.requests) {
      if (s.terminal[r.reviewer] === null && !ctx.roster.some((a) => a.id === r.reviewer && !a.archived)) {
        s.terminal[r.reviewer] = 'UNAVAILABLE';
        fact('reviewer-unavailable', { reviewer: r.reviewer, why: 'not on the roster' });
      }
    }
  };

  const stalled = () => {
    if (!s.stageSince || s.stage === null || TERMINAL.includes(s.stage)) return false;
    if (s.stage === 'mergeable' && !ctx.autoMerge) return false;
    return Date.parse(ctx.now) - Date.parse(s.stageSince) > ctx.deadlineMin * 60_000;
  };

  switch (event.kind) {
    case 'command': {
      const { payload: cmd, from, msgId } = event;
      const trigger = { kind: 'message', id: msgId };
      if (from !== ctx.godId) { refuse(from, msgId, ['mr.command is accepted only from god']); break; }
      if (cmd.command === 'enrol') {
        const args = cmd.args as EnrolArgs;
        if (s.stage !== null) { refuse(from, msgId, [`card ${s.card} is already enrolled (${s.stage})`]); break; }
        if (args.repo !== ctx.repoId || !ctx.repo) { refuse(from, msgId, [`args.repo: ${args.repo} is not in the pipeline's configuration`]); break; }
        if ((event.openMrsForBranch ?? 0) > 1) { refuse(from, msgId, [`args.branch: ${args.branch} has ${event.openMrsForBranch} open MRs`]); break; }
        s.repo = args.repo; s.branch = args.branch; s.implementer = args.implementer;
        move('implementing', 'god', trigger, { repo: args.repo, implementer: args.implementer, branch: args.branch });
        break;
      }
      if (s.stage === null || TERMINAL.includes(s.stage)) { refuse(from, msgId, [`card ${s.card} is not active in the pipeline`]); break; }
      if (cmd.command === 'abandon') { s.hold = null; s.paused = false; move('abandoned', 'god', trigger); break; }
      if (cmd.command === 'pause') { s.paused = true; fact('paused', { msg: msgId }); break; }
      // resume: clear the pause and the hold. A submit that arrived while held starts the card
      // round again from implementing; after a block that is the next review round.
      const was = s.hold?.code ?? null;
      s.paused = false;
      s.hold = null;
      fact('resumed', { msg: msgId, cleared: was });
      if (s.submit && s.submit.payload.head_sha !== s.sha && (s.stage === 'review' || s.stage === 'mergeable')) {
        if (was === 'REVIEW_BLOCK_MANUAL') s.round += 1;
        move('implementing', 'god', trigger, { submit: s.submit.msg });
        s.requests = []; s.terminal = {}; s.verdicts = {};
      } else if (s.stage === 'review' && was === 'REVIEW_DEGRADED') {
        // Ask again where there is no counted answer; the panel rule still needs two vendors.
        const keep = s.requests.filter((r) => s.terminal[r.reviewer] === 'CONFIRMED' || s.terminal[r.reviewer] === 'BLOCK');
        const { reviewers } = choosePanel((ctx.repo as RepoPipeline).panel, ctx.roster);
        for (const r of reviewers.filter((x) => !keep.some((k) => k.vendor === x.vendor))) {
          const req = { ...r, requestId: `${s.card}:r${s.round}:${r.reviewer}:again` };
          s.requests = [...s.requests.filter((q) => q.vendor !== r.vendor), req];
          s.terminal[r.reviewer] = null;
          effects.push({ kind: 'review-request', reviewer: r.reviewer, vendor: r.vendor, requestId: req.requestId, sha: s.sha as Sha, round: s.round });
        }
      }
      break;
    }

    case 'submit': {
      const { payload, from, msgId } = event;
      if (s.stage === null || TERMINAL.includes(s.stage)) { refuse(from, msgId, [`card ${s.card} is not active in the pipeline`]); break; }
      if (from !== s.implementer) { refuse(from, msgId, [`only ${s.implementer} submits for ${s.card}`]); break; }
      if (s.mr !== null && payload.mr !== s.mr) { refuse(from, msgId, [`mr: the card's MR is !${s.mr}`]); break; }
      s.submit = { msg: msgId, payload };
      s.mr = payload.mr;
      fact('submit', { msg: msgId, head: payload.head_sha, kind: payload.kind });
      if (quiet()) break;
      if (payload.needs_owner) { hold('OWNER_DECISION', payload.needs_owner.question); break; }
      if (s.stage === 'implementing') tryT2(event, { kind: 'message', id: msgId });
      else if (payload.head_sha !== s.sha) hold('HEAD_MOVED', `a new submit at ${payload.head_sha} while ${s.stage} at ${s.sha}`);
      break;
    }

    case 'verdict': {
      const { payload: v, from, msgId } = event;
      const req = s.requests.find((r) => r.reviewer === from);
      if (s.stage !== 'review' || !req) { refuse(from, msgId, [`no review of ${s.card} is waiting on ${from}`]); break; }
      if (v.reviewed_sha !== s.sha || v.round !== s.round) {
        fact('verdict-stale', { msg: msgId, from, reviewed_sha: v.reviewed_sha, round: v.round });
        refuse(from, msgId, [`reviewed_sha: the current sha is ${s.sha}, round ${s.round}`]);
        break;
      }
      const before = s.verdicts[from];
      if (before && JSON.stringify(before.payload) === JSON.stringify(v)) { fact('verdict-duplicate', { msg: msgId, from }); break; }
      s.verdicts[from] = { reviewer: from, vendor: req.vendor, model: event.model, msg: msgId, payload: v };
      s.terminal[from] = v.verdict;
      fact('verdict', { msg: msgId, from, vendor: req.vendor, model: event.model, verdict: v.verdict, replaces: before?.msg ?? null });
      if (quiet()) break;
      if (v.findings.some((f) => f.class === 'product-decision')) { hold('OWNER_DECISION', `a product decision in ${from}'s review`); break; }
      decide(event.forge, { kind: 'message', id: msgId });
      break;
    }

    case 'tick': {
      if (s.stage === null || TERMINAL.includes(s.stage) || quiet()) break;
      const trigger = { kind: 'tick' };
      const f = event.forge;
      if (f?.state === 'closed') { move('abandoned', 'harness', trigger, { forge: f }); break; }
      if (stalled()) { hold('STALLED', `${s.stage} for longer than ${ctx.deadlineMin} min`); break; }

      if (s.stage === 'implementing') { tryT2(event, trigger); break; }

      if (s.stage === 'review') {
        if (f?.state === 'merged') { hold('OUT_OF_BAND', `merged on the forge at ${f.head} while in review`); break; }
        if (f && f.head !== s.sha) { hold('HEAD_MOVED', `the forge head moved from ${s.sha} to ${f.head}`); break; }
        markGone();
        decide(f, trigger);
        break;
      }

      if (s.stage === 'mergeable') {
        if (!f) break;
        if (f.state === 'merged') {
          if (f.mergeCommit && event.secondParent === s.sha) {
            s.mergeCommit = f.mergeCommit;
            s.mergeInFlight = false;
            move('merged', 'out-of-band', trigger, { forge: f, second_parent: event.secondParent });
          } else {
            hold('OUT_OF_BAND', `merged on the forge, but not at the confirmed ${s.sha}`);
          }
          break;
        }
        if (s.mergeInFlight) break;
        if (f.head !== s.sha) { hold('HEAD_MOVED', `the forge head moved from ${s.sha} to ${f.head}`); break; }
        const p = f.pipeline;
        if (!p || p.sha !== s.sha || WAITING_PIPELINE.includes(p.status)) break;
        if (p.status !== 'success') { hold('PIPELINE_RED', `pipeline ${p.id} on ${p.sha} is ${p.status}`); break; }
        if (event.mergeTree === 'conflict') { hold('CONFLICT', 'merge-tree of the target and S is not clean'); break; }
        if (event.mergeTree !== 'clean') break;
        const human = (event.changedFiles ?? []).filter((path) => matchesAny(path, ctx.repo?.humanOnlyPaths ?? []));
        if (human.length > 0) { hold('OWNER_DECISION', `the diff touches human-only paths: ${human.join(', ')}`); break; }
        if (!ctx.autoMerge) { notify('MERGE_READY', `ready to merge !${s.mr} at ${s.sha}`); break; }
        s.mergeInFlight = true;
        fact('merge-guards', { forge: f, pipeline: p, mergeTree: 'clean' });
        effects.push({ kind: 'merge', mr: s.mr as number, sha: s.sha as Sha });
        break;
      }

      if (s.stage === 'merged') {
        const live = event.live;
        if (live && live.deployed && live.mergeIsAncestor === true) {
          s.deployed = live.deployed;
          move('live', 'harness', trigger, { deployed: live.deployed, merge_commit: s.mergeCommit });
        }
      }
      break;
    }

    case 'merge-result': {
      if (s.stage !== 'mergeable') { fact('merge-result-late', { ok: event.ok }); break; }
      s.mergeInFlight = false;
      if (!event.ok) { hold('MERGE_REFUSED', event.error ?? 'the forge refused the merge'); break; }
      if (event.secondParent !== s.sha) {
        hold('MERGE_REFUSED', `merge commit ${event.mergeCommit} has second parent ${event.secondParent}, not ${s.sha}`);
        break;
      }
      s.mergeCommit = event.mergeCommit;
      move('merged', 'harness', { kind: 'effect', id: 'merge' }, { merge_commit: event.mergeCommit, second_parent: event.secondParent });
      break;
    }

    case 'tamper': {
      hold('TAMPER', event.detail);
      break;
    }
  }

  return { state: s, log, effects };
}
