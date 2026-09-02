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

export interface CodexRemoteSetupIo {
  /** Run one `codex app-server daemon …` invocation to completion. */
  run(args: string[]): Promise<{ ok: boolean; error?: string }>;
  /** Whether the control socket is present on disk. */
  socketExists(path: string): boolean;
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
  try {
    // Checked even though the short home was already established upstream: if it
    // could not be, the daemon would start and die on bind, and this names the
    // real reason instead of a readiness timeout.
    if (!codexRemoteSocketFits(ctx.home)) {
      return { enabled: false, stage: 'socket-fit', detail: `socket path exceeds sun_path: ${ctx.home}` };
    }
    const started = await io.run(['app-server', 'daemon', 'start']);
    if (!started.ok) {
      return { enabled: false, stage: 'daemon-start', detail: started.error ?? 'daemon start failed' };
    }
    const enabled = await io.run(['app-server', 'daemon', 'enable-remote-control']);
    if (!enabled.ok) {
      return { enabled: false, stage: 'enable-remote', detail: enabled.error ?? 'enable-remote-control failed' };
    }
    const socket = join(ctx.home, CODEX_REMOTE_SOCKET_RELATIVE);
    if (!io.socketExists(socket)) {
      return { enabled: false, stage: 'socket-check', detail: `daemon returned without a control socket at ${socket}` };
    }
    return { enabled: true, stage: 'enabled', endpoint: codexRemoteEndpoint(ctx.home) };
  } catch (e) {
    return { enabled: false, stage: 'setup-error', detail: e instanceof Error ? e.message : String(e) };
  }
}
