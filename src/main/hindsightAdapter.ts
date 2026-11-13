/** Hindsight HTTP memory backend; see docs/superpowers/specs/2026-08-25-pluggable-memory-design.md.
 *
 * Every request shape below was taken from the server's own OpenAPI document
 * (verified 2026-08-25) rather than guessed:
 *   - retain is POST .../memories with `{ items: [{ content, metadata, tags,
 *     document_id }], async }` — the item field is `content`, not `text`;
 *   - recall is POST .../memories/recall with `{ query, max_tokens, tags }` —
 *     there is no `top_k`; the result budget is expressed in tokens;
 *   - a recalled hit carries `scores.final`, not a flat `score`;
 *   - there is no POST for creating a bank — PUT .../banks/<id> upserts one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAIM_ITEM_MAX_CHARS, CLAIM_MAX_ITEMS, MAX_KEY_LENGTH, RetainLedger, type LedgerState, type RetainClaim } from './hindsightLedger';
import { MINE_INTERVAL_MS, type BackendStatus, type MemoryBackend, type MineResult, type TextResult } from './memoryBackend';

/** How long a /health answer is trusted before the next call re-probes. */
const HEALTH_TTL_MS = 30_000;
/** Retain is the expensive call: the server runs an LLM fact extraction over every
 *  new chunk it is handed, for as long as 40 minutes on a small local model. So the
 *  miner sends it async under an operation id it chose and recorded first, keeps one
 *  such retain open at a time, and frees that slot only when the server reports the
 *  operation finished. Asking again under the same id creates no new work. */
const RETAIN_REQUEST_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 15_000;
/** Rest the server gets after a retain finishes or is refused, before the next one. */
const RETAIN_MIN_GAP_MS = 30_000;
/** How often an open retain's status is asked for. */
const CLAIM_POLL_MS = 30_000;
/** An open retain older than this is logged with its id and age on every poll. */
const CLAIM_OLD_MS = 60 * 60_000;
/** An operation whose status and updated_at have not moved for this long is taken
 *  to be stranded (a crashed worker, a recreated container) and is cancelled on the
 *  server. Retains on the floor took 12–42 min end to end; two hours with no change
 *  at all is about three times the longest. */
const CLAIM_STRANDED_MS = 2 * 60 * 60_000;
/** A refusal the server repeats is retried after this, doubling up to the cap. */
const REFUSAL_BACKOFF_MS = 10 * 60_000;
/** The longest gap between two answered polls that counts toward CLAIM_STRANDED_MS: half
 *  again a mining pass, so a longer pass interval cannot switch the cancel off. A longer
 *  gap (an outage, a sleeping app) is not counted. */
const COUNTED_POLL_GAP_MS = 1.5 * MINE_INTERVAL_MS;
/** With the settings moved to another server, an open retain whose own server has not
 *  answered for this long is set aside, so the new server is not starved by a dead one. */
const ABANDON_AFTER_MS = 30 * 60_000;
/** An old open retain is logged at CLAIM_OLD_MS and then at most this often. */
const AGE_LOG_EVERY_MS = 24 * 60 * 60_000;
const REFUSAL_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** A memory.md written this recently is probably still being appended to. */
const QUIET_MS = 2 * 60_000;
const OPERATION_STATUSES = new Set(['pending', 'processing', 'completed', 'failed', 'cancelled', 'not_found']);
/** Failures that prove the request never reached the server. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
const RECALL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
/** Recall budgets in tokens, so a caller's "N results" becomes a token
 *  allowance. 512 is a generous ceiling for one mined memory.md section. */
const TOKENS_PER_RESULT = 512;
const WAKE_UP_QUERY = 'recent important context';
const WAKE_UP_RESULTS = 8;

interface RecallHit {
  text?: string;
  score?: number;
  scores?: { final?: number };
}

/**
 * Render recall hits as the plain text an agent sees.
 *
 * DELIBERATELY DUPLICATED in `resources/hive-memory.cjs`. That shim is copied
 * onto disk and run by agent processes standing alone outside the app bundle,
 * so it cannot import this module. Change one, change the other — the shim's
 * test pins the exact output format.
 */
