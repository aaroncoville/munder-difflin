/**
 * Feature canaries: periodic self-checks that the floor's promises still hold.
 *
 * The prompts tell every agent it can recall semantic memory, query the
 * knowledge graph, and that its hooks reach the harness. When one of those
 * quietly breaks, nothing in the app says so: semantic search returned nothing
 * for eleven weeks because the installed shim sent a malformed request. Each
 * canary writes one `canary` line to the hive log.
 *
 * SECURITY: the main process never executes, requires or evals anything under
 * the hive root, and a canary pass starts no child process and contacts nothing
 * but loopback (memory is probed only on a loopback Hindsight server). Every agent can write there, so running a file from it would
 * turn an agent's file write into code running as the app user. Backends are
 * probed in-process; the helpers agents run are READ and compared with what the
 * app would install, never run.
 *
 * Measure only: a failing canary changes no behaviour. A line holds a feature
 * name, ok, a duration, counts and short enums. Never recalled text or file bytes.
 */
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, openSync, readFileSync, readSync, fstatSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CanaryFeature =
  | 'memory-search' | 'memory-wakeup' | 'kg-search' | 'hook-socket'
  | 'helpers-intact' | 'node-on-path' | 'model-matches-launch';

export type HelperProblem = 'missing' | 'not-regular' | 'not-executable' | 'stale' | 'modified';

export interface CanaryResult {
  feature: CanaryFeature;
  /** null = the feature is off on this install, so there was nothing to check. */
  ok: boolean | null;
  ms: number;
  /** An enum or code only, e.g. 'off', 'refused-422', 'timeout', 'no-hits'. */
  detail?: string;
  hits?: number;
  problems?: Record<string, HelperProblem>;
  checked?: number;
  mismatched?: string[];
}

interface TextResult { ok: boolean; output: string; error?: string }
export interface Seen { model: string; ts: number }

/** A helper agents run, and the bytes the app would install for it. */
export interface Helper {
  name: string;
  path: string;
  expected: string;
  /** For a helper copied from a bundled source: that source's mtime. Absent for generated helpers. */
  sourceMtimeMs?: number;
}

export interface CanaryDeps {
  /** Memory probes and whether they may run (see memoryCanary); `wing` is the owner tag agents send. */
  memory: MemoryCanary | null;
  /** In-process knowledge-graph search; null when the graph is off. */
  kg: { search: (q: string, limit: number) => unknown[] } | null;
  /** The hook socket and this app's instance id; null without a hive root. */
  hook: { sock: string; instance: string } | null;
  helpers: Helper[];
  /** The PATH directories agents are launched with. */
  pathDirs: string[];
  /** Launch model per agent, kept in memory at spawn. */
  launches: Map<string, Seen>;
  ledgerPath: string;
  timeoutMs?: number;
  now?: () => number;
}

const PROBE = 'canary probe';

/** Whether the memory canary may probe: only a backend that is provably local and passive. */
export type MemoryPlan = 'probe' | 'off' | 'not-probed-spawn' | 'not-probed-remote' | 'not-probed-switching';

export interface MemoryCanary {
  plan: MemoryPlan;
  search: (q: string, o: { wing: string }) => Promise<TextResult>;
  wakeUp: (wing: string) => Promise<TextResult>;
  wing: string;
}

/** A URL whose host is this machine: localhost, 127.0.0.0/8 or ::1, over http(s). */
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname;
  return h === 'localhost' || h === '[::1]' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// The recall request the hive-memory shim sends, mirrored here (constants as in hindsightAdapter.ts).
const TOKENS_PER_RESULT = 512;
const WAKE_UP_QUERY = 'recent important context';
const WAKE_UP_RESULTS = 8;
const RECALL_TIMEOUT_MS = 10_000;

/**
 * One recall request of the canary's own, to a loopback server only. It is not
 * the shared adapter: it never follows a redirect (any 3xx is a failure), so a
 * loopback endpoint cannot send the probe anywhere else.
 */
