import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const CODEX_REMOTE_SOCKET_RELATIVE =
  'app-server-control/app-server-control.sock';

/** macOS caps a Unix socket path at 104 bytes (`sun_path`), and Codex builds its
 *  control socket as `$CODEX_HOME/app-server-control/app-server-control.sock` —
 *  42 bytes of suffix. So the home itself must fit in ~61 bytes, which an agent
 *  directory does not.
 *
 *  `$TMPDIR` cannot host the short home: macOS spells it
 *  `/var/folders/xx/<30-char-hash>/T/` and resolves it through `/private`, which
 *  comes to 112 bytes of socket path — worse than the home it would replace.
 *
 *  `~/.mdc` with an 8-hex digest lands at 76 bytes, leaving room for a longer
 *  user name, and unlike `/tmp` it survives a reboot: this is where the agent's
 *  Codex sessions and history actually live, not a scratch link. */
export function codexShortHomeRoot(): string {
  // Read when used, never captured at module load: a constant evaluated at import
  // time freezes whatever $HOME happened to be then, which is both wrong for a
  // process whose environment changes under it and untestable — a test that
  // points $HOME at a sandbox would still have written into the real one.
  return join(homedir(), '.mdc');
}

/** Longest socket path the platform will accept, minus a small safety margin. */
export const CODEX_REMOTE_SOCKET_MAX = 104;

/** Where one agent's Codex home lives, short enough for macOS's Unix-socket
 *  limit. Derived from the agent's own directory and id, so it is stable across
 *  respawns and distinct per agent. `root` defaults to the fixed short root;
 *  callers may override it (tests). */
export function codexShortHomePath(
  agentHome: string,
  agentId: string,
  root: string = codexShortHomeRoot()
): string {
  const digest = createHash('sha256')
    .update(`${agentHome}\0${agentId}`)
    .digest('hex')
    .slice(0, 8);
  return join(root, digest);
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

/** Establish the Codex home for one agent and return it, or null when this
 *  agent cannot be given one. Idempotent: a home already established for this
 *  agent is reused, so a respawn never strands the last session.
 *
 *  The SHORT path is the real directory and the agent's own `.codex` is the link
 *  onto it — deliberately that way round. Codex canonicalizes $CODEX_HOME before
 *  deriving its control socket, so a link at the short end resolves straight back
 *  to the long agent path and shortens nothing; only a link at the agent end
 *  survives being resolved. Everything that reads the agent directory still finds
 *  `.codex` exactly where it has always been.
 *
 *  An agent already holding a REAL `.codex` keeps it, and gets null. Those homes
 *  hold live sessions, history and auth links, and moving one out from under a
 *  running agent is a deliberate maintenance action rather than a side effect of
 *  the next spawn. Such an agent keeps working: the caller falls back to a local
 *  TUI, as it did before any of this existed. */
export function ensureCodexShortHome(
  agentHome: string,
  agentId: string,
  root: string = codexShortHomeRoot()
): string | null {
  const short = codexShortHomePath(agentHome, agentId, root);
  // The daemon binds inside the RESOLVED home, so that is the path that has to
  // fit — measuring the one we happened to construct is what hid this for weeks.
  if (!codexRemoteSocketFits(short)) return null;
  // lstat, not existsSync: existsSync follows the link, so a home left behind
  // pointing at a directory that has since been removed reads as absent — and
  // the symlink below then throws EEXIST, which used to surface as a Codex agent
  // silently launching with the long home it could not bind.
  const present = lstatSync(agentHome, { throwIfNoEntry: false });
  if (present) {
    if (!present.isSymbolicLink()) return null; // a real home of its own — leave it
    const ours = resolve(dirname(agentHome), readlinkSync(agentHome)) === resolve(short);
    if (!ours) return null; // someone else's home: never adopted, never replaced
    mkdirSync(short, { recursive: true }); // the link can outlive its target
    return short;
  }
  mkdirSync(short, { recursive: true });
  mkdirSync(dirname(agentHome), { recursive: true });
  symlinkSync(short, agentHome, 'dir');
  return short;
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
  root: string = codexShortHomeRoot()
): { env: T; shortened: boolean } {
  const agentHome = env.CODEX_HOME;
  if (!agentHome) return { env, shortened: false };
  const short = ensureCodexShortHome(agentHome, agentId, root);
  if (!short) return { env, shortened: false };
  return { env: { ...env, CODEX_HOME: short }, shortened: true };
}
