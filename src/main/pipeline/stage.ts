/**
 * The merge-request pipeline's stage machine, as far as the steel thread goes
 * (spec 6.2; steel-thread ST-5). Pure: `step(state, event, ctx)` returns the next
 * state, the log entries to append, and the effects for the conductor to carry out.
 * It never throws on any state and event; anything it cannot decide is a hold.
 *
 * An agent's message is a claim; a probe is evidence. The conductor runs every
 * probe and hands its result in with the event, so each guard here reads a probe
 * result, never what an agent said. A probe that is absent stops the transition
 * it guards: unknown is never read as "fine".
 *
 * The thread automates the straight path only: T1 enrol, T2 implementing → review,
 * T3 review → mergeable, T6 mergeable → merged, T7 merged → live, T8 abandon.
 * Every other outcome holds the card. A card can be held for several causes at once
 * (a set, so a second cause never hides behind the first); god is woken once per
 * (card, code, sha), and again if a cause returns after god resumed it. While any
 * hold is set, or the card is paused, facts are still recorded but nothing moves
 * and no effect goes out.
 *
 * Owner decisions are derived, not remembered: on every evaluation, a submit's
 * `needs_owner`, a counted verdict's product-decision finding, or a diff touching a
 * human-only path holds the card with OWNER_DECISION unless an owner approval for
 * that exact sha is on record. God's `resume` clears every other hold, never that
 * one (spec 9: no command from god substitutes for the owner).
 */
import { matchesAny, type RepoPipeline, type Vendor } from './config';
import { choosePanel, combine, type RosterAgent, type TerminalState } from './panel';
import type { CommandPayload, EnrolArgs, Finding, Sha, SubmitPayload, VerdictPayload } from './schema';
import type { LogEntry } from './store';

export type Stage = 'implementing' | 'review' | 'mergeable' | 'merged' | 'live' | 'abandoned';

/**
 * What can hold a card in the thread. REVIEW_BLOCK_MANUAL, HEAD_MOVED and OFF_PATH
 * exist only in the thread: a block waits for god to route the fix by hand, any head
 * change holds (no rebase classification yet), and anything else off the straight
 * path holds under one code (including a repo that left the operator config, and
 * the forge unreadable several ticks running).
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
export interface Hold { sha: Sha | null; at: string; detail: string }

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
  /** Every cause the card is held for. Empty: not held. */
  holds: Partial<Record<HoldCode, Hold>>;
  paused: boolean;
  /** The latest submit claim, waiting for its probe (implementing) or for god (held). */
  submit: { msg: string; payload: SubmitPayload } | null;
  requests: Request[];
  terminal: Record<string, TerminalState>;
  /** Counted verdicts for the current sha and round. A DRIFTED verdict is logged, not kept here. */
  verdicts: Record<string, CountedVerdict>;
  /** The merge call in flight, by its attempt id; results for any other attempt are ignored. */
  mergeAttempt: { id: string; sha: Sha } | null;
  mergeAttempts: number;
  mergeCommit: Sha | null;
  /** A forge merge seen at a sha nobody confirmed, kept so god can resume it on to the live check. */
  outOfBandMerge: Sha | null;
  deployed: Sha | null;
  followups: Finding[];
  /** Shas the owner approved through the app's own answer path. */
  ownerApprovals: Sha[];
  /** Consecutive events whose forge probe could not be read. */
  forgeMisses: number;
  /** Dedupe keys `${code}|${sha}` already sent to god. */
  raised: string[];
}

export interface StepCtx {
  now: string;
  /** The id of the repo the event's card is enrolled in, or is asking to be enrolled in. */
  repoId: string;
  /** That repo's settings, or null when it is not (or no longer) in the operator config. */
  repo: RepoPipeline | null;
  autoMerge: boolean;
  deadlineMin: number;
  godId: string;
  roster: RosterAgent[];
  /** Per vendor, the reviewer models a verdict may come from. Absent: no drift check. */
  allowedModels?: Partial<Record<Vendor, string[]>>;
  /** Consecutive unreadable forge answers before OFF_PATH. Default 3. */
  forgeMissLimit?: number;
}

type Probe = { forge: ForgeMr | null; mergeTree?: 'clean' | 'conflict' | null };

