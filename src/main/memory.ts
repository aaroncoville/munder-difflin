/** Backend-neutral semantic-memory scheduler. */
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemPalaceAdapter } from './memPalaceAdapter';
import { HindsightAdapter } from './hindsightAdapter';
import type { BackendId, MemoryBackend, MemorySettings } from './memoryBackend';
export type { MemorySettings } from './memoryBackend';
export { mempalaceDevice, type EmbeddingModel } from './memPalaceAdapter';
import type { EmbeddingModel } from './memPalaceAdapter';

/** MUST STAY IN SYNC with MINE_IGNORE_LINES in hive.ts — that copy is written when
 * an agent spawns, this one on every mine cycle, and only this one reaches agents
 * that are not currently running. See hive.ts for why `.codex/` matters beyond
 * mempalace: it is also what stopped the hive's git repo from versioning every
 * Codex transcript and sqlite log into a 7.5GB history. */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore'); let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = MINE_IGNORE_LINES.filter((line) => !have.has(line));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

export interface MemoryStatus { available: boolean; enabled: boolean; active: boolean; initialized: boolean; palacePath: string | null; backend: BackendId; location: string | null; model: EmbeddingModel | null; bin: string | null; }
const MINE_INTERVAL_MS = 600_000;

export class MemoryManager {
  private mineTimer: NodeJS.Timeout | null = null;
  private mineStopped = false;
  private mineDelayMs = MINE_INTERVAL_MS;
  private initStarted = false;
  private mining = false;
  private lastMined = new Map<string, number>();
  private backend: MemoryBackend;
  constructor(
    private getHome: () => string | null,
    private getSettings: () => MemorySettings,
    private makeBackend: (id: BackendId) => MemoryBackend = (id) =>
      id === 'hindsight'
        ? new HindsightAdapter(() => this.getSettings().hindsight, () => this.getHome())
        : new MemPalaceAdapter(() => this.palacePath(), () => this.model())
  ) {
    this.backend = this.makeBackend(this.getSettings().backend);
  }
  palacePath(): string | null { const home = this.getHome(); return home ? join(home, 'palace') : null; }
  bin(): string | null { return this.backend.status(this.enabled(), this.getHome()).bin; }
  available(): boolean { return this.backend.available(); }
  enabled(): boolean { return this.getSettings().enabled; }
  active(): boolean { return this.available() && this.enabled() && this.getHome() !== null; }
  model(): EmbeddingModel { return this.getSettings().mempalace.model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm'; }
  status(): MemoryStatus {
    const status = this.backend.status(this.enabled(), this.getHome());
    return {
      available: status.available, enabled: status.enabled, active: status.active, initialized: status.initialized,
      // A remote backend has no palace directory; `location` is where its
      // memories actually live, and callers that want a path must not be handed
      // a server URL dressed up as one.
      palacePath: status.backend === 'mempalace' ? status.location : null,
      backend: status.backend, location: status.location,
      model: status.model === null ? null : status.model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm', bin: status.bin
    };
  }
  env(): Record<string, string> { return this.active() ? this.backend.agentEnv() : {}; }
  resetBinCache(): void {
    // Async-probing backends (e.g. Hindsight) latch their health result across
    // calls — wiping it via resetCaches() clears availability until the next
    // async probe completes.  MemPalace is sync and MUST be reset each poll to
    // detect a newly-installed CLI binary.  Callers (refresh, tools:status) must
    // not bypass this method to reach resetCaches() directly.
    if (!this.backend.probesAsync) this.backend.resetCaches();
  }
  start(): void {
    if (this.initStarted || !this.enabled() || !this.getHome()) return;
    // A backend that only learns its availability from an async probe cannot be
    // available yet — arming it IS what starts the probe. A local CLI backend
    // answers synchronously, so it stays dark until its CLI is really there.
    if (!this.backend.probesAsync && (!this.active() || !this.palacePath())) return;
    this.initStarted = true; this.backend.init(); this.startMineLoop();
  }
  stop(): void { this.mineStopped = true; if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; } }
  async refresh(): Promise<MemoryStatus> {
    this.swapBackendIfChanged();
    this.resetBinCache();
    this.start();
    // For async backends, await the probe so the very first poll after switching
    // reflects actual server state rather than the initial false healthy flag.
    if (this.backend.probesAsync && !this.backend.available()) {
      await this.backend.probeHealth?.();
    }
    return this.status();
  }
  /** Adopt the backend the settings now name. Switching means starting over:
   *  the new backend holds none of the old one's memories, so every agent's
   *  memory.md has to be mined into it from scratch. */
  private swapBackendIfChanged(): void {
    const wanted = this.getSettings().backend;
    if (wanted === this.backend.id) return;
    if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; }
    this.backend = this.makeBackend(wanted);
    this.lastMined.clear();
    this.initStarted = false;
    this.mineDelayMs = MINE_INTERVAL_MS;
  }
  private startMineLoop(): void {
    if (this.mineTimer) return;
    const tick = () => { void this.mineNow().finally(() => { if (this.mineStopped) return; this.mineTimer = setTimeout(tick, this.mineDelayMs); this.mineTimer.unref?.(); }); };
    this.mineTimer = setTimeout(tick, 0); this.mineTimer.unref?.();
  }
  async mineNow(): Promise<void> {
    const home = this.getHome(); if (!this.active() || !home || this.mining) return;
    const agentsDir = join(home, 'hive', 'agents'); if (!existsSync(agentsDir)) return;
    let ids: string[]; try { ids = readdirSync(agentsDir); } catch { return; }
    this.mining = true;
    try {
      for (const id of ids) {
        const agentDir = join(agentsDir, id), memory = join(agentDir, 'memory.md');
        if (!existsSync(memory)) continue;
        let mtime: number; try { mtime = statSync(memory).mtimeMs; } catch { continue; }
        if (this.lastMined.get(id) === mtime) continue;
        this.lastMined.set(id, mtime); ensureMineIgnore(agentDir);
        if (!(await this.backend.mineAgent(agentDir, id)).ok) this.lastMined.delete(id);
      }
    } finally { this.mining = false; }
    const postMine = this.backend.postMinePass?.(); if (postMine) this.mineDelayMs = postMine.backoffAdviceMs;
  }
  search(query: string, opts: { wing?: string; results?: number } = {}) {
    if (!this.active()) return Promise.resolve({ ok: false, output: '', error: 'semantic memory not active' });
    return this.backend.search(query, { agentId: opts.wing, results: opts.results });
  }
  wakeUp(wing?: string) {
    if (!this.active()) return Promise.resolve({ ok: false, output: '', error: 'semantic memory not active' });
    return this.backend.wakeUp(wing);
  }
}