export function renderRecall(results: RecallHit[]): string {
  return results
    .map((hit) => {
      const score = hit.scores?.final ?? hit.score;
      return `— ${hit.text ?? ''}${score == null ? '' : `  (score ${score})`}`;
    })
    .join('\n');
}

/** Split a memory.md into one retainable item per `## ` section. */
export function memorySections(markdown: string): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    const heading = /^## +(.*)$/.exec(line);
    if (heading) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
      current = { heading: heading[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() });
  return sections.filter((s) => s.body.length > 0);
}

const sha = (text: string, length = 64): string => createHash('sha256').update(text).digest('hex').slice(0, length);

export class HindsightAdapter implements MemoryBackend {
  readonly id = 'hindsight' as const;
  /** `available()` can only answer after /health has been asked, and asking is
   *  part of being armed — so the manager must not wait for availability. */
  readonly probesAsync = true;
  private healthy = false;
  private healthCheckedAt = -Infinity;
  private inFlightProbe: Promise<boolean> | null = null;
  private bankReady = false;
  private ledger: RetainLedger | null = null;
  private ledgerDirUsed: string | null = null;
  private ledgerState: LedgerState | null = null;
  private lastClaimPoll = -Infinity;
  /** The HTTP status the server last refused a retain with, and how many times in a row. */
  private refusal: { status: number; count: number } | null = null;
  /** Since when the open retain's server has failed to answer at all, in this run. */
  private unanswered: { op: string; since: number } | null = null;
  /** When the open retain's age was last logged. */
  private ageLogged: { op: string; at: number } | null = null;
  /** A change of server or bank waiting for an open retain to end, so it is logged once. */
  private waitingFor: string | null = null;
  /** The last answer about the open retain, so each change is logged once. */
  private lastPollOutcome: { op: string; outcome: string } | null = null;
  /** Oversized sections already reported, so each is logged once. */
  private reportedOversize = new Set<string>();

  constructor(
    private cfg: () => { url: string; bank: string },
    private getHome: () => string | null,
    private now: () => number = Date.now,
    /** The app's own folder for the retain ledger; with none, the miner sends nothing. */
    private ledgerDir: () => string | null = () => null
  ) {}

  /** `url\nbank`: a retain ledger belongs to exactly one server and bank. */
  private serverKey(): string {
    const { url, bank } = this.cfg();
    return `${url.trim().replace(/\/+$/, '')}\n${bank}`;
  }

  /**
   * The ledger to work from: the current server and bank's, loaded once and reloaded
   * when either changes, except that while any ledger has a retain open (this one, or
   * one a previous run left on disk) that ledger is kept until the retain ends. A
   * change of settings waits for it, and is logged once.
   */
  private async currentLedger(): Promise<{ ledger: RetainLedger; state: LedgerState } | null> {
    const dir = this.ledgerDir();
    if (!dir) return null;
    if (!this.ledger || this.ledgerDirUsed !== dir) {
      this.ledger = new RetainLedger(dir);
      this.ledgerDirUsed = dir;
      this.ledgerState = null;
    }
    const server = this.serverKey();
    if (this.ledgerState?.server !== server) {
      let next = this.ledgerState?.claim ? this.ledgerState : (await this.ledger.openClaims()).find((l) => l.server !== server) ?? null;
      if (next) {
        if (this.waitingFor !== server) {
          this.waitingFor = server;
          console.info(`[memory] hindsight: the new server or bank takes effect once retain ${next.claim?.op} on ${next.server.replace('\n', ' bank ')} ends`);
        }
      } else {
        this.waitingFor = null;
        next = await this.ledger.load(server);
        if (next.aside && !next.claim) {
          // This server is configured again: settle what was set aside before sending anything.
          console.info(`[memory] hindsight: retain ${next.aside.claim.op}, set aside earlier, is being checked with ${next.server.replace('\n', ' bank ')} before anything is resent`);
          next.claim = next.aside.claim;
          next.aside = null;
          await this.ledger.save(next);
        }
      }
      if (next !== this.ledgerState) {
        this.ledgerState = next;
        this.lastClaimPoll = -Infinity;
        // A rest longer than any this miner sets is not honoured.
        this.ledgerState.busyUntil = Math.min(this.ledgerState.busyUntil, this.now() + REFUSAL_BACKOFF_MAX_MS);
      }
    }
    return { ledger: this.ledger, state: this.ledgerState as LedgerState };
  }