export type StepEvent =
  | { kind: 'command'; msgId: string; from: string; payload: CommandPayload; openMrsForBranch?: number }
  | ({ kind: 'submit'; msgId: string; from: string; payload: SubmitPayload } & Probe)
  | { kind: 'verdict'; msgId: string; from: string; payload: VerdictPayload; model: string | null; forge: ForgeMr | null }
  | ({
      kind: 'tick';
      /** The MR's changed paths against the target. Absent or null: unknown, and T6 does not fire. */
      changedFiles?: string[] | null;
      /** The second parent of the forge's merge commit, read from the mirror, when the forge shows the MR merged. */
      secondParent?: Sha | null;
      live?: { deployed: Sha | null; mergeIsAncestor: boolean | null } | null;
    } & Probe)
  | { kind: 'merge-result'; attempt: string; ok: boolean; mergeCommit: Sha | null; secondParent: Sha | null; error?: string }
  /** The owner's approval, from the app's own answer path (never from a message), for one exact sha. */
  | { kind: 'owner-approval'; sha: Sha; ref: string }
  | { kind: 'tamper'; detail: string };

export type StepEffect =
  | { kind: 'review-request'; reviewer: string; vendor: Vendor; requestId: string; sha: Sha; round: number }
  | { kind: 'merge'; mr: number; sha: Sha; attempt: string }
  | { kind: 'exception'; code: NoticeCode; sha: Sha | null; stage: Stage | null; round: number; detail: string }
  | { kind: 'refuse'; to: string; msgId: string; errors: string[] };

export interface StepResult { state: CardState; log: LogEntry[]; effects: StepEffect[] }

export function initialState(card: string): CardState {
  return {
    card, repo: null, branch: null, implementer: null, mr: null, stage: null, stageSince: null, round: 1, sha: null,
    holds: {}, paused: false, submit: null, requests: [], terminal: {}, verdicts: {}, mergeAttempt: null, mergeAttempts: 0,
    mergeCommit: null, outOfBandMerge: null, deployed: null, followups: [], ownerApprovals: [], forgeMisses: 0, raised: [],
  };
}

const TERMINAL: Stage[] = ['live', 'abandoned'];
const WAITING_PIPELINE = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual'];
const SHA_RE = /^[0-9a-f]{40}$/;

