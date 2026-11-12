/**
 * The conductor's own bare mirror of a repo (spec 11 and 6.2; steel-thread ST-6).
 *
 * It lives in the app's data directory. It never uses the owner's checkouts or an
 * agent's worktree, and nothing here writes to the remote. Every call is git through
 * execFile with an argument array and `--git-dir`, so git never walks up into a
 * repository around the mirror folder. Every sha is checked to be a full 40-hex sha
 * before git sees it, so nothing an agent wrote can be read as an option or resolved
 * as a short or symbolic name. Fetching from GitLab over https authenticates through
 * glab's credential helper, named by glab's absolute path, so no token is on an
 * argument list or in a URL. Only https and local-path remotes are fetched.
 *
 * Every answer about outside input is a refusal (false or null) when the input is
 * malformed or git fails; nothing here throws on what an agent or the forge wrote.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { credentialHelper, isUnder, makeRunner, requireForbidden, type Runner } from './forgeGitlab';

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
const MIRROR_REF_RE = /^refs\/(heads|mr)\/(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
/** An https URL with no credentials, query or fragment, or an absolute local path (for tests). */
const REMOTE_RE = /^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+|\/[^\0:]*)$/;

const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);

export class GitMirror {
  private readonly dir: string;
  private readonly remote: string;
  private readonly run: Runner;
  private readonly helper: string | null;

  /**
   * [dir] must be an absolute path outside every folder in [forbidden] (the hive root
   * and agents' folders), with links and case resolved: the app writes its mirror only
   * in its own data directory. [glab], for an https GitLab remote, is glab's absolute
   * path (as resolveTool found it); a local-path remote needs none.
   */
  constructor(opts: { dir: string; remote: string; forbidden: string[]; run?: Runner; glab?: string | null }) {
    const forbidden = requireForbidden(opts.forbidden);
    const { dir, remote } = opts;
    if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error(`the mirror folder must be an absolute path: ${String(dir)}`);
    const bad = forbidden.find((f) => isUnder(dir, f));
    if (bad) throw new Error(`the mirror folder ${dir} is under a forbidden folder (${bad})`);
    if (typeof remote !== 'string' || !REMOTE_RE.test(remote)) throw new Error(`not a remote this mirror fetches from (https or an absolute path): ${String(remote).slice(0, 80)}`);
    this.helper = opts.glab ? credentialHelper(opts.glab) : null;
    if (opts.glab && !this.helper) throw new Error(`not an absolute glab path: ${opts.glab}`);
    this.dir = dir;
    this.remote = remote;
    this.run = opts.run ?? makeRunner(forbidden);
  }

  /** Fetches [branches] and, for GitLab, MR heads (refs/merge-requests/<iid>/head). False when refused or failed. */
  async fetch(branches: string[], mrIids: number[] = []): Promise<boolean> {
    if (!Array.isArray(branches) || !Array.isArray(mrIids)) return false;
    if (!branches.every((b) => typeof b === 'string' && BRANCH_RE.test(b)) || !mrIids.every((n) => Number.isSafeInteger(n) && n >= 1)) return false;
    const specs = [
      ...branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`),
      ...mrIids.map((iid) => `+refs/merge-requests/${iid}/head:refs/mr/${iid}`),
    ];
    if (specs.length === 0) return true;
    try {
      if (!existsSync(`${this.dir}/HEAD`)) {
        mkdirSync(this.dir, { recursive: true });
        if ((await this.run('git', ['init', '--quiet', '--bare', '--', this.dir], { cwd: '/' })).code !== 0) return false;
      }
    } catch {
      return false;
    }
    const helper = this.helper ? ['-c', 'credential.helper=', '-c', `credential.helper=${this.helper}`] : [];
    const protocols = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=always'];
    return (await this.code([...helper, ...protocols, 'fetch', '--quiet', '--no-tags', '--', this.remote, ...specs])) === 0;
  }

  async hasCommit(commit: string): Promise<boolean> {
    return isSha(commit) && (await this.code(['cat-file', '-e', `${commit}^{commit}`])) === 0;
  }

  /** `git merge-tree --write-tree T S`: clean, conflict, or null when it cannot say. */
  async mergeTree(target: string, head: string): Promise<'clean' | 'conflict' | null> {
    if (!isSha(target) || !isSha(head)) return null;
    const code = await this.code(['merge-tree', '--write-tree', '--no-messages', target, head]);
    return code === 0 ? 'clean' : code === 1 ? 'conflict' : null;
  }

  /** Whether [ancestor] is an ancestor of [descendant], or null when it cannot say. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean | null> {
    if (!isSha(ancestor) || !isSha(descendant)) return null;
    const code = await this.code(['merge-base', '--is-ancestor', ancestor, descendant]);
    return code === 0 ? true : code === 1 ? false : null;
  }

  /** The merge commit's second parent: the MR head it merged. Null for one parent, or when it cannot say. */
  async secondParent(commit: string): Promise<string | null> {
    if (!isSha(commit)) return null;
    const r = await this.git(['rev-parse', '--verify', '--quiet', `${commit}^2`]);
    const out = r.stdout.trim();
    return r.code === 0 && isSha(out) ? out : null;
  }

  /** Paths the MR changes against the target (`git diff --name-only T...S`), or null when it cannot say. */
  async changedFiles(target: string, head: string): Promise<string[] | null> {
    if (!isSha(target) || !isSha(head)) return null;
    const r = await this.git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${target}...${head}`]);
    return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : null;
  }

  async revParse(ref: string): Promise<string | null> {
    if (typeof ref !== 'string' || !MIRROR_REF_RE.test(ref)) return null;
    const r = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    const out = r.stdout.trim();
    return r.code === 0 && isSha(out) ? out : null;
  }

  /** git on the mirror, with no hook folder: nothing in the mirror's own folder runs. */
  private git(args: string[]) {
    return this.run('git', [`--git-dir=${this.dir}`, '-c', 'core.hooksPath=/dev/null', ...args], { cwd: '/' });
  }

  private async code(args: string[]): Promise<number> {
    return (await this.git(args)).code;
  }
}
