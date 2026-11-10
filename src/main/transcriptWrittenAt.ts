/**
 * When a Claude Code session's transcript was last written.
 *
 * The transcript usage fallback (telemetry.ts) has no event time of its own: it
 * sums token counts read from disk. Claude Code appends to one transcript per
 * session, named for the session id, as the session works, so the file's mtime
 * is the last time that session did anything. The worker wake watchdog reads
 * this as the agent's last activity when no live telemetry arrives.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from './transcript';

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** The mtime (ms) of `<project dir>/<sessionId>.jsonl`, or undefined when it is not there. */
export function transcriptWrittenAt(cwd: string, sessionId: string): number | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  try {
    const st = statSync(join(projectDir(cwd), `${sessionId}.jsonl`));
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}