export function localRecall(base: string, bank: string, query: string, results: number, wing: string): Promise<TextResult> {
  return new Promise((resolve) => {
    if (!isLoopbackUrl(base)) { resolve({ ok: false, output: '', error: 'not-loopback' }); return; }
    const url = new URL(`${base.replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`);
    const body = JSON.stringify({ query, max_tokens: Math.max(1, results) * TOKENS_PER_RESULT, tags: [`owner:${wing}`] });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: RECALL_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); resolve({ ok: false, output: '', error: 'redirect' }); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (data.length < 1 << 20) data += d; });
      // A dropped connection may never emit 'end'; resolve is a no-op after it has.
      res.on('error', () => resolve({ ok: false, output: '', error: 'error' }));
      res.on('close', () => resolve({ ok: false, output: '', error: 'closed' }));
      res.on('end', () => {
        if (status < 200 || status >= 300) { resolve({ ok: false, output: '', error: `HTTP ${status}` }); return; }
        try {
          const n = ((JSON.parse(data) as { results?: unknown[] }).results ?? []).length;
          resolve({ ok: true, output: Array.from({ length: n }, () => '— hit').join('\n') });
        } catch { resolve({ ok: false, output: '', error: 'bad-reply' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, output: '', error: 'error' }));
    req.end(body);
  });
}

/**
 * The memory canary's plan. Only a Hindsight server on loopback is probed, and
 * only when the saved settings AND the backend the manager currently holds both
 * say so (a settings change takes effect in the manager only on its next
 * refresh, and the old backend may be MemPalace, which spawns its CLI). The
 * probe is the canary's own loopback request, never the shared adapter.
 */
export function memoryCanary(
  live: { backendId: () => string },
  settings: { enabled: boolean; backend: string; hindsight?: { url?: string; bank?: string } },
  wing: string
): MemoryCanary {
  const url = settings.hindsight?.url ?? '';
  const bank = settings.hindsight?.bank ?? '';
  const holds = live.backendId();
  const plan: MemoryPlan = !settings.enabled ? 'off'
    : settings.backend !== holds ? 'not-probed-switching'
      : settings.backend !== 'hindsight' ? 'not-probed-spawn'
        : isLoopbackUrl(url) ? 'probe' : 'not-probed-remote';
  return {
    plan, wing,
    search: (q, o) => localRecall(url, bank, q, 5, o.wing),
    wakeUp: (w) => localRecall(url, bank, WAKE_UP_QUERY, WAKE_UP_RESULTS, w)
  };
}

/** Hits in a rendered recall: one per non-empty line that starts a result. */
function countHits(output: string): number {
  return output.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith(' ')).length;
}

function judgeRecall(r: TextResult): Omit<CanaryResult, 'feature' | 'ms'> {
  if (!r.ok) {
    if (r.error === 'redirect') return { ok: false, detail: 'redirect' };
    const code = /HTTP (\d{3})/.exec(r.error ?? '');
    return { ok: false, detail: code ? `refused-${code[1]}` : 'error' };
  }
  const hits = countHits(r.output);
  return hits === 0 ? { ok: true, hits, detail: 'no-hits' } : { ok: true, hits };
}

/** What is wrong with an installed helper, judged by reading it (never running it); null when intact. */
export function checkHelper(h: Helper): HelperProblem | null {
  let st;
  try { st = lstatSync(h.path); } catch { return 'missing'; }
  if (!st.isFile()) return 'not-regular';
  if (process.platform !== 'win32' && (st.mode & 0o111) === 0) return 'not-executable';
  let bytes: string;
  try { bytes = readFileSync(h.path, 'utf8'); } catch { return 'missing'; }
  if (bytes === h.expected) return null;
  // Older than the bundled source it is copied from: the app has not re-installed it since an update.
  return h.sourceMtimeMs !== undefined && st.mtimeMs < h.sourceMtimeMs ? 'stale' : 'modified';
}

/** Whether `node` resolves on the given PATH directories (lookup only). */
export function nodeOnPath(dirs: string[]): boolean {
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node'];
  for (const d of dirs) {
    for (const n of names) {
      try {
        const st = statSync(join(d, n));
        if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)) return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

/** Rows per agent kept for the model check. */
const MODEL_WINDOW = 50;
/** Other-model rows must run this long at the end to count as a move (a subagent burst is shorter). */
export const MODEL_MOVE_MS = 10 * 60_000;

/**
 * Agents whose newest ledger rows, written after their launch, have been on
 * another model for at least MODEL_MOVE_MS. A refusal fallback moves the
 * session for good; a subagent on another model is a short burst between rows
 * of the launch model, so it is not flagged.
 */
export function checkModels(launches: Map<string, Seen>, ledgerLines: string[]): { checked: number; mismatched: string[] } {
  const recent = new Map<string, Seen[]>();
  for (const line of ledgerLines) {
    try {
      const r = JSON.parse(line) as { agent_id?: string; model?: string; ts?: number };
      if (!r.agent_id || !r.model || typeof r.ts !== 'number') continue;
      const list = recent.get(r.agent_id) ?? [];
      list.push({ model: r.model, ts: r.ts });
      if (list.length > MODEL_WINDOW) list.shift();
      recent.set(r.agent_id, list);
    } catch { /* a torn line */ }
  }
  let checked = 0;
  const mismatched: string[] = [];
  for (const [agent, launch] of launches) {
    if (!launch.model.startsWith('claude-')) continue;
    const after = (recent.get(agent) ?? []).filter((s) => s.ts >= launch.ts);
    if (after.length === 0) continue;
    checked++;
    // The trailing run of rows on another model, oldest to newest.
    let i = after.length;
    while (i > 0 && after[i - 1].model !== launch.model) i--;
    const run = after.slice(i);
    if (run.length > 0 && run[run.length - 1].ts - run[0].ts >= MODEL_MOVE_MS) mismatched.push(agent);
  }
  return { checked, mismatched: mismatched.sort() };
}

/** The last `bytes` of a file, split into whole lines (the first, partial line is dropped). */
export function tailLines(path: string, bytes = 512 * 1024): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.length > 0);
  } finally { closeSync(fd); }
}

