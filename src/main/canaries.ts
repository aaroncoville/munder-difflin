/**
 * Feature canaries: periodic self-checks that the floor's promises still hold.
 *
 * The prompts tell every agent it can recall semantic memory, query the
 * knowledge graph, and that its hooks reach the harness. When one of those
 * quietly breaks, nothing in the app says so: semantic search returned nothing
 * for eleven weeks because the shim sent a malformed request and reported the
 * refusal as "unavailable". Each canary runs the same path an agent uses and
 * writes one `canary` line to the hive log.
 *
 * Measure only: a failing canary changes no behaviour. A `canary` line holds
 * a feature name, ok, a duration and a short enum or code. It never holds
 * query results, command output or file contents.
 */
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';

export type CanaryFeature =
  | 'memory-search' | 'memory-wakeup' | 'kg-search' | 'hook-socket' | 'model-matches-launch';

export interface CanaryResult {
  feature: CanaryFeature;
  /** null = the feature is off on this install, so there was nothing to check. */
  ok: boolean | null;
  ms: number;
  /** An enum or code only, e.g. 'unavailable', 'refused-422', 'exit-1', 'off'. */
  detail?: string;
  /** model-matches-launch only: how many agents were compared, and which differed. */
  checked?: number;
  mismatched?: string[];
}

export interface RunOutcome { code: number | null; stdout: string; stderr: string }

/** What a run of the hive-memory shim came to, judged from its exit and output shape only. */
export function classifyMemoryRun(run: RunOutcome): { ok: boolean; detail?: string } {
  const refused = /HTTP (\d{3})/.exec(run.stderr);
  if (refused) return { ok: false, detail: `refused-${refused[1]}` };
  if (/memory recall unavailable/.test(run.stdout)) return { ok: false, detail: 'unavailable' };
  if (run.code !== 0) return { ok: false, detail: `exit-${run.code ?? 'signal'}` };
  return { ok: true };
}

export interface Seen { model: string; ts: number }

/** Agents whose newest ledger model, written after their launch, differs from the model they were launched with. */
export function modelMismatches(
  launched: Map<string, Seen>, ledger: Map<string, Seen>
): { checked: number; mismatched: string[] } {
  let checked = 0;
  const mismatched: string[] = [];
  for (const [agent, launch] of launched) {
    const seen = ledger.get(agent);
    // Aliases ('opus') cannot be compared to a full model id, and a row from
    // before the launch belongs to the previous session.
    if (!seen || !launch.model.startsWith('claude-') || seen.ts < launch.ts) continue;
    checked++;
    if (seen.model !== launch.model) mismatched.push(agent);
  }
  return { checked, mismatched: mismatched.sort() };
}

/** Newest launch model per agent from hive log lines (`agent-model` events). */
export function launchModelsFromLog(lines: string[]): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const line of lines) {
    if (!line.includes('"agent-model"')) continue;
    try {
      const e = JSON.parse(line) as { kind?: string; agentId?: string; model?: string; ts?: number };
      if (e.kind === 'agent-model' && e.agentId && e.model) out.set(e.agentId, { model: e.model, ts: e.ts ?? 0 });
    } catch { /* a torn line */ }
  }
  return out;
}

/** Newest non-empty ledger model per agent from cost-ledger lines. */
export function ledgerModelsFromLines(lines: string[]): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as { agent_id?: string; model?: string; ts?: number };
      if (r.agent_id && r.model) out.set(r.agent_id, { model: r.model, ts: r.ts ?? 0 });
    } catch { /* a torn line */ }
  }
  return out;
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

export function runFile(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Ask the hook socket for a pong, as a hook shim's connection would. */
export function pingHookSocket(sock: string, timeoutMs = 1500): Promise<{ ok: boolean; detail?: string }> {
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
      try { done((JSON.parse(data) as { pong?: string }).pong === nonce ? { ok: true } : { ok: false, detail: 'wrong-pong' }); }
      catch { done({ ok: false, detail: 'bad-reply' }); }
    });
    c.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, detail: e.code ?? 'error' }));
    setTimeout(() => done({ ok: false, detail: 'timeout' }), timeoutMs).unref();
  });
}

export interface CanaryDeps {
  /** Absolute path to the installed hive-memory shim agents run, or null. */
  memoryShim: string | null;
  /** The env an agent gets for memory; empty when semantic memory is off. */
  memoryEnv: Record<string, string>;
  /** The kg CLI path and its env; null when the knowledge graph is off. */
  kg: { cli: string; env: Record<string, string> } | null;
  /** The node used to run .cjs helpers (the hive's bundled launcher). */
  node: string;
  hookSocket: string | null;
  hiveLogPath: string;
  ledgerPath: string;
  run?: typeof runFile;
  ping?: typeof pingHookSocket;
  now?: () => number;
}

/** Run every canary once and return the results (in a fixed order). */
export async function runCanaries(d: CanaryDeps): Promise<CanaryResult[]> {
  const run = d.run ?? runFile;
  const ping = d.ping ?? pingHookSocket;
  const now = d.now ?? Date.now;
  const timed = async (feature: CanaryFeature, f: () => Promise<Omit<CanaryResult, 'feature' | 'ms'>>): Promise<CanaryResult> => {
    const t0 = now();
    try {
      const r = await f();
      return { feature, ms: now() - t0, ...r };
    } catch {
      return { feature, ok: false, ms: now() - t0, detail: 'threw' };
    }
  };
  const memoryOn = !!d.memoryShim && Object.keys(d.memoryEnv).length > 0;
  return [
    await timed('memory-search', async () => memoryOn
      ? classifyMemoryRun(await run(d.node, [d.memoryShim!, 'search', 'canary probe'], d.memoryEnv))
      : { ok: null, detail: 'off' }),
    await timed('memory-wakeup', async () => memoryOn
      ? classifyMemoryRun(await run(d.node, [d.memoryShim!, 'wake-up'], d.memoryEnv))
      : { ok: null, detail: 'off' }),
    await timed('kg-search', async () => {
      if (!d.kg) return { ok: null, detail: 'off' };
      const r = await run(d.node, [d.kg.cli, 'search', 'canary probe'], d.kg.env);
      return r.code === 0 ? { ok: true } : { ok: false, detail: `exit-${r.code ?? 'signal'}` };
    }),
    await timed('hook-socket', async () => d.hookSocket ? ping(d.hookSocket) : { ok: false, detail: 'no-root' }),
    await timed('model-matches-launch', async () => {
      const { checked, mismatched } = modelMismatches(
        launchModelsFromLog(tailLines(d.hiveLogPath, 16 * 1024 * 1024)),
        ledgerModelsFromLines(tailLines(d.ledgerPath))
      );
      return { ok: mismatched.length === 0, checked, mismatched };
    })
  ];
}
