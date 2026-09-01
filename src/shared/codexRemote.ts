import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CODEX_REMOTE_SOCKET_RELATIVE =
  'app-server-control/app-server-control.sock';

/** macOS caps a Unix socket path at 104 bytes (`sun_path`), and Codex builds its
 *  control socket as `$CODEX_HOME/app-server-control/app-server-control.sock` —
 *  42 bytes of suffix. So the alias home itself must fit in ~61 bytes.
 *
 *  `$TMPDIR` cannot host it: macOS spells it
 *  `/var/folders/xx/<30-char-hash>/T/` (49 bytes) and the alias came out at 121
 *  — LONGER than the 118-byte real home it was introduced to shorten, so every
 *  daemon start failed with `path must be shorter than SUN_LEN`. Root the alias
 *  at a fixed short prefix instead and keep the digest to 8 hex chars: the whole
 *  socket path then lands at 60 bytes with room to spare. */
export const CODEX_REMOTE_ALIAS_ROOT = '/tmp/mdc';

/** Longest socket path the platform will accept, minus a small safety margin. */
export const CODEX_REMOTE_SOCKET_MAX = 104;

/** Keep the CODEX_HOME spelling short enough for macOS's Unix-socket limit.
 *  `tempRoot` defaults to the short fixed root; callers may override it (tests). */
export function codexRemoteAliasPath(
  realHome: string,
  agentId: string,
  tempRoot: string = CODEX_REMOTE_ALIAS_ROOT
): string {
  const digest = createHash('sha256')
    .update(`${realHome}\0${agentId}`)
    .digest('hex')
    .slice(0, 8);
  return join(tempRoot, digest);
}

/** Whether a candidate home yields a control socket the platform can bind. */
export function codexRemoteSocketFits(shortHome: string): boolean {
  return join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE).length < CODEX_REMOTE_SOCKET_MAX;
}

export function codexRemoteEndpoint(shortHome: string): string {
  return `unix://${join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE)}`;
}

/** Global options must precede `resume`, so prepend the endpoint in all cases. */
export function withCodexRemoteArgs(args: string[], endpoint: string): string[] {
  if (args.includes('--remote')) return args;
  return ['--remote', endpoint, ...args];
}

/** Establish the short home for one agent and return it, or null if it cannot be
 *  had. Idempotent: an alias already pointing at [realHome] is reused.
 *
 *  Split out from the caller because the socket length decision and the symlink
 *  are the whole of what makes a Codex agent bootable, and they are needed by
 *  more than the remote-control path that first introduced them. */
export function ensureCodexShortHome(
  realHome: string,
  agentId: string,
  tempRoot: string = CODEX_REMOTE_ALIAS_ROOT
): string | null {
  const alias = codexRemoteAliasPath(realHome, agentId, tempRoot);
  // Decide before touching the filesystem: a home that cannot host the socket is
  // worse than no alias, because the failure would surface at bind time as a
  // readiness timeout rather than as the length problem it is.
  if (!codexRemoteSocketFits(alias)) return null;
  mkdirSync(dirname(alias), { recursive: true });
  if (existsSync(alias)) {
    const st = lstatSync(alias);
    const points = st.isSymbolicLink()
      && resolve(dirname(alias), readlinkSync(alias)) === resolve(realHome);
    return points ? alias : null;
  }
  symlinkSync(realHome, alias, 'dir');
  return alias;
}
