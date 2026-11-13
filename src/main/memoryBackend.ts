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
  /** Why the backend is on but cannot save memories, or null. */
  problem?: string | null;
}

/** `ok: false` asks for the agent again next pass. `sent` says this call started
 *  a retain, so the manager can serve agents in turn; `backlog` is how many of the
 *  agent's sections are still waiting. */
/** How often the manager runs a mining pass. */
export const MINE_INTERVAL_MS = 600_000;

export interface MineResult { ok: boolean; backoffAdviceMs?: number; sent?: boolean; backlog?: number }
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
  /** True when availability can only be learned from an async probe, so the
   *  manager must arm the backend before `available()` can ever say yes. A
   *  local CLI backend leaves this unset: it knows synchronously. */
  readonly probesAsync?: boolean;
  /** Backends that probesAsync must implement this: await the pending health
   *  check so the caller can block until availability is known. Safe to call
   *  concurrently — in-flight probes are de-duped by the implementation. */
  probeHealth?(): Promise<boolean>;
}

/** The persisted, backend-aware shape of the memory settings. */
export interface MemorySettings {
  enabled: boolean;
  backend: BackendId;
  mempalace: { model: 'minilm' | 'embeddinggemma' };
  hindsight: { url: string; bank: string };
}
