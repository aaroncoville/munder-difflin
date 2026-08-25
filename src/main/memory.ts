/** Backend-neutral semantic-memory scheduler. */
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemPalaceAdapter } from './memPalaceAdapter';
import type { MemoryBackend } from './memoryBackend';
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

export interface MemorySettings { enabled: boolean; model: EmbeddingModel; }
export interface MemoryStatus { available: boolean; enabled: boolean; active: boolean; initialized: boolean; palacePath: string | null; model: EmbeddingModel; bin: string | null; }
const MINE_INTERVAL_MS = 600_000;

export class MemoryManager {
  private mineTimer: NodeJS.Timeout | null = null;
  private mineStopped = false;
  private mineDelayMs = MINE_INTERVAL_MS;
  private initStarted = false;
  private mining = false;
  private lastMined = new Map<string, number>();
  private readonly backend: MemoryBackend;
  constructor(private getHome: () => string | null, private getSettings: () => MemorySettings) {
    this.backend = new MemPalaceAdapter(() => this.palacePath(), () => this.model());
  }
  palacePath(): string | null { const home = this.getHome(); return home ? join(home, 'palace') : null; }
  bin(): string | null { return (this.backend as MemPalaceAdapter).bin(); }
  available(): boolean { return this.bin() !== null; }
  enabled(): boolean { return this.getSettings().enabled; }
  active(): boolean { return this.available() && this.enabled() && this.getHome() !== null; }
  model(): EmbeddingModel { return this.getSettings().model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm'; }
  status(): MemoryStatus {
    const status = this.backend.status(this.enabled(), this.getHome());
    return { available: this.available(), enabled: status.enabled, active: this.active(), initialized: status.initialized, palacePath: status.location, model: status.model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm', bin: this.bin() };
  }
  env(): Record<string, string> { return this.active() ? this.backend.agentEnv() : {}; }
  resetBinCache(): void { this.backend.resetCaches(); }
  start(): void {
    if (!this.active() || this.initStarted || !this.getHome() || !this.palacePath()) return;
    this.initStarted = true; this.backend.init(); this.startMineLoop();
  }
  stop(): void { this.mineStopped = true; if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; } }
  refresh(): MemoryStatus { this.resetBinCache(); this.start(); return this.status(); }
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
