import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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

/** The path Codex will actually bind, which is not always the one it is handed.
 *
 *  Codex canonicalizes $CODEX_HOME before deriving the control socket, so the
 *  length that matters is the RESOLVED one. Two consequences, both measured
 *  against codex-cli 0.149.1:
 *
 *   - A symlink shortens nothing. Handed a 63-byte alias onto a 120-byte agent
 *     home, the daemon reported `path must be shorter than SUN_LEN` for the home
 *     behind it.
 *   - On macOS even a genuinely short home grows: /tmp is itself a link to
 *     /private/tmp, so every path under it costs eight bytes nobody counted.
 *
 *  A home that does not exist yet cannot be resolved, so resolve the deepest
 *  ancestor that does and re-attach the rest — the ancestors are where the
 *  symlinks live. */
export function resolvedCodexHome(home: string): string {
  let head = resolve(home);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length ? join(realpathSync(head), ...tail) : realpathSync(head);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(home); // nothing on this path exists
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** Whether a candidate home yields a control socket the platform can bind. */
export function codexRemoteSocketFits(shortHome: string): boolean {
  return join(resolvedCodexHome(shortHome), CODEX_REMOTE_SOCKET_RELATIVE).length
    < CODEX_REMOTE_SOCKET_MAX;
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
  // Decide on the home the daemon will RESOLVE the alias to, which is the real
  // one — not on how short the alias is spelled. Measuring the alias was the
  // whole defect: it always looked short, so a home that could never bind was
  // offered anyway, and the failure surfaced ten seconds later as a readiness
  // timeout instead of as the length problem it is.
  //
  // Which means an alias cannot rescue an overlong home at all: it is the same
  // path by the time Codex measures it. Say so rather than pretend.
  if (!codexRemoteSocketFits(alias)) return null;
  if (!codexRemoteSocketFits(realHome)) return null;
  mkdirSync(dirname(alias), { recursive: true });
  // lstat, not existsSync: existsSync follows the link, so an alias left behind
  // pointing at a home that has since been removed reads as absent — and the
  // symlink below then throws EEXIST. Which, before this, surfaced as a Codex
  // agent silently launching with the long home it could not bind.
  const present = lstatSync(alias, { throwIfNoEntry: false });
  if (present) {
    const points = present.isSymbolicLink()
      && resolve(dirname(alias), readlinkSync(alias)) === resolve(realHome);
    return points ? alias : null;
  }
  symlinkSync(realHome, alias, 'dir');
  return alias;
}

/** The environment a Codex agent should actually be launched with.
 *
 *  Codex derives its app-server control socket from $CODEX_HOME, and macOS caps
 *  that path at sun_path bytes. A hive agent home
 *  (`…/hive/agents/<id>/.codex`) overflows it, so the daemon cannot start. An
 *  interactive agent survives that — the launcher falls back to a local TUI —
 *  but a headless worker has no TUI to fall back to and simply exits.
 *
 *  So the short home is not a feature of remote control; it is a precondition of
 *  a Codex agent booting at all, and every Codex spawn goes through here.
 *
 *  Returns the env unchanged when there is no Codex home to shorten (which is
 *  every other provider) or when no usable short home can be had — in that case
 *  the caller keeps a working home and can say why. */
export function shortCodexHomeEnv<T extends Record<string, string | undefined>>(
  env: T,
  agentId: string,
  tempRoot: string = CODEX_REMOTE_ALIAS_ROOT
): { env: T; shortened: boolean } {
  const realHome = env.CODEX_HOME;
  if (!realHome) return { env, shortened: false };
  const alias = ensureCodexShortHome(realHome, agentId, tempRoot);
  if (!alias) return { env, shortened: false };
  return { env: { ...env, CODEX_HOME: alias }, shortened: true };
}
