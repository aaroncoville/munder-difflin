/**
 * The conductor's own bare mirror of a repo (spec 11 and 6.2; steel-thread ST-6).
 *
 * It lives in the app's data directory. It never uses the owner's checkouts or an
 * agent's worktree, and nothing here writes to the remote. Every call is git through
 * execFile with an argument array; every sha is checked to be a full 40-hex sha
 * before git sees it, so nothing an agent wrote can be read as an option or resolved
 * as a short or symbolic name. Fetching from GitLab over https authenticates through
 * glab's credential helper, so no token is on an argument list or in a URL.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { execRunner, isUnder, type Runner } from './forgeGitlab';

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
const MIRROR_REF_RE = /^refs\/(heads|mr)\/(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);

/**
 * Every answer about outside input is a refusal (false or null) when the input is
 * malformed or git fails; nothing here throws on what an agent or the forge wrote.
 */
export class GitMirror {
  /**
   * [dir] must be an absolute path outside every folder in [forbidden] (the hive root
   * and agents' folders), links resolved: the app writes its mirror only in its own
   * data directory.
   */
  constructor(
    private readonly dir: string,
    private readonly remote: string,
    private readonly run: Runner = execRunner,
    /** For an https GitLab remote: "!glab auth git-credential". None for a local path. */
    private readonly credentialHelper: string | null = null,
    forbidden: string[] = [],
  ) {
    if (!isAbsolute(dir)) throw new Error(`the mirror folder must be an absolute path: ${dir}`);
    const bad = forbidden.find((f) => isUnder(dir, f));
    if (bad) throw new Error(`the mirror folder ${dir} is under a forbidden folder (${bad})`);
  }

  /** Fetches [branches] and, for GitLab, MR heads (refs/merge-requests/<iid>/head). False when refused or failed. */
  async fetch(branches: string[], mrIids: number[] = []): Promise<boolean> {
    if (!branches.every((b) => BRANCH_RE.test(b)) || !mrIids.every((n) => Number.isInteger(n) && n >= 1)) return false;
    const specs = [
      ...branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`),
      ...mrIids.map((iid) => `+refs/merge-requests/${iid}/head:refs/mr/${iid}`),
    ];
    if (specs.length === 0) return true;
    try {
      if (!existsSync(`${this.dir}/HEAD`)) {
        mkdirSync(this.dir, { recursive: true });
        if ((await this.run('git', ['init', '--quiet', '--bare', this.dir])).code !== 0) return false;
      }
    } catch {
      return false;
    }
    const helper = this.credentialHelper ? ['-c', 'credential.helper=', '-c', `credential.helper=${this.credentialHelper}`] : [];
    return (await this.code([...helper, 'fetch', '--quiet', '--no-tags', '--', this.remote, ...specs])) === 0;
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
    const r = await this.run('git', ['-C', this.dir, 'rev-parse', '--verify', '--quiet', `${commit}^2`]);
    const out = r.stdout.trim();
    return r.code === 0 && isSha(out) ? out : null;
  }

  /** Paths the MR changes against the target (`git diff --name-only T...S`), or null when it cannot say. */
  async changedFiles(target: string, head: string): Promise<string[] | null> {
    if (!isSha(target) || !isSha(head)) return null;
    const r = await this.run('git', ['-C', this.dir, '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', `${target}...${head}`]);
    return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : null;
  }

  async revParse(ref: string): Promise<string | null> {
    if (!MIRROR_REF_RE.test(ref)) return null;
    const r = await this.run('git', ['-C', this.dir, 'rev-parse', '--verify', '--quiet', ref]);
    const out = r.stdout.trim();
    return r.code === 0 && isSha(out) ? out : null;
  }

  private async code(args: string[]): Promise<number> {
    return (await this.run('git', ['-C', this.dir, ...args])).code;
  }
}
