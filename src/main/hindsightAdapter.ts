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
import { CLAIM_MAX_ITEMS, RetainLedger, type LedgerState, type RetainClaim } from './hindsightLedger';
import type { BackendStatus, MemoryBackend, MineResult, TextResult } from './memoryBackend';

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
/** A memory.md written this recently is probably still being appended to. */
const QUIET_MS = 2 * 60_000;
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

  /** The ledger for the current server and bank, loaded once and reloaded when either changes. */
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
      this.ledgerState = await this.ledger.load(server);
      this.lastClaimPoll = -Infinity;
      // A rest longer than any this miner sets is not honoured.
      this.ledgerState.busyUntil = Math.min(this.ledgerState.busyUntil, this.now() + RETAIN_MIN_GAP_MS);
    }
    return { ledger: this.ledger, state: this.ledgerState };
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
    const batch = pending.slice(0, CLAIM_MAX_ITEMS);
    const claim: RetainClaim = { op: randomUUID(), since: this.now(), items: batch.map(({ key, id, hash }) => ({ key, id, hash })) };
    // Fail closed: a retain whose claim is not on disk could be sent twice after a restart.
    state.claim = claim;
    if (!(await ledger.save(state))) {
      state.claim = null;
      return { ok: false };
    }
    console.info(`[memory] hindsight retain ${claim.op}: ${batch.length} of ${pending.length} pending sections for ${agentId}`);
    const outcome = await this.postClaim(claim, batch.map(({ id, heading, body }) => ({
      document_id: id,
      content: body,
      // Metadata values must be strings — the API rejects anything else.
      metadata: { agent: agentId, source: 'memory.md', heading },
      tags: [`owner:${agentId}`]
    })), agentId);
    if (outcome === 'accepted') {
      const settled = await this.settleClaim(ledger, state, true);
      const left = settled === 'completed' ? pending.length - batch.length : pending.length;
      return { ok: left === 0, sent: true, ...(left ? { backlog: left } : {}) };
    }
    if (outcome === 'refused') {
      state.claim = null;
      state.busyUntil = this.now() + RETAIN_MIN_GAP_MS;
      await ledger.save(state);
    } else {
      // Unknown: the server may have it. Nothing is resent until it is asked.
      this.lastClaimPoll = this.now();
    }
    return { ok: false, sent: true, backlog: pending.length };
  }

  /** Send a claimed batch. `refused` means the server did not take it and nothing is running. */
  private async postClaim(claim: RetainClaim, items: unknown[], agentId: string): Promise<'accepted' | 'refused' | 'unknown'> {
    try {
      const res = await this.request(`${this.base()}/memories`, {
        method: 'POST',
        body: { items, async: true, operation_id: claim.op },
        timeoutMs: RETAIN_REQUEST_TIMEOUT_MS
      });
      if (res.ok) return 'accepted';
      console.error(`[memory] hindsight mine ${agentId} failed: HTTP ${res.status}`);
      return res.status >= 500 || res.status === 408 ? 'unknown' : 'refused';
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      console.error(`[memory] hindsight mine ${agentId} failed: ${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ''}`);
      return code && NEVER_SENT.has(code) ? 'refused' : 'unknown';
    }
  }

  /**
   * Ask the server what became of the open retain, at most every CLAIM_POLL_MS
   * unless forced. Its sections count as retained only once the server says the
   * operation completed. Failed, cancelled or unknown to the server frees the slot
   * with nothing recorded, so those sections are sent again later. No answer keeps
   * the slot held, however long that takes.
   */
  private async settleClaim(ledger: RetainLedger, state: LedgerState, force = false): Promise<'completed' | 'released' | 'open'> {
    const claim = state.claim;
    if (!claim) return 'released';
    if (!force && this.now() - this.lastClaimPoll < CLAIM_POLL_MS) return 'open';
    this.lastClaimPoll = this.now();
    let status: string;
    try {
      const res = await this.request(`${this.base()}/operations/${encodeURIComponent(claim.op)}`, { method: 'GET', timeoutMs: OPERATION_TIMEOUT_MS });
      if (res.status === 404) status = 'not_found';
      else if (!res.ok) return 'open';
      else {
        const body = (await res.json()) as { status?: unknown; error_message?: unknown };
        status = typeof body.status === 'string' ? body.status : '';
        if (status === 'failed') console.error(`[memory] hindsight retain ${claim.op} failed on the server: ${String(body.error_message ?? 'no reason given')}`);
      }
    } catch {
      return 'open';
    }
    if (status === 'completed') {
      for (const { key, id, hash } of claim.items) state.sections[key] = { id, hash };
    } else if (status !== 'failed' && status !== 'cancelled' && status !== 'not_found') {
      return 'open';
    }
    state.claim = null;
    state.busyUntil = this.now() + RETAIN_MIN_GAP_MS;
    await ledger.save(state);
    return status === 'completed' ? 'completed' : 'released';
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
