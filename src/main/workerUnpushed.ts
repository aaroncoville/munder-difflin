import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface UnpushedBranch {
  worktree: string;
  /** The checked-out branch, or 'HEAD' when detached. */
  branch: string;
  tip: string;
  upstream: string | null;
}

const GIT_TIMEOUT_MS = 5_000;

/** Stdout, or null on any failure. Asynchronous because this runs in the main
 *  process: a synchronous call on a slow repository would freeze the app. The
 *  timer is ours because execFile's own `timeout` only signals the child and its
 *  callback still waits for stdio to close, which a surviving grandchild holding
 *  the pipe can delay indefinitely. */
function git(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => {
      clearTimeout(timer);
      resolve(err ? null : stdout.trim());
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve(null);
    }, timeoutMs);
  });
}

/** The one checkout's unpushed state: a report, nothing to report (undefined), or
 *  null when git could not answer. */
async function scanCheckout(dir: string, baseBranch: string, timeoutMs: number): Promise<UnpushedBranch | undefined | null> {
  const tip = await git(dir, ['rev-parse', '--short', 'HEAD'], timeoutMs);
  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs);
  if (tip === null || branch === null) return null;
  // Exits non-zero with no upstream configured, which is an answer and not a failure.
  const upstream = branch === 'HEAD' ? null : await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], timeoutMs);
  if (upstream) {
    const ahead = await git(dir, ['rev-list', '--count', '@{u}..HEAD'], timeoutMs);
    if (ahead === null) return null;
    return Number(ahead) > 0 ? { worktree: dir, branch, tip, upstream } : undefined;
  }
  const remotes = await git(dir, ['branch', '-r', '--contains', 'HEAD'], timeoutMs);
  if (remotes === null) return null;
  if (remotes) return undefined;
  // On no remote, but a base branch can carry local-only commits: a tip already in
  // the base holds nothing of this worker's. A failure here (the base is not a ref
  // in this checkout) is not evidence of that, so the branch is still reported.
  const inBase = await git(dir, ['merge-base', '--is-ancestor', 'HEAD', baseBranch], timeoutMs);
  return inBase === null ? { worktree: dir, branch, tip, upstream: null } : undefined;
}

/** Branches in a worker's app-created worktree, and in worktrees directly under
 *  it, whose commits exist on no remote: ahead of an upstream, or with no upstream
 *  and a tip no remote branch contains (a detached HEAD included). A worktree the
 *  worker made anywhere else is not found. Null when git could not answer. Reads
 *  remote-tracking refs only, so it never touches the network. */
export async function unpushedWorkerBranches(
  worktree: string | undefined, baseBranch: string, timeoutMs = GIT_TIMEOUT_MS
): Promise<UnpushedBranch[] | null> {
  if (!worktree || !existsSync(worktree)) return [];
  const dirs = [worktree];
  try {
    for (const e of await readdir(worktree, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(worktree, e.name, '.git'))) dirs.push(join(worktree, e.name));
    }
  } catch { return null; }
  const found: UnpushedBranch[] = [];
  for (const dir of dirs) {
    const result = await scanCheckout(dir, baseBranch, timeoutMs);
    if (result === null) return null;
    if (result) found.push(result);
  }
  return found;
}

const SCOPE = 'Only its app-created worktrees were scanned; any it made elsewhere were not.';

/** One paragraph for a notice about a worker that has ended. */
export function describeUnpushed(found: UnpushedBranch[] | null): string {
  if (found === null) return `Its worktrees could not be read, so check them for unpushed branches by hand. ${SCOPE}`;
  if (found.length === 0) return `No unpushed branch was found. ${SCOPE}`;
  const lines = found.map((b) => `- ${b.branch === 'HEAD' ? 'detached HEAD' : b.branch} at ${b.tip} in ${b.worktree} (${b.upstream ? `ahead of ${b.upstream}` : 'on no remote'})`);
  return `These branches are NOT pushed, so push or integrate them before the worktree is cleaned up:\n${lines.join('\n')}\n${SCOPE}`;
}