/** Ask the hook socket for a pong carrying this app's instance id. */
export function pingHookSocket(sock: string, instance: string, timeoutMs = 1500): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let data = '';
    const nonce = randomUUID();
    const done = (v: { ok: boolean; detail?: string }): void => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* noop */ }
      resolve(v);
    };
    const c = createConnection(sock, () => { c.write(JSON.stringify({ ping: nonce }) + '\n'); });
    c.setEncoding('utf8');
    c.on('data', (d) => { data += d; });
    c.on('end', () => {
      try {
        const r = JSON.parse(data) as { pong?: string; instance?: string };
        if (r.pong !== nonce) done({ ok: false, detail: 'wrong-pong' });
        else done(r.instance === instance ? { ok: true } : { ok: false, detail: 'other-instance' });
      } catch { done({ ok: false, detail: 'bad-reply' }); }
    });
    c.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, detail: e.code ?? 'error' }));
    setTimeout(() => done({ ok: false, detail: 'timeout' }), timeoutMs).unref();
  });
}

/** Run every canary once and return the results (in a fixed order). */
export async function runCanaries(d: CanaryDeps): Promise<CanaryResult[]> {
  const now = d.now ?? Date.now;
  const limit = d.timeoutMs ?? 20_000;
  const timed = async (feature: CanaryFeature, f: () => Promise<Omit<CanaryResult, 'feature' | 'ms'>>): Promise<CanaryResult> => {
    const t0 = now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Omit<CanaryResult, 'feature' | 'ms'>>((res) => {
      // Not unref'd: a hung probe must still end at the limit. It is always cleared below.
      timer = setTimeout(() => res({ ok: false, detail: 'timeout' }), limit);
    });
    try {
      const r = await Promise.race([f(), timeout]);
      return { feature, ms: now() - t0, ...r };
    } catch {
      return { feature, ok: false, ms: now() - t0, detail: 'threw' };
    } finally { if (timer) clearTimeout(timer); }
  };
  const m = d.memory;
  return [
    await timed('memory-search', async () => (m?.plan === 'probe' ? judgeRecall(await m.search(PROBE, { wing: m.wing })) : { ok: null, detail: m?.plan ?? 'off' })),
    await timed('memory-wakeup', async () => (m?.plan === 'probe' ? judgeRecall(await m.wakeUp(m.wing)) : { ok: null, detail: m?.plan ?? 'off' })),
    await timed('kg-search', async () => {
      if (!d.kg) return { ok: null, detail: 'off' };
      const hits = d.kg.search(PROBE, 1).length;
      return hits === 0 ? { ok: true, hits, detail: 'no-hits' } : { ok: true, hits };
    }),
    await timed('hook-socket', async () => (d.hook ? pingHookSocket(d.hook.sock, d.hook.instance) : { ok: false, detail: 'no-root' })),
    await timed('helpers-intact', async () => {
      const problems: Record<string, HelperProblem> = {};
      for (const h of d.helpers) { const p = checkHelper(h); if (p) problems[h.name] = p; }
      return Object.keys(problems).length ? { ok: false, problems } : { ok: true };
    }),
    await timed('node-on-path', async () => (nodeOnPath(d.pathDirs) ? { ok: true } : { ok: false, detail: 'not-found' })),
    await timed('model-matches-launch', async () => {
      const { checked, mismatched } = checkModels(d.launches, tailLines(d.ledgerPath));
      return { ok: mismatched.length === 0, checked, mismatched };
    })
  ];
}