/** One event in; the next state, log entries and effects out. The state handed in is not changed. */
export function step(prev: CardState, event: StepEvent, ctx: StepCtx): StepResult {
  const s: CardState = structuredClone(prev);
  const log: LogEntry[] = [];
  const effects: StepEffect[] = [];
  const holdCodes = () => Object.keys(s.holds) as HoldCode[];
  const quiet = () => holdCodes().length > 0 || s.paused;

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
    if (!s.holds[code]) {
      s.holds[code] = { sha: s.sha, at: ctx.now, detail };
      log.push({ type: 'hold', code, sha: s.sha, detail });
    }
    notify(code, detail);
  };
  const refuse = (to: string, msgId: string, errors: string[]) => {
    fact('refused', { msg: msgId, from: to, errors });
    effects.push({ kind: 'refuse', to, msgId, errors });
  };

  /** The repo's settings for an enrolled card, or null (and a hold) when it left the operator config. */
  const repoOrHold = (): RepoPipeline | null => {
    if (ctx.repo && ctx.repoId === s.repo) return ctx.repo;
    hold('OFF_PATH', `repo ${s.repo} is not in the pipeline's configuration`);
    return null;
  };

  /** Whether the forge could be read; a few misses in a row are a hold, one is just no move. */
  const forgeRead = (f: ForgeMr | null): f is ForgeMr => {
    if (f) { s.forgeMisses = 0; return true; }
    s.forgeMisses += 1;
    fact('forge-unreadable', { misses: s.forgeMisses });
    if (s.forgeMisses >= (ctx.forgeMissLimit ?? 3)) hold('OFF_PATH', `the forge could not be read ${s.forgeMisses} times running`);
    return false;
  };

  /** The MR's shape as the card needs it, or why not (T2's checks, re-run at T3 and T6). */
  const shapeProblem = (f: ForgeMr, repo: RepoPipeline): string | null => {
    if (f.draft) return 'the MR is a draft';
    if (f.source !== s.branch) return `the MR's source branch is ${f.source}, not ${s.branch}`;
    if (f.target !== repo.target) return `the MR targets ${f.target}, not ${repo.target}`;
    return null;
  };

  /** Why the owner must decide at [sha], or null: derived afresh on every evaluation. */
  const ownerNeeded = (sha: Sha | null, changedFiles?: string[]): string | null => {
    if (sha && s.ownerApprovals.includes(sha)) return null;
    const claim = s.submit?.payload;
    if (claim?.needs_owner && claim.head_sha === sha) return claim.needs_owner.question;
    const pd = Object.values(s.verdicts).find((v) => v.payload.findings.some((f) => f.class === 'product-decision'));
    if (pd) return `a product decision in ${pd.reviewer}'s review`;
    const human = (changedFiles ?? []).filter((p) => matchesAny(p, ctx.repo?.humanOnlyPaths ?? []));
    if (human.length > 0) return `the diff touches human-only paths: ${human.join(', ')}`;
    return null;
  };

  /** Sends the round's review requests to one reviewer per vendor (T2's last step). */
  const requestReviews = (repo: RepoPipeline) => {
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
    const repo = repoOrHold();
    if (!repo) return;
    const owner = ownerNeeded(claim.head_sha);
    if (owner) return hold('OWNER_DECISION', owner);
    if (!forgeRead(probe.forge)) return;
    const f = probe.forge;
    if (f.state === 'closed') return move('abandoned', 'harness', trigger, { forge: f });
    if (f.state !== 'opened') return hold('OUT_OF_BAND', `the MR is ${f.state} before review`);
    const shape = shapeProblem(f, repo);
    if (shape) return hold('OFF_PATH', shape);
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
    requestReviews(repo);
  };

  /**
   * The panel rule, once every requested reviewer is terminal for S (T3, or a hold).
   * A BLOCK decides even under a degraded hold: one vendor's block does not wait for
   * the vendor that is missing (7.4). A confirmation needs no hold at all.
   */
  const decide = (forgeNow: ForgeMr | null, trigger: Record<string, unknown>) => {
    const repo = repoOrHold();
    if (!repo) return;
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
    if (quiet()) return;
    const owner = ownerNeeded(s.sha);
    if (owner) return hold('OWNER_DECISION', owner);
    if (!forgeRead(forgeNow)) return;
    const shape = shapeProblem(forgeNow, repo);
    if (shape) return hold('OFF_PATH', shape);
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

  const active = () => s.stage !== null && !TERMINAL.includes(s.stage);

  switch (event.kind) {
    case 'command': {
      const { payload: cmd, from, msgId } = event;
      const trigger = { kind: 'message', id: msgId };
      if (from !== ctx.godId) { refuse(from, msgId, ['mr.command is accepted only from god']); break; }
      if (cmd.command === 'enrol') {
        const args = cmd.args as EnrolArgs;
        if (s.stage !== null) { refuse(from, msgId, [`card ${s.card} is already enrolled (${s.stage})`]); break; }
        if (args.repo !== ctx.repoId || !ctx.repo) { refuse(from, msgId, [`args.repo: ${args.repo} is not in the pipeline's configuration`]); break; }
        if (typeof event.openMrsForBranch !== 'number') { refuse(from, msgId, ['the branch\'s open MRs could not be counted']); break; }
        if (event.openMrsForBranch > 1) { refuse(from, msgId, [`args.branch: ${args.branch} has ${event.openMrsForBranch} open MRs`]); break; }
        s.repo = args.repo; s.branch = args.branch; s.implementer = args.implementer;
        move('implementing', 'god', trigger, { repo: args.repo, implementer: args.implementer, branch: args.branch });
        break;
      }
      if (!active()) { refuse(from, msgId, [`card ${s.card} is not active in the pipeline`]); break; }
      if (cmd.command === 'abandon') { s.holds = {}; s.paused = false; move('abandoned', 'god', trigger); break; }
      if (cmd.command === 'pause') { s.paused = true; fact('paused', { msg: msgId }); break; }
      // resume: clears the pause and every hold but OWNER_DECISION, which only the owner's
      // approval clears. A cleared cause that comes back tells god again.
      const was = holdCodes();
      const kept = was.filter((c) => c === 'OWNER_DECISION');
      const cleared = was.filter((c) => c !== 'OWNER_DECISION');
      s.paused = false;
      for (const c of cleared) delete s.holds[c];
      s.raised = s.raised.filter((k) => !cleared.some((c) => k.startsWith(`${c}|`)));
      s.stageSince = ctx.now;
      fact('resumed', { msg: msgId, cleared, kept });
      if (kept.length > 0) refuse(from, msgId, ['OWNER_DECISION is cleared only by the owner\'s approval of this sha, not by resume']);
      if (cleared.includes('OUT_OF_BAND') && s.outOfBandMerge && s.stage === 'mergeable') {
        s.mergeCommit = s.outOfBandMerge;
        move('merged', 'god', trigger, { merge_commit: s.outOfBandMerge, out_of_band: true });
        break;
      }
      if (s.submit && s.submit.payload.head_sha !== s.sha && (s.stage === 'review' || s.stage === 'mergeable')) {
        if (cleared.includes('REVIEW_BLOCK_MANUAL')) s.round += 1;
        move('implementing', 'god', trigger, { submit: s.submit.msg });
        s.requests = []; s.terminal = {}; s.verdicts = {};
      } else if (s.stage === 'review' && cleared.includes('REVIEW_DEGRADED') && ctx.repo && ctx.repoId === s.repo) {
        // Ask again where there is no counted answer; the panel rule still needs two vendors.
        const keep = s.requests.filter((r) => s.terminal[r.reviewer] === 'CONFIRMED' || s.terminal[r.reviewer] === 'BLOCK');
        const { reviewers } = choosePanel(ctx.repo.panel, ctx.roster);
        for (const r of reviewers.filter((x) => !keep.some((k) => k.vendor === x.vendor))) {
          const req = { ...r, requestId: `${s.card}:r${s.round}:${r.reviewer}:again` };
          s.requests = [...s.requests.filter((q) => q.vendor !== r.vendor), req];
          s.terminal[r.reviewer] = null;
          effects.push({ kind: 'review-request', reviewer: r.reviewer, vendor: r.vendor, requestId: req.requestId, sha: s.sha as Sha, round: s.round });
        }
      }
      break;
    }

    case 'owner-approval': {
      if (!active() || !SHA_RE.test(event.sha)) { fact('owner-approval-ignored', { sha: event.sha, ref: event.ref }); break; }
      if (!s.ownerApprovals.includes(event.sha)) s.ownerApprovals.push(event.sha);
      log.push({ type: 'fact', fact: 'owner-approval', sha: event.sha, ref: event.ref, by: 'owner' });
      const current = s.sha ?? s.submit?.payload.head_sha ?? null;
      if (s.holds.OWNER_DECISION && event.sha === current) {
        delete s.holds.OWNER_DECISION;
        s.raised = s.raised.filter((k) => !k.startsWith('OWNER_DECISION|'));
      }
      break;
    }

    case 'submit': {
      const { payload, from, msgId } = event;
      if (!active()) { refuse(from, msgId, [`card ${s.card} is not active in the pipeline`]); break; }
      if (from !== s.implementer) { refuse(from, msgId, [`only ${s.implementer} submits for ${s.card}`]); break; }
      if (payload.card !== s.card || payload.repo !== s.repo) { refuse(from, msgId, [`card and repo must be ${s.card} and ${s.repo}`]); break; }
      if (s.mr !== null && payload.mr !== s.mr) { refuse(from, msgId, [`mr: the card's MR is !${s.mr}`]); break; }
      if (s.stage === 'merged') { fact('submit-after-merge', { msg: msgId, head: payload.head_sha }); break; }
      s.submit = { msg: msgId, payload };
      s.mr = payload.mr;
      fact('submit', { msg: msgId, head: payload.head_sha, kind: payload.kind });
      if (!repoOrHold() || quiet()) break;
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
      if (v.answers !== req.requestId) { refuse(from, msgId, [`answers: the request waiting on ${from} is ${req.requestId}`]); break; }
      const before = s.verdicts[from];
      if (before && JSON.stringify(before.payload) === JSON.stringify(v)) { fact('verdict-duplicate', { msg: msgId, from }); break; }
      // DRIFTED: positive evidence of a model the vendor does not allow (7.2). No model sample counts.
      const allowed = ctx.allowedModels?.[req.vendor];
      const drifted = event.model !== null && allowed !== undefined && !allowed.includes(event.model);
      fact('verdict', { msg: msgId, from, vendor: req.vendor, model: event.model, verdict: v.verdict, drifted, replaces: before?.msg ?? null });
      if (drifted) {
        delete s.verdicts[from];
        s.terminal[from] = 'DRIFTED';
      } else {
        s.verdicts[from] = { reviewer: from, vendor: req.vendor, model: event.model, msg: msgId, payload: v };
        s.terminal[from] = v.verdict;
      }
      if (!repoOrHold() || s.paused) break;
      // Only a degraded hold lets the panel decide (and only a block can come of it).
      if (holdCodes().some((c) => c !== 'REVIEW_DEGRADED')) break;
      decide(event.forge, { kind: 'message', id: msgId });
      break;
    }

    case 'tick': {
      if (!active()) break;
      const repo = repoOrHold();
      if (!repo || quiet()) break;
      const trigger = { kind: 'tick' };
      if (event.forge?.state === 'closed') { move('abandoned', 'harness', trigger, { forge: event.forge }); break; }
      if (stalled()) { hold('STALLED', `${s.stage} for longer than ${ctx.deadlineMin} min`); break; }

      if (s.stage === 'implementing') { tryT2(event, trigger); break; }

      if (s.stage === 'review') {
        const f = event.forge;
        if (!forgeRead(f)) break;
        if (f.state === 'merged') { hold('OUT_OF_BAND', `merged on the forge at ${f.head} while in review`); break; }
        if (f.head !== s.sha) { hold('HEAD_MOVED', `the forge head moved from ${s.sha} to ${f.head}`); break; }
        markGone();
        decide(f, trigger);
        break;
      }

      if (s.stage === 'mergeable') {
        const f = event.forge;
        if (!forgeRead(f)) break;
        if (f.state === 'merged') {
          if (f.mergeCommit && event.secondParent === s.sha) {
            s.mergeCommit = f.mergeCommit;
            s.mergeAttempt = null;
            move('merged', 'out-of-band', trigger, { forge: f, second_parent: event.secondParent });
          } else {
            s.outOfBandMerge = f.mergeCommit;
            hold('OUT_OF_BAND', `merged on the forge, but not at the confirmed ${s.sha}`);
          }
          break;
        }
        if (s.mergeAttempt) break;
        const shape = shapeProblem(f, repo);
        if (shape) { hold('OFF_PATH', shape); break; }
        if (f.head !== s.sha) { hold('HEAD_MOVED', `the forge head moved from ${s.sha} to ${f.head}`); break; }
        const p = f.pipeline;
        if (!p || p.sha !== s.sha || WAITING_PIPELINE.includes(p.status)) break;
        if (p.status !== 'success') { hold('PIPELINE_RED', `pipeline ${p.id} on ${p.sha} is ${p.status}`); break; }
        if (event.mergeTree === 'conflict') { hold('CONFLICT', 'merge-tree of the target and S is not clean'); break; }
        if (event.mergeTree !== 'clean') break;
        // The changed-file probe must be present: unknown paths are never read as "none human-only".
        if (!Array.isArray(event.changedFiles)) { fact('awaiting-changed-files'); break; }
        const owner = ownerNeeded(s.sha, event.changedFiles);
        if (owner) { hold('OWNER_DECISION', owner); break; }
        if (!ctx.autoMerge) { notify('MERGE_READY', `ready to merge !${s.mr} at ${s.sha}`); break; }
        s.mergeAttempts += 1;
        s.mergeAttempt = { id: `${s.card}:merge:${s.mergeAttempts}`, sha: s.sha as Sha };
        fact('merge-guards', { forge: f, pipeline: p, mergeTree: 'clean', changedFiles: event.changedFiles, attempt: s.mergeAttempt.id });
        effects.push({ kind: 'merge', mr: s.mr as number, sha: s.sha as Sha, attempt: s.mergeAttempt.id });
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
      const inFlight = s.mergeAttempt;
      if (s.stage !== 'mergeable' || !inFlight || inFlight.id !== event.attempt) {
        fact('merge-result-unsolicited', { attempt: event.attempt, ok: event.ok, merge_commit: event.mergeCommit });
        break;
      }
      // Kept for reconciliation while held or paused; the forge, probed later, shows what happened.
      if (quiet()) { fact('merge-result-while-held', { attempt: event.attempt, ok: event.ok, merge_commit: event.mergeCommit }); break; }
      s.mergeAttempt = null;
      if (!event.ok) { hold('MERGE_REFUSED', event.error ?? 'the forge refused the merge'); break; }
      if (!event.mergeCommit || !SHA_RE.test(event.mergeCommit)) { hold('MERGE_REFUSED', 'the forge reported a merge with no merge commit'); break; }
      if (event.secondParent !== inFlight.sha) {
        hold('MERGE_REFUSED', `merge commit ${event.mergeCommit} has second parent ${event.secondParent}, not ${inFlight.sha}`);
        break;
      }
      s.mergeCommit = event.mergeCommit;
      move('merged', 'harness', { kind: 'effect', id: inFlight.id }, { merge_commit: event.mergeCommit, second_parent: event.secondParent });
      break;
    }

    case 'tamper': {
      hold('TAMPER', event.detail);
      break;
    }
  }

  // Whatever the event, an active card whose repo left the operator config stays held.
  if (active() && !(ctx.repo && ctx.repoId === s.repo)) repoOrHold();

  return { state: s, log, effects };
}
