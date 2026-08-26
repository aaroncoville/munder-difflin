import { spawn } from 'node:child_process';
import { getRemoteUrl } from './git';
import { issueHostFor, parseGitRemoteHost } from './gitHost';
import { listGitLabIssues } from './gitlab';

/** A GitHub issue, normalized for the renderer (labels/assignees flattened to names). */
export interface GHIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
}

/** Shape `gh issue list --json` emits for each issue (the fields we ask for). */
interface RawGHIssue {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
}

/**
 * List up to 30 issues in the repo at `cwd`, using whichever forge its `origin`
 * remote points at.
 *
 * The forge's own CLI does the fetching and owns authentication, so the only
 * decision made here is which one to run. An unrecognised host is reported as
 * such rather than guessed at — running the wrong client against the wrong API
 * produces a confusing failure instead of an actionable one.
 *
 * Returns `{ ok: false, error }` on any failure so callers never have to
 * try/catch.
 */
export async function listIssues(cwd: string): Promise<{ ok: boolean; issues?: GHIssue[]; error?: string }> {
  const remote = await getRemoteUrl(cwd);
  if (!remote.ok) return { ok: false, error: `could not read the 'origin' remote: ${remote.error}` };

  switch (issueHostFor(remote.url)) {
    case 'github': return listGitHubIssues(cwd);
    case 'gitlab': return listGitLabIssues(cwd);
    default: {
      // The host, never the URL: a remote can carry a personal access token,
      // and this string is rendered in the app and pasted into bug reports.
      const host = parseGitRemoteHost(remote.url);
      return {
        ok: false,
        error: `Fetching issues supports github.com and gitlab.com; the 'origin' remote points at ${host ? `'${host}'` : 'a URL with no recognisable host'}.`
      };
    }
  }
}

/**
 * List up to 30 issues in the repo at `cwd` via the `gh` CLI.
 *
 * Returns `{ ok: false, error }` on any failure — spawn error (e.g. `gh` not
 * installed), non-zero exit (e.g. unauthenticated / not a repo), or a JSON
 * parse failure — so callers never have to try/catch.
 */
function listGitHubIssues(cwd: string): Promise<{ ok: boolean; issues?: GHIssue[]; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'gh',
      ['issue', 'list', '--json', 'number,title,body,assignees,labels,url,state', '--limit', '30'],
      { cwd }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `gh exited ${code}` });
        return;
      }
      try {
        const raw = JSON.parse(stdout) as RawGHIssue[];
        const issues: GHIssue[] = (Array.isArray(raw) ? raw : []).map((i) => ({
          number: i.number ?? 0,
          title: i.title ?? '',
          body: i.body ?? '',
          url: i.url ?? '',
          labels: (i.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
          assignees: (i.assignees ?? []).map((a) => a.login ?? '').filter(Boolean)
        }));
        resolve({ ok: true, issues });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}

/** A CI (GitHub Actions) workflow run, normalized for the renderer. */
export interface CIRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

/** Shape `gh run list --json` emits for each run (the fields we ask for). */
interface RawCIRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
  databaseId?: number;
}

/**
 * List up to 5 recent CI (GitHub Actions) workflow runs in the repo at `cwd`
 * via the `gh` CLI.
 *
 * Returns `{ ok: false, error }` on any failure — spawn error (e.g. `gh` not
 * installed), non-zero exit (e.g. unauthenticated / not a repo / no Actions),
 * or a JSON parse failure — so callers never have to try/catch.
 */
export function listCIRuns(cwd: string): Promise<{ ok: boolean; runs?: CIRun[]; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'gh',
      ['run', 'list', '--limit', '5', '--json', 'name,status,conclusion,url,databaseId'],
      { cwd }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `gh exited ${code}` });
        return;
      }
      try {
        const raw = JSON.parse(stdout) as RawCIRun[];
        const runs: CIRun[] = (Array.isArray(raw) ? raw : []).map((r) => ({
          name: r.name ?? '',
          status: r.status ?? '',
          conclusion: r.conclusion ?? null,
          url: r.url ?? ''
        }));
        resolve({ ok: true, runs });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}
