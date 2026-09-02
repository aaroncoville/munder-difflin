/**
 * Bringing up one managed Codex app-server daemon for an isolated CODEX_HOME,
 * as a decision separated from the IO it needs.
 *
 * This lived inline on the spawn path, where each of its five ways of failing
 * ended in a `console.warn` — visible only in the terminal the app was launched
 * from, and to nobody else. Naming each outcome as a value lets the caller both
 * warn AND record it, and lets every branch be exercised without a Codex install.
 */
import { join } from 'node:path';
import {
  CODEX_REMOTE_SOCKET_RELATIVE,
  codexRemoteEndpoint,
  codexRemoteSocketFits
} from '../shared/codexRemote';

/** Where the setup got to. Exactly one is reported per attempt. */
export type CodexRemoteStage =
  | 'socket-fit'     // the home cannot host a bindable control socket
  | 'daemon-start'   // `daemon start` failed or timed out
  | 'enable-remote'  // `daemon enable-remote-control` failed or timed out
  | 'socket-check'   // both commands reported success, but no socket appeared
  | 'setup-error'    // an IO edge threw
  | 'enabled';       // connected

export interface CodexRemoteSetupContext {
  /** $CODEX_HOME the agent will launch with — already shortened, if it could be. */
  home: string;
  /** The executable the daemon commands are run with. */
  executable: string;
  agentId: string;
}

/** `kind` of the line this module appends to the hive log. One per Codex spawn
 *  attempt, success or failure — the whole point is that a spawn that fell back
 *  to a local TUI is as visible as one that did not. */
export const CODEX_SPAWN_LOG_KIND = 'codex-spawn';

/** The durable record of one attempt. Flat and JSON-only: it is appended as a
 *  single line to the hive log, which other processes read. */
export type CodexSpawnEvent = {
  kind: typeof CODEX_SPAWN_LOG_KIND;
  agentId: string;
  stage: CodexRemoteStage | 'short-home';
  ok: boolean;
  home: string;
  /** The executable the daemon commands were run with. Present for every stage
   *  that ran one. Without it the log cannot tell "Codex could not start its
   *  daemon" apart from "the daemon commands were handed to a different CLI",
   *  and those want opposite fixes. */
  executable?: string;
  detail?: string;
  /** Wall time the attempt took. A stall shows up here and nowhere else. */
  ms?: number;
};

export interface CodexRemoteSetupIo {
  /** Run one `codex app-server daemon …` invocation to completion. */
  run(args: string[]): Promise<{ ok: boolean; error?: string }>;
  /** Whether the control socket is present on disk. */
  socketExists(path: string): boolean;
  /** Append one line to a durable, floor-readable log. Best-effort by contract:
   *  see the call site — a sink that throws must not fail the spawn. */
  trace?(event: CodexSpawnEvent): void;
}

export interface CodexRemoteSetupResult {
  enabled: boolean;
  stage: CodexRemoteStage;
  /** Human-readable reason, for a warning line. Absent when enabled. */
  detail?: string;
  /** The `unix://…` endpoint to point the TUI at. Only when enabled. */
  endpoint?: string;
}

export async function setUpCodexRemote(
  ctx: CodexRemoteSetupContext,
  io: CodexRemoteSetupIo
): Promise<CodexRemoteSetupResult> {
  const startedAt = Date.now();
  // One exit point, so no branch can be added later that forgets to record
  // itself — the failure this module exists to stop being invisible.
  const report = (result: CodexRemoteSetupResult): CodexRemoteSetupResult => {
    try {
      io.trace?.({
        kind: CODEX_SPAWN_LOG_KIND,
        agentId: ctx.agentId,
        stage: result.stage,
        ok: result.enabled,
        home: ctx.home,
        executable: ctx.executable,
        ...(result.detail ? { detail: result.detail } : {}),
        ms: Date.now() - startedAt
      });
    } catch { /* a log that cannot be written must not fail a spawn */ }
    return result;
  };
  try {
    // Checked even though the short home was already established upstream: if it
    // could not be, the daemon would start and die on bind, and this names the
    // real reason instead of a readiness timeout.
    if (!codexRemoteSocketFits(ctx.home)) {
      return report({ enabled: false, stage: 'socket-fit', detail: `socket path exceeds sun_path: ${ctx.home}` });
    }
    const started = await io.run(['app-server', 'daemon', 'start']);
    if (!started.ok) {
      return report({ enabled: false, stage: 'daemon-start', detail: started.error ?? 'daemon start failed' });
    }
    const enabled = await io.run(['app-server', 'daemon', 'enable-remote-control']);
    if (!enabled.ok) {
      return report({ enabled: false, stage: 'enable-remote', detail: enabled.error ?? 'enable-remote-control failed' });
    }
    const socket = join(ctx.home, CODEX_REMOTE_SOCKET_RELATIVE);
    if (!io.socketExists(socket)) {
      return report({ enabled: false, stage: 'socket-check', detail: `daemon returned without a control socket at ${socket}` });
    }
    return report({ enabled: true, stage: 'enabled', endpoint: codexRemoteEndpoint(ctx.home) });
  } catch (e) {
    return report({ enabled: false, stage: 'setup-error', detail: e instanceof Error ? e.message : String(e) });
  }
}
