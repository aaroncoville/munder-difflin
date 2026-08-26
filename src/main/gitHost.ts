/**
 * Which forge a checkout belongs to, derived from its `origin` remote.
 *
 * Everything that talks to a forge on the user's behalf shells out to that
 * forge's own CLI, so the only thing that has to be decided up front is *which*
 * CLI. The repo's own remote URL is the one piece of evidence always present,
 * and it arrives in two unrelated syntaxes for the same repository depending on
 * how it was cloned.
 */

/**
 * The host part of a git remote URL, lowercased, or `null` if the URL is not a
 * form we recognise.
 *
 * Handles both shapes git uses in practice, because a clone over SSH and a
 * clone over HTTPS point at the same forge and must be treated the same:
 *
 *   `https://host/owner/repo.git`      (also `http://`, `ssh://`, `git://`,
 *                                       optionally `user:pass@` and `:port`)
 *   `git@host:owner/repo.git`          (scp-like — the default for SSH clones)
 *
 * Any credentials in the URL are discarded here rather than at the call site:
 * a remote can carry a personal access token, and the host is the only part of
 * it callers ever need.
 */
export function parseGitRemoteHost(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;

  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url);
  if (scheme) return scheme[1].toLowerCase();

  // scp-like. The colon introduces a path, not a port, which is what separates
  // `git@host:owner/repo` from a schemeless `host:1234/...` we would not
  // recognise anyway.
  const scp = /^(?:[^@/]*@)?([^/:]+):(?!\/)(.+)$/.exec(url);
  if (scp && scp[2].trim()) return scp[1].toLowerCase();

  return null;
}

/** A forge we can list issues from. */
export type IssueHost = 'github' | 'gitlab';

/**
 * The forge to fetch issues from for a repo whose `origin` is `remoteUrl`, or
 * `null` if it is neither of the two public hosts we support.
 *
 * Deliberately an exact-match on the public hostnames. A self-hosted GitLab or
 * a GitHub Enterprise instance is not inferred from a hostname that resembles
 * one: guessing wrong runs the wrong CLI against the wrong API, and a wrong
 * guess is harder to act on than being told the host is unsupported.
 */
export function issueHostFor(remoteUrl: string): IssueHost | null {
  switch (parseGitRemoteHost(remoteUrl)) {
    case 'github.com': return 'github';
    case 'gitlab.com': return 'gitlab';
    default: return null;
  }
}
