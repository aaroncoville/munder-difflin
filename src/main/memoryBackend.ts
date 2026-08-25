/** Memory backend contract; see docs/superpowers/specs/2026-08-25-pluggable-memory-design.md. */

export type BackendId = 'mempalace' | 'hindsight';

export interface BackendStatus {
  backend: BackendId;
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  location: string | null;
  model: string | null;
  bin: string | null;
}

export interface MineResult { ok: boolean; backoffAdviceMs?: number }
export interface TextResult { ok: boolean; output: string; error?: string }

export interface MemoryBackend {
  readonly id: BackendId;
  available(): boolean;
  init(): void;
  mineAgent(agentDir: string, agentId: string): Promise<MineResult>;
  search(q: string, opts: { agentId?: string; results?: number }): Promise<TextResult>;
  wakeUp(agentId?: string): Promise<TextResult>;
  status(enabled: boolean, home: string | null): BackendStatus;
  agentEnv(): Record<string, string>;
  resetCaches(): void;
  postMinePass?(): { backoffAdviceMs: number };
}
