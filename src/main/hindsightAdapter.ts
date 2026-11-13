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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendStatus, MemoryBackend, MineResult, TextResult } from './memoryBackend';

/** How long a /health answer is trusted before the next call re-probes. */
const HEALTH_TTL_MS = 30_000;
/** Matches the mempalace adapter's mine timeout, so a wedged server cannot
 *  stall the mine loop for longer than a local miner would. */
const MINE_TIMEOUT_MS = 10 * 60_000;
/** Retain is the expensive call: the server runs an LLM fact extraction over
 *  every new chunk it is handed. The miner keeps one retain in flight at a time
 *  and then leaves the server idle at least as long as that retain kept it busy. */
const RETAIN_MIN_GAP_MS = 30_000;
/** A retain that outlives MINE_TIMEOUT_MS is still extracting on the server
 *  after we hang up, so the miner sends nothing else for this long. */
const RETAIN_BUSY_BACKOFF_MS = 30 * 60_000;
/** The most sections one retain may carry, so a backlog drains over several passes. */
const RETAIN_MAX_ITEMS = 8;
/** A memory.md written this recently is probably still being appended to. */
const QUIET_MS = 2 * 60_000;
/** Which section text the bank already holds, kept beside the agents so an app
 *  restart does not resend every memory.md from scratch. */
const RETAIN_STATE_FILE = '.hindsight-retained.json';
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

interface RetainState {
  /** No retain may start before this time, even from a freshly restarted app. */
  busyUntil: number;
  /** `agent\nheading\noccurrence` → the document id it is retained under and a hash of the body last sent. */
  sections: Record<string, { id: string; hash: string }>;
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
  private retainState: RetainState | null = null;

  constructor(
    private cfg: () => { url: string; bank: string },
    private getHome: () => string | null,
    private now: () => number = Date.now,
    private mineTimeoutMs: number = MINE_TIMEOUT_MS
  ) {}

  /** The state file lives in the hive folder, and only when there is one. */
  private retainStatePath(): string | null {
    const home = this.getHome();
    if (!home || !existsSync(join(home, 'hive', 'agents'))) return null;
    return join(home, 'hive', RETAIN_STATE_FILE);
  }

  private loadRetainState(): RetainState {
    if (this.retainState) return this.retainState;
    let state: RetainState = { busyUntil: 0, sections: {} };
    const path = this.retainStatePath();
    if (path && existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RetainState>;
        state = { busyUntil: Number(parsed.busyUntil) || 0, sections: parsed.sections ?? {} };
      } catch {
        // A torn or hand-edited file costs one resend, which the server answers as a no-op delta.
      }
    }
    return (this.retainState = state);
  }

  private saveRetainState(): void {
    const path = this.retainStatePath();
    if (!path || !this.retainState) return;
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(this.retainState), 'utf8');
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      console.error(`[memory] hindsight retain state not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
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
   * Retain the sections of an agent's memory.md that changed since the bank last
   * saw them. One call sends at most RETAIN_MAX_ITEMS sections; `ok: false` asks
   * the manager to come back next pass, either for the rest or because the server
   * is still cooling down from the previous retain.
   */
  async mineAgent(agentDir: string, agentId: string): Promise<MineResult> {
    const path = join(agentDir, 'memory.md');
    if (!existsSync(path)) return { ok: false };
    const state = this.loadRetainState();
    if (this.now() < state.busyUntil) return { ok: false };
    let markdown: string;
    try {
      if (this.now() - statSync(path).mtimeMs < QUIET_MS) return { ok: false };
      markdown = readFileSync(path, 'utf8');
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
    for (const key of Object.keys(state.sections)) {
      if (key.startsWith(`${agentId}\n`) && !present.has(key)) delete state.sections[key];
    }
    if (!pending.length) {
      this.saveRetainState();
      return { ok: true };
    }
    const batch = pending.slice(0, RETAIN_MAX_ITEMS);
    const items = batch.map(({ id, heading, body }) => ({
      document_id: id,
      content: body,
      // Metadata values must be strings — the API rejects anything else.
      metadata: { agent: agentId, source: 'memory.md', heading },
      tags: [`owner:${agentId}`]
    }));
    const record = (): void => {
      for (const { key, id, hash } of batch) state.sections[key] = { id, hash };
    };
    // Claim the server before sending, so an app restarted mid-retain waits it out.
    state.busyUntil = this.now() + this.mineTimeoutMs + RETAIN_MIN_GAP_MS;
    this.saveRetainState();
    const started = this.now();
    try {
      const res = await this.request(`${this.base()}/memories`, {
        method: 'POST',
        body: { items, async: false },
        timeoutMs: this.mineTimeoutMs
      });
      if (!res.ok) {
        console.error(`[memory] hindsight mine ${agentId} failed: HTTP ${res.status}`);
        state.busyUntil = this.now() + RETAIN_MIN_GAP_MS;
        return { ok: false };
      }
      record();
      state.busyUntil = this.now() + Math.max(RETAIN_MIN_GAP_MS, this.now() - started);
      return { ok: batch.length === pending.length };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // The server keeps extracting after we hang up. Sending this batch again
        // would stack a second extraction on top of it, so count it as retained.
        console.error(`[memory] hindsight mine ${agentId} timed out; leaving the server alone for ${RETAIN_BUSY_BACKOFF_MS / 60_000} min`);
        record();
        state.busyUntil = this.now() + RETAIN_BUSY_BACKOFF_MS;
      } else {
        console.error(`[memory] hindsight mine ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        state.busyUntil = this.now() + RETAIN_MIN_GAP_MS;
      }
      return { ok: false };
    } finally {
      this.saveRetainState();
    }
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