  /** The bank URL a ledger's `url\nbank` names. Every request about a claim goes here, never to the live settings. */
  private baseOf(server: string): string {
    const cut = server.indexOf('\n');
    return `${server.slice(0, cut)}/v1/default/banks/${encodeURIComponent(server.slice(cut + 1))}`;
  }

  private base(): string {
    const { url, bank } = this.cfg();
    return `${url.replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(bank)}`;
  }

  private async request(
    path: string,
    init: { method: string; body?: unknown; timeoutMs: number }
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    timer.unref?.();
    try {
      return await fetch(path, {
        method: init.method,
        signal: controller.signal,
        ...(init.body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) })
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask /health now and refresh the cache. Safe to call concurrently. */
  probeHealth(): Promise<boolean> {
    if (this.inFlightProbe) return this.inFlightProbe;
    const { url } = this.cfg();
    this.inFlightProbe = (async () => {
      let ok = false;
      try {
        ok = (await this.request(`${url.replace(/\/+$/, '')}/health`, { method: 'GET', timeoutMs: PROBE_TIMEOUT_MS })).ok;
      } catch {
        ok = false;
      }
      this.healthy = ok;
      this.healthCheckedAt = this.now();
      if (!ok) this.bankReady = false;
      this.inFlightProbe = null;
      return ok;
    })();
    return this.inFlightProbe;
  }

  /** Sync, cached — the interface's contract. A stale cache is refreshed in the
   *  background so the next caller sees the newer answer. */
  available(): boolean {
    if (this.now() - this.healthCheckedAt >= HEALTH_TTL_MS) void this.probeHealth();
    return this.healthy;
  }

  resetCaches(): void {
    this.healthy = false;
    this.healthCheckedAt = -Infinity;
    this.bankReady = false;
  }

  init(): void {
    void this.ready();
  }

  /** The awaitable half of `init()`: confirm the server is up and the bank
   *  exists, creating it when the server has never heard of it. */
  async ready(): Promise<boolean> {
    if (!(await this.probeHealth())) return false;
    try {
      const stats = await this.request(`${this.base()}/stats`, { method: 'GET', timeoutMs: PROBE_TIMEOUT_MS });
      if (stats.ok) {
        this.bankReady = true;
        return true;
      }
      if (stats.status !== 404) return false;
      // No POST /banks exists — PUT on the bank id is the create/update verb.
      const created = await this.request(this.base(), {
        method: 'PUT',
        body: { name: this.cfg().bank },
        timeoutMs: PROBE_TIMEOUT_MS
      });
      this.bankReady = created.ok;
      return created.ok;
    } catch {
      this.bankReady = false;
      return false;
    }
  }

  /**
   * Retain the sections of an agent's memory.md that the server has not confirmed
   * holding. `ok: false` asks the manager to come back next pass: a retain is still
   * open, the server is resting, sections are left over, or nothing could be
   * recorded. `sent` says this call started a retain, which the manager uses to
   * serve agents in turn.
   */
  async mineAgent(agentDir: string, agentId: string): Promise<MineResult> {
    const current = await this.currentLedger();
    if (!current) return { ok: false };
    const { ledger, state } = current;
    const path = join(agentDir, 'memory.md');
    let markdown: string;
    try {
      if (this.now() - (await stat(path)).mtimeMs < QUIET_MS) return { ok: false };
      markdown = await readFile(path, 'utf8');
    } catch {
      return { ok: false };
    }
    const occurrences = new Map<string, number>();
    const present = new Set<string>();
    const pending: { key: string; id: string; hash: string; heading: string; body: string }[] = [];
    for (const { heading, body } of memorySections(markdown)) {
      const n = occurrences.get(heading) ?? 0;
      occurrences.set(heading, n + 1);
      const key = `${agentId}\n${heading}\n${n}`;
      present.add(key);
      const hash = sha(body);
      // Left out rather than claimed: the ledger refuses a claim it could not read back.
      if (body.length > CLAIM_ITEM_MAX_CHARS || key.length > MAX_KEY_LENGTH) {
        if (!this.reportedOversize.has(`${key}\n${hash}`)) {
          this.reportedOversize.add(`${key}\n${hash}`);
          console.warn(`[memory] hindsight: ${agentId} section "${heading.slice(0, 80)}" is ${body.length} chars (heading ${heading.length}), over what a retain may carry (${CLAIM_ITEM_MAX_CHARS} chars, key ${MAX_KEY_LENGTH}); it is left out`);
        }
        continue;
      }
      const known = state.sections[key];
      if (known?.hash === hash) continue;
      // A section seen for the first time keeps the id earlier builds gave it, so a
      // bank they filled is updated rather than duplicated. After that the id stays
      // fixed, and an edit is a delta re-retain of the changed chunks only.
      pending.push({ key, id: known?.id ?? sha(`${agentId}\n${heading}\n${body}`, 32), hash, heading, body });
    }
    let pruned = false;
    for (const key of Object.keys(state.sections)) {
      if (key.startsWith(`${agentId}\n`) && !present.has(key)) { delete state.sections[key]; pruned = true; }
    }
    if (pruned && !state.claim) await ledger.save(state);
    if (state.claim) {
      await this.settleClaim(ledger, state);
      return { ok: false, backlog: pending.length };
    }
    if (!pending.length) return { ok: true };
    if (this.now() < state.busyUntil) return { ok: false, backlog: pending.length };
    // A ledger kept for another server's open retain takes no new work once that retain ends.
    if (state.server !== this.serverKey()) return { ok: false, backlog: pending.length };
    const batch = pending.slice(0, CLAIM_MAX_ITEMS);
    const now = this.now();
    const claim: RetainClaim = {
      op: randomUUID(),
      since: now,
      items: batch.map(({ key, id, hash, heading, body }) => ({ key, id, hash, agent: agentId, heading, content: body })),
      acked: false,
      seen: '',
      idle: 0,
      answeredAt: now
    };
    // Fail closed: a retain whose claim is not on disk could be sent twice after a restart.
    state.claim = claim;
    if (!(await ledger.save(state))) {
      state.claim = null;
      return { ok: false };
    }
    console.info(`[memory] hindsight retain ${claim.op}: ${batch.length} of ${pending.length} pending sections for ${agentId}`);
    const outcome = await this.postClaim(ledger, state, claim);
    if (outcome === 'accepted') {
      const settled = await this.settleClaim(ledger, state, true);
      const left = settled === 'completed' ? pending.length - batch.length : pending.length;
      return { ok: left === 0, sent: true, ...(left ? { backlog: left } : {}) };
    }
    if (outcome === 'unknown') this.lastClaimPoll = this.now();
    return { ok: false, sent: true, backlog: pending.length };
  }

  /**
   * Send the claimed batch under its operation id. Accepted marks the claim
   * acknowledged. Refused (the server answered no, or was never reached) releases
   * it; a refusal the server repeats backs off and is logged only when it changes.
   * Anything else is unknown: the server may have it, and the claim stays.
   */
  private async postClaim(ledger: RetainLedger, state: LedgerState, claim: RetainClaim): Promise<'accepted' | 'refused' | 'unknown'> {
    const items = claim.items.map(({ id, agent, heading, content }) => ({
      document_id: id,
      content,
      // Metadata values must be strings — the API rejects anything else.
      metadata: { agent, source: 'memory.md', heading },
      tags: [`owner:${agent}`]
    }));
    let refusedWith: number | null = null;
    try {
      const res = await this.request(`${this.baseOf(state.server)}/memories`, {
        method: 'POST',
        body: { items, async: true, operation_id: claim.op },
        timeoutMs: RETAIN_REQUEST_TIMEOUT_MS
      });
      if (res.ok) {
        this.refusal = null;
        claim.acked = true;
        claim.idle = 0;
        claim.answeredAt = this.now();
        await ledger.save(state);
        return 'accepted';
      }
      if (res.status >= 500 || res.status === 408) {
        console.error(`[memory] hindsight retain ${claim.op}: HTTP ${res.status}; the outcome is unknown`);
        return 'unknown';
      }
      refusedWith = res.status;
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      console.error(`[memory] hindsight retain ${claim.op} failed: ${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ''}`);
      if (!code || !NEVER_SENT.has(code)) return 'unknown';
    }
    let rest = RETAIN_MIN_GAP_MS;
    if (refusedWith !== null) {
      const count = this.refusal?.status === refusedWith ? this.refusal.count + 1 : 1;
      if (count === 1) console.error(`[memory] hindsight refused a retain with HTTP ${refusedWith}; repeats back off and are not logged again`);
      this.refusal = { status: refusedWith, count };
      rest = Math.min(REFUSAL_BACKOFF_MAX_MS, REFUSAL_BACKOFF_MS * 2 ** (count - 1));
    }
    state.claim = null;
    state.busyUntil = this.now() + rest;
    await ledger.save(state);
    return 'refused';
  }

  /** The operation's status and updated_at, or why the answer could not be used and whether the server answered at all. */
  private async operationStatus(server: string, op: string): Promise<{ status: string; updatedAt: string; error?: string } | { problem: string; answered: boolean }> {
    let res: Response;
    try {
      res = await this.request(`${this.baseOf(server)}/operations/${encodeURIComponent(op)}`, { method: 'GET', timeoutMs: OPERATION_TIMEOUT_MS });
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error), answered: false };
    }
    if (res.status === 404) return { status: 'not_found', updatedAt: '' };
    if (!res.ok) return { problem: `HTTP ${res.status}`, answered: true };
    let body: { status?: unknown; updated_at?: unknown; error_message?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { problem: 'a body that is not JSON', answered: true };
    }
    if (typeof body?.status !== 'string') return { problem: 'no status in the answer', answered: true };
    if (!OPERATION_STATUSES.has(body.status)) return { problem: `unknown status "${body.status.slice(0, 40)}"`, answered: true };
    return {
      status: body.status,
      updatedAt: typeof body.updated_at === 'string' ? body.updated_at : '',
      ...(body.error_message ? { error: String(body.error_message) } : {})
    };
  }

