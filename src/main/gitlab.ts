import { spawn } from 'node:child_process';
import type { GHIssue } from './github';

/**
 * Issue listing for gitlab.com, via the `glab` CLI.
 *
 * Deliberately the same arrangement as the GitHub path: shell out to the
 * forge's own CLI, ask it for JSON, and let it own authentication. Nothing here
 * reads, stores, or is handed a token.
 */

/**
 * Shape `glab issue list --output json` emits for each issue.
 *
 * These are the GitLab REST API's own field names, and several differ from the
 * GitHub ones in ways that fail silently rather than loudly if assumed:
 *
 *  - `iid` is the per-project number rendered as #N. `id` is also present and
 *    is globally unique — using it would show users a number that matches
 *    nothing in their project.
 *  - `description`, not `body`, and it is `null` (not `''`) when unset.
 *  - `labels` is an array of plain **strings**, where `gh` returns objects with
 *    a `name`. Mapping it as though it held objects yields empty labels and no
 *    error.
 *  - assignees carry `username`, not `login`.
 */
export interface RawGitLabIssue {
  iid?: number;
  title?: string;
  description?: string | null;
  web_url?: string;
  state?: string;
  labels?: string[];
  assignees?: Array<{ username?: string }>;
}

/** Map `glab`'s JSON onto the shape the renderer already consumes. */
export function normalizeGitLabIssues(raw: unknown): GHIssue[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawGitLabIssue[]).map((i) => ({
    number: i.iid ?? 0,
    title: i.title ?? '',
    body: i.description ?? '',
    url: i.web_url ?? '',
    labels: (i.labels ?? []).filter((l): l is string => typeof l === 'string' && l !== ''),
    assignees: (i.assignees ?? []).map((a) => a.username ?? '').filter(Boolean)
  }));
}

/**
 * List up to 30 issues in the repo at `cwd` via the `glab` CLI.
 *
 * Returns `{ ok: false, error }` on any failure — spawn error (e.g. `glab` not
 * installed), non-zero exit (e.g. unauthenticated / not a project), or a JSON
 * parse failure — so callers never have to try/catch.
 */
export function listGitLabIssues(cwd: string): Promise<{ ok: boolean; issues?: GHIssue[]; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('glab', ['issue', 'list', '--output', 'json', '--per-page', '30'], { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `glab exited ${code}` });
        return;
      }
      try {
        resolve({ ok: true, issues: normalizeGitLabIssues(JSON.parse(stdout)) });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}
