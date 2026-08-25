import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ensureKilled } from './procKill';
import { quarantineDirsToReap, quarantineStampMs, nextMineDelayMs } from './palaceReap';
import type { BackendStatus, MemoryBackend, MineResult, TextResult } from './memoryBackend';

export type EmbeddingModel = 'minilm' | 'embeddinggemma';
const MINE_INTERVAL_MS = 600_000;
const MINE_BACKOFF_MAX_MS = 1_800_000;
const MINE_TIMEOUT_MS = 10 * 60_000;

export function mempalaceDevice(platform: NodeJS.Platform, envOverride: string | undefined): string | undefined {
  if (envOverride) return undefined;
  return platform === 'darwin' ? 'cpu' : undefined;
}

const MEMPALACE_DEVICE = mempalaceDevice(process.platform, process.env.MEMPALACE_EMBEDDING_DEVICE);

export class MemPalaceAdapter implements MemoryBackend {
  readonly id = 'mempalace' as const;
  private binCache: string | null | undefined;
  private lastQuarantineTs = 0;
  private mineDelayMs = MINE_INTERVAL_MS;

  constructor(
    private getPalacePath: () => string | null,
    private getModel: () => EmbeddingModel
  ) {}

  bin(): string | null {
    if (this.binCache !== undefined) return this.binCache;
    let found: string | null = null;
    const isWin = process.platform === 'win32';
    try {
      if (isWin) {
        const res = spawnSync('where', ['mempalace'], { encoding: 'utf8', timeout: 3000 });
        const p = res.stdout.trim().split(/\r?\n/)[0]?.trim();
        if (p && existsSync(p)) found = p;
      } else {
        const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'which mempalace'], { encoding: 'utf8', timeout: 3000 });
        const p = res.stdout.trim().split('\n').pop();
        if (p && existsSync(p)) found = p;
      }
    } catch { /* fall through */ }
    if (!found) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const candidates = isWin
        ? [join(home, '.local', 'bin', 'mempalace.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mempalace.exe')]
        : [`${home}/.local/bin/mempalace`, '/opt/homebrew/bin/mempalace', '/usr/local/bin/mempalace'];
      for (const candidate of candidates) if (candidate && existsSync(candidate)) { found = candidate; break; }
    }
    this.binCache = found;
    return found;
  }

  available(): boolean { return this.bin() !== null; }
  resetCaches(): void { this.binCache = undefined; }
  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MEMPALACE_PALACE_PATH: this.getPalacePath() ?? '',
      MEMPALACE_EMBEDDING_MODEL: this.getModel(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {})
    };
  }

  agentEnv(): Record<string, string> {
    const palace = this.getPalacePath();
    if (!palace || !this.available()) return {};
    return {
      MEMPALACE_PALACE_PATH: palace,
      MEMPALACE_EMBEDDING_MODEL: this.getModel(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {})
    };
  }

  status(enabled: boolean, home: string | null): BackendStatus {
    const palace = this.getPalacePath();
    const available = this.available();
    return { backend: this.id, available, enabled, active: available && enabled && home !== null,
      initialized: !!palace && existsSync(palace), location: palace, model: this.getModel(), bin: this.bin() };
  }

  init(): void { this.reapPalace(); }

  async mineAgent(agentDir: string, id: string): Promise<MineResult> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve({ ok: false }); return; }
      const proc = spawn(bin, ['mine', agentDir, '--wing', id, '--agent', id], { env: this.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr?.on('data', (data) => { err += data.toString(); });
      const timer = setTimeout(() => {
        console.error(`[memory] mine ${id} timed out after ${MINE_TIMEOUT_MS / 60000}min — killing`);
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        ensureKilled(proc.pid);
      }, MINE_TIMEOUT_MS);
      timer.unref?.();
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) console.error(`[memory] mine ${id} exited ${code}: ${err.slice(-300)}`);
        resolve({ ok: code === 0 });
      });
      proc.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    });
  }

  postMinePass(): { backoffAdviceMs: number } {
    const quarantined = this.reapPalace();
    this.mineDelayMs = nextMineDelayMs(this.mineDelayMs, MINE_INTERVAL_MS, MINE_BACKOFF_MAX_MS, quarantined);
    return { backoffAdviceMs: this.mineDelayMs };
  }

  private reapPalace(): boolean {
    const palace = this.getPalacePath();
    if (!palace || !existsSync(palace)) return false;
    let names: string[];
    try { names = readdirSync(palace); } catch { return false; }
    let newest = 0;
    for (const name of names) { const stamp = quarantineStampMs(name); if (stamp !== null && stamp > newest) newest = stamp; }
    const fresh = this.lastQuarantineTs > 0 && newest > this.lastQuarantineTs;
    if (newest > this.lastQuarantineTs) this.lastQuarantineTs = newest;
    const doomed = quarantineDirsToReap(names.map((name) => ({ name })), Date.now());
    let removed = 0;
    for (const name of doomed) {
      try { rmSync(join(palace, name), { recursive: true, force: true }); removed += 1; }
      catch { /* locked, gone, or not ours — leave it and try again next pass */ }
    }
    if (removed) console.log(`[memory] reaped ${removed} quarantined palace segment(s)`);
    return fresh;
  }

  private runCli(args: string[], label: string): Promise<TextResult> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve({ ok: false, output: '', error: 'semantic memory not active' }); return; }
      let proc: ReturnType<typeof spawn>;
      try { proc = spawn(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { resolve({ ok: false, output: '', error: error instanceof Error ? error.message : String(error) }); return; }
      let out = '', err = '', settled = false;
      const settle = (result: TextResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      proc.stdout?.setEncoding('utf8'); proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (data: string) => { out += data; });
      proc.stderr?.on('data', (data: string) => { err += data; });
      const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } ensureKilled(proc.pid); settle({ ok: false, output: out, error: `${label} timed out` }); }, 120_000);
      timer.unref?.();
      proc.on('close', (code) => code !== 0 ? settle({ ok: false, output: out, error: (err || `${label} failed`).trim() }) : settle({ ok: true, output: out }));
      proc.on('error', (error) => settle({ ok: false, output: '', error: error.message }));
    });
  }

  search(query: string, opts: { agentId?: string; results?: number } = {}): Promise<TextResult> {
    const args = ['search', query, '--results', String(opts.results ?? 5)];
    if (opts.agentId) args.push('--wing', opts.agentId);
    return this.runCli(args, 'search');
  }

  wakeUp(agentId?: string): Promise<TextResult> {
    const args = ['wake-up'];
    if (agentId) args.push('--wing', agentId);
    return this.runCli(args, 'wake-up');
  }
}
