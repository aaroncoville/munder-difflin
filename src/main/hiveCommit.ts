import { spawn, type ChildProcess } from 'node:child_process';

export interface GitResult { ok: boolean; out: string; err: string }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/**
 * Identity and gc settings for every hive git command.
 *
 * `gc.autoDetach=false` is what makes a commit finished when its command exits. A commit runs `gc --auto`, and git
 * detaches that into a background process by default, so the caller believes the hive is quiescent while a gc it
 * cannot see is still writing into `.git/objects/`. Anything that touches the hive directory right after a commit races
 * that process: removing a hive home throws ENOTEMPTY, and a read can catch a half-written pack. It reproduces on its
 * own (create a HiveManager on a fresh temp home, call ensureAgent, then remove the home: ~3.5% of iterations throw
 * ENOTEMPTY, the leftover always `.git/objects/`); with this flag gc runs inline and 200 iterations pass clean. The gc
 * still happens; it just no longer outlives the command that triggered it.
 */
export const HIVE_GIT_CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local'];

/** A git command that takes longer than this is stopped. It no longer blocks anything while it runs, so the limit only
 *  has to catch a command that will never finish. SIGTERM lets git remove its own lock files on the way out. */
export const HIVE_GIT_TIMEOUT_MS = 120_000;

/** How long a git told to stop with SIGTERM has to exit before it is killed. */
export const HIVE_GIT_KILL_GRACE_MS = 5_000;

/**
 * An index.lock older than this is left by a git that is no longer running, and is removed.
 *
 * A lock younger than the longest a hive git can live (its time limit plus the grace before it is killed) may belong
 * to a git that is still running, possibly one a previous run of the app started just before it quit. Removing that
 * lock would put two writers on the index, which can leave it unreadable. The margin covers a slow exit and clock
 * granularity.
 */
export const HIVE_STALE_LOCK_MS = HIVE_GIT_TIMEOUT_MS + HIVE_GIT_KILL_GRACE_MS + 30_000;

/** How long git's output has to finish arriving once git itself has exited. */
export const HIVE_GIT_OUTPUT_WAIT_MS = 500;

/** Each hive git runs as the leader of its own process group, so a signal reaches whatever it started as well. */
const GROUPS = process.platform !== 'win32';

interface LiveGit { child: ChildProcess; exited: Promise<void> }

/** Every hive git running in this process, so quitting can stop them. */
const liveGits = new Set<LiveGit>();