  /**
   * Whether the server already holds every claimed section as claimed: each document
   * exists under its id with exactly the claimed text. False when any is missing,
   * differs, or cannot be read.
   */
  private async documentsHeld(server: string, claim: RetainClaim): Promise<boolean> {
    for (const { id, content } of claim.items) {
      try {
        const res = await this.request(`${this.baseOf(server)}/documents/${encodeURIComponent(id)}`, { method: 'GET', timeoutMs: OPERATION_TIMEOUT_MS });
        if (!res.ok) return false;
        const body = (await res.json()) as { original_text?: unknown };
        if (body.original_text !== content) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Ask the server what became of the open retain, at most every CLAIM_POLL_MS
   * unless forced. Its sections count as retained only once the server says the
   * operation completed, or, when it has no record of the operation, once its
   * documents are found holding exactly the claimed text. Otherwise not_found sends
   * the same request again under the same operation id. Failed or cancelled frees
   * the slot with nothing recorded. Any other answer, including one that cannot be
   * read, keeps the slot held. Each change of answer is logged once, an open claim
   * over an hour old is logged on every poll, and an operation with no readable
   * progress for CLAIM_STRANDED_MS is cancelled; the slot frees only when the
   * server confirms the cancel.
   */
  private async settleClaim(ledger: RetainLedger, state: LedgerState, force = false): Promise<'completed' | 'released' | 'open'> {
    const claim = state.claim;
    if (!claim) return 'released';
    if (!force && this.now() - this.lastClaimPoll < CLAIM_POLL_MS) return 'open';
    this.lastClaimPoll = this.now();
    const op = await this.operationStatus(state.server, claim.op);
    const outcome = 'problem' in op ? `unreadable (${op.problem})` : op.status;
    if (this.lastPollOutcome?.op !== claim.op || this.lastPollOutcome.outcome !== outcome) {
      this.lastPollOutcome = { op: claim.op, outcome };
      const log = 'problem' in op ? console.warn : console.info;
      log(`[memory] hindsight retain ${claim.op}: the server reports ${outcome}`);
    }
    if ('problem' in op && !op.answered) {
      if (this.unanswered?.op !== claim.op) this.unanswered = { op: claim.op, since: this.now() };
      const target = this.serverKey();
      if (state.server !== target && this.now() - this.unanswered.since >= ABANDON_AFTER_MS) return this.setAside(ledger, state, target);
    } else {
      this.unanswered = null;
    }
    if (!('problem' in op)) {
      if (op.status === 'completed') return this.releaseClaim(ledger, state, true);
      if (op.status === 'failed' || op.status === 'cancelled') {
        if (op.status === 'failed') console.error(`[memory] hindsight retain ${claim.op} failed on the server: ${op.error ?? 'no reason given'}`);
        return this.releaseClaim(ledger, state, false);
      }
      if (op.status === 'not_found') {
        // A finished operation may have been pruned while the app was away: ask about the documents first.
        if (await this.documentsHeld(state.server, claim)) {
          console.info(`[memory] hindsight retain ${claim.op}: no record of the operation, but its documents hold the claimed text; recorded`);
          return this.releaseClaim(ledger, state, true);
        }
        console.info(`[memory] hindsight retain ${claim.op}: no record of it and its documents do not hold the claimed text; sending it again under the same id`);
        const sent = await this.postClaim(ledger, state, claim);
        return sent === 'refused' ? 'released' : 'open';
      }
    }
    // The no-progress clock runs only between answered polls, so an outage or a
    // sleeping app is not counted against an operation the server is still running.
    if (!('problem' in op) || op.answered) {
      const seen = 'problem' in op ? claim.seen : `${op.status}|${op.updatedAt}`.slice(0, 256);
      const gap = this.now() - claim.answeredAt;
      if (seen !== claim.seen) claim.idle = 0;
      else if (gap <= COUNTED_POLL_GAP_MS) claim.idle += gap;
      claim.seen = seen;
      claim.answeredAt = this.now();
      await ledger.save(state);
    }
    const age = this.now() - claim.since;
    if (age >= CLAIM_OLD_MS && (this.ageLogged?.op !== claim.op || this.now() - this.ageLogged.at >= AGE_LOG_EVERY_MS)) {
      this.ageLogged = { op: claim.op, at: this.now() };
      console.warn(`[memory] hindsight retain ${claim.op} is still open (${outcome}) after ${Math.round(age / 60_000)} min; nothing else is sent until it ends`);
    }
    if (claim.idle < CLAIM_STRANDED_MS) return 'open';
    console.warn(`[memory] hindsight retain ${claim.op} has shown no progress for ${Math.round(claim.idle / 60_000)} min of answered polls; asking the server to cancel it`);
    try {
      await this.request(`${this.baseOf(state.server)}/operations/${encodeURIComponent(claim.op)}`, { method: 'DELETE', timeoutMs: OPERATION_TIMEOUT_MS });
    } catch {
      // The status read below decides.
    }
    const after = await this.operationStatus(state.server, claim.op);
    if ('problem' in after || (after.status !== 'cancelled' && after.status !== 'not_found')) {
      console.warn(`[memory] hindsight retain ${claim.op}: the server did not confirm the cancel; the slot stays held`);
      return 'open';
    }
    return this.releaseClaim(ledger, state, false);
  }

  /**
   * Set the open claim aside in its own ledger: its server stopped answering after the
   * settings moved elsewhere. Nothing from it is recorded. If that cannot be written,
   * the claim stays open.
   */
  private async setAside(ledger: RetainLedger, state: LedgerState, target: string): Promise<'released' | 'open'> {
    const claim = state.claim as RetainClaim;
    const from = state.server.replace('\n', ' bank ');
    const to = target.replace('\n', ' bank ');
    const reason = `${from} has not answered for ${Math.round((this.now() - (this.unanswered?.since ?? this.now())) / 60_000)} min since the settings moved to ${to}`;
    state.aside = { claim, reason, at: this.now() };
    state.claim = null;
    if (!(await ledger.save(state))) {
      state.claim = claim;
      state.aside = null;
      return 'open';
    }
    this.unanswered = null;
    console.warn(`[memory] hindsight retain ${claim.op} set aside: ${reason}. Nothing from it is recorded; it is checked again if ${from} is configured again`);
    return 'released';
  }

  /** Close the claim, recording its sections only when the server holds them, and rest. */
  private async releaseClaim(ledger: RetainLedger, state: LedgerState, retained: boolean): Promise<'completed' | 'released'> {
    const claim = state.claim;
    if (claim && retained) for (const { key, id, hash } of claim.items) state.sections[key] = { id, hash };
    state.claim = null;
    state.busyUntil = this.now() + RETAIN_MIN_GAP_MS;
    await ledger.save(state);
    return retained ? 'completed' : 'released';
  }

  private async recall(query: string, resultCount: number, agentId?: string): Promise<TextResult> {
    try {
      const res = await this.request(`${this.base()}/memories/recall`, {
        method: 'POST',
        body: {
          query,
          max_tokens: Math.max(1, resultCount) * TOKENS_PER_RESULT,
          ...(agentId ? { tags: [`owner:${agentId}`] } : {})
        },
        timeoutMs: RECALL_TIMEOUT_MS
      });
      if (!res.ok) return { ok: false, output: '', error: `HTTP ${res.status}` };
      const body = (await res.json()) as { results?: RecallHit[] };
      return { ok: true, output: renderRecall(body.results ?? []) };
    } catch (error) {
      return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) };
    }
  }

  search(query: string, opts: { agentId?: string; results?: number } = {}): Promise<TextResult> {
    return this.recall(query, opts.results ?? 5, opts.agentId);
  }

  wakeUp(agentId?: string): Promise<TextResult> {
    return this.recall(WAKE_UP_QUERY, WAKE_UP_RESULTS, agentId);
  }

  status(enabled: boolean, home: string | null): BackendStatus {
    const { url, bank } = this.cfg();
    const available = this.available();
    return {
      backend: this.id,
      available,
      enabled,
      active: available && enabled && home !== null,
      initialized: this.bankReady,
      location: `${url} · ${bank}`,
      // A remote server owns its own embedding model; there is nothing local to name.
      model: null,
      bin: null
    };
  }

  agentEnv(): Record<string, string> {
    const { url, bank } = this.cfg();
    return { HIVE_MEMORY_BACKEND: 'hindsight', HINDSIGHT_URL: url, HINDSIGHT_BANK: bank };
  }
}

/**
 * Probe a Hindsight endpoint the user has typed but not committed to, and
 * describe what was found there.
 *
 * Returns the url and bank it actually reached alongside the verdict: the
 * settings panel renders this object rather than its own inputs, so a stale
 * "connected" can never be shown next to an address that has since been edited.
 * Never throws — an unreachable server is an answer, not a failure.
 */
export async function testHindsightConnection(
  url: string,
  bank: string
): Promise<{ ok: boolean; detail: string; url: string; bank: string }> {
  const base = url.trim().replace(/\/+$/, '');
  const bankId = bank.trim();
  if (!base) return { ok: false, detail: 'Enter the server address first.', url: base, bank: bankId };
  if (!bankId) return { ok: false, detail: 'Enter a bank name first.', url: base, bank: bankId };

  const get = async (path: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await fetch(path, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const health = await get(`${base}/health`);
    if (!health.ok) return { ok: false, detail: `Server answered HTTP ${health.status}.`, url: base, bank: bankId };
    const stats = await get(`${base}/v1/default/banks/${encodeURIComponent(bankId)}/stats`);
    if (stats.status === 404) {
      return { ok: false, detail: `Server is up, but there is no bank named "${bankId}" yet.`, url: base, bank: bankId };
    }
    if (!stats.ok) return { ok: false, detail: `Bank check returned HTTP ${stats.status}.`, url: base, bank: bankId };
    const body = (await stats.json()) as { total_nodes?: number };
    const count = typeof body.total_nodes === 'number' ? body.total_nodes : 0;
    return { ok: true, detail: `Connected — ${count} ${count === 1 ? 'memory' : 'memories'} in "${bankId}".`, url: base, bank: bankId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Couldn't reach ${base} — ${reason}`, url: base, bank: bankId };
  }
}