function signalGit(child: ChildProcess, signal: NodeJS.Signals): void {
  if (GROUPS && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* the group has already gone */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Whether anything in the group git leads is still running, after git itself may have exited. */
function groupAlive(child: ChildProcess): boolean {
  if (!GROUPS || !child.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SIGTERM to the group, then SIGKILL if it is not gone within `graceMs`. Resolves once it has gone. */
async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
  signalGit(child, 'SIGTERM');
  const kill = setTimeout(() => signalGit(child, 'SIGKILL'), graceMs);
  // SIGKILL cannot be ignored; the extra second only bounds the wait for the kernel to remove what it killed.
  const end = Date.now() + graceMs + 1_000;
  while (groupAlive(child) && Date.now() < end) await delay(20);
  clearTimeout(kill);
}

/** Stop git and everything it started, and wait until git has exited and its group has gone. */
function stopGit(git: LiveGit, graceMs: number): Promise<void> {
  signalGit(git.child, 'SIGTERM');
  const kill = setTimeout(() => signalGit(git.child, 'SIGKILL'), graceMs);
  return git.exited.finally(() => clearTimeout(kill));
}

/** Stop every hive git still running and wait for each to exit. */
export function stopRunningGits(graceMs = HIVE_GIT_KILL_GRACE_MS): Promise<void> {
  return Promise.all([...liveGits].map((g) => stopGit(g, graceMs))).then(() => undefined);
}

/**
 * Run one hive git command. It resolves only once git has exited and nothing it started is left running, also when
 * the command times out: git's process group is told to stop, killed if it has not gone `killGraceMs` later, and
 * waited for, so the next command never starts while an earlier one is still writing.
 *
 * Exit, not the output closing, is what counts as finished. A child git starts shares git's output, so the output can
 * stay open long after git exits (or, while git waits for that child, after git has been told to stop). Once git has
 * exited its output gets a short wait to arrive, and anything still running in its group is stopped.
 */
export function runGit(args: string[], cwd: string, timeoutMs = HIVE_GIT_TIMEOUT_MS, killGraceMs = HIVE_GIT_KILL_GRACE_MS): Promise<GitResult> {
  let child: ChildProcess;
  try {
    child = spawn('git', [...HIVE_GIT_CONFIG, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: GROUPS });
  } catch (e) {
    return Promise.resolve({ ok: false, out: '', err: e instanceof Error ? e.message : String(e) });
  }
  let out = '';
  let err = '';
  let failure = '';
  let code: number | null = null;
  child.stdout?.setEncoding('utf8').on('data', (d: string) => { out += d; });
  child.stderr?.setEncoding('utf8').on('data', (d: string) => { err += d; });
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  const gone = new Promise<void>((resolve) => {
    child.on('error', (e) => { failure ||= e.message; resolve(); });
    child.on('exit', (c) => { code = c; resolve(); });
  });
  const exited = (async (): Promise<void> => {
    await gone;
    await Promise.race([closed, delay(HIVE_GIT_OUTPUT_WAIT_MS)]);
    if (groupAlive(child)) await stopGroup(child, killGraceMs);
    child.stdout?.destroy();
    child.stderr?.destroy();
  })();
  const live: LiveGit = { child, exited };
  liveGits.add(live);
  const timer = setTimeout(() => {
    failure ||= `git ${args[0]} did not finish within ${timeoutMs} ms`;
    void stopGit(live, killGraceMs);
  }, timeoutMs);
  return exited.then(() => {
    clearTimeout(timer);
    liveGits.delete(live);
    const extra = failure ? `${err && !err.endsWith('\n') ? '\n' : ''}${failure}` : '';
    return { ok: !failure && code === 0, out, err: err + extra };
  });
}

/**
 * What the hive repository records inside each agent's folder: these files and nothing else.
 *
 * An agent's folder is also its working directory, so it fills with whatever the agent makes there: provider homes,
 * package caches, scratch checkouts, test fixtures. `git add -A` hashed all of it, and a couple of gigabytes of scratch
 * folders made every commit time out. Their names are the agent's choice, so no list of known heavy folders can keep
 * up; the hive state in there is these few files. Written as ignore rules, git never even walks the rest.
 */
export const AGENT_TRACKED_FILES = ['memory.md', 'identity.md', '.gitignore'];
export const AGENT_ALLOWLIST_IGNORE_LINES = ['agents/*/*', ...AGENT_TRACKED_FILES.map((f) => `!agents/*/${f}`)];

/**
 * Drop from the index every path under `agents/` and the cost ledger that the ignore rules now exclude. git keeps
 * recording a file it already tracks whatever .gitignore says, so without this a hive that predates a rule goes on
 * committing everything the rule was meant to keep out. The files stay on disk; only their history stops.
 */
export async function untrackIgnored(root: string, git: GitRunner): Promise<number> {
  const listed = await git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard', '--', 'agents', 'cost-ledger.jsonl'], root);
  if (!listed.ok) return 0;
  const paths = listed.out.split('\0').filter(Boolean);
  if (paths.length === 0) return 0;
  // In batches, so a large backlog never runs into the command-line length limit.
  for (let i = 0; i < paths.length; i += 500) {
    const removed = await git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...paths.slice(i, i + 500).map((p) => `:(literal)${p}`)], root);
    if (!removed.ok) return i;
  }
  return paths.length;
}

/** Every commit queue's running drain in this process. */
const draining = new Set<Promise<void>>();

/** Resolves once no commit queue in this process is running or waiting: what has to happen before a hive folder can be
 *  removed, because a commit still running would be writing into it. */
export async function allCommitsIdle(): Promise<void> {
  while (draining.size) await Promise.all([...draining]);
}

export interface CommitQueueOptions {
  /** Consecutive failures after which the queue reports, once, that commits are failing. */
  failingAfter?: number;
  warn?: (line: string) => void;
  /** Told once when a run of failures reaches `failingAfter`, and once when commits recover from it. */
  onFailing?: (failures: number, error: string) => void;
  onRecovered?: (failures: number) => void;
}

/**
 * Runs hive commits one at a time, off the caller's thread.
 *
 * A commit used to run synchronously wherever state changed: every message, route pass and archive. Each git command
 * had an eight-second limit and a commit could try five times, so a repository git was slow in froze the app for over a
 * minute per call. Now a request returns at once. While a commit runs, further requests for the same repository are
 * folded into one follow-up commit, because `git add -A` records everything that changed in between anyway.
 *
 * A failure is not retried: the changes stay on disk and the next commit records them. Each failure would otherwise
 * be its own warning, so the first one is logged with git's error, and a run of failures is reported once when it
 * reaches `failingAfter` and once more when commits succeed again.
 */
export class CommitQueue {
  private running: Promise<void> | null = null;
  private readonly pending = new Map<string, string[]>();
  private failures = 0;
  private closed = false;
  private readonly failingAfter: number;
  private readonly warn: (line: string) => void;

  constructor(
    private readonly job: (root: string, message: string) => Promise<GitResult>,
    private readonly opts: CommitQueueOptions = {}
  ) {
    this.failingAfter = opts.failingAfter ?? 3;
    this.warn = opts.warn ?? ((line) => console.warn(line));
  }

  request(root: string, message: string): void {
    if (this.closed) return;
    const messages = this.pending.get(root);
    if (messages) messages.push(message);
    else this.pending.set(root, [message]);
    if (!this.running) {
      const running = this.drain();
      this.running = running;
      draining.add(running);
      void running.finally(() => draining.delete(running));
    }
  }

  /**
   * For quitting: take no more requests and drop the waiting ones (their changes stay on disk for the next run). A
   * commit still running gets `graceMs` to finish; then `stop` ends it, and this resolves once it has.
   */
  async close(graceMs: number, stop: () => Promise<void>): Promise<void> {
    this.closed = true;
    this.pending.clear();
    const running = this.running;
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([running.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), graceMs); })]);
    clearTimeout(timer);
    if (!finished) await stop();
    await this.idle();
  }

  /** Resolves once no commit is running or waiting. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  consecutiveFailures(): number {
    return this.failures;
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.takeNext(); next; next = this.takeNext()) {
        const [root, messages] = next;
        let result: GitResult;
        try {
          result = await this.job(root, combineMessages(messages));
        } catch (e) {
          result = { ok: false, out: '', err: e instanceof Error ? e.message : String(e) };
        }
        this.record(result);
      }
    } finally {
      this.running = null;
    }
  }

  private takeNext(): [string, string[]] | undefined {
    const first = this.pending.entries().next();
    if (first.done) return undefined;
    this.pending.delete(first.value[0]);
    return first.value;
  }

  private record(result: GitResult): void {
    if (result.ok) {
      if (this.failures >= this.failingAfter) {
        this.warn(`[hive] commits are working again after ${this.failures} failures in a row`);
        this.opts.onRecovered?.(this.failures);
      }
      this.failures = 0;
      return;
    }
    this.failures += 1;
    const error = (result.err || result.out).trim() || 'git gave no error output';
    if (this.failures === 1) this.warn(`[hive] commit failed: ${error}`);
    if (this.failures === this.failingAfter) {
      this.warn(`[hive] ${this.failures} hive commits in a row have failed; changes stay on disk until one succeeds. Last error: ${error}`);
      this.opts.onFailing?.(this.failures, error);
    }
  }
}

/** One commit for several requests: the first request is the subject, the rest are listed in the body. */
export function combineMessages(messages: string[]): string {
  if (messages.length === 1) return messages[0];
  return `${messages[0]} (+${messages.length - 1} more)\n\n${messages.slice(1).map((m) => `- ${m}`).join('\n')}`;
}
