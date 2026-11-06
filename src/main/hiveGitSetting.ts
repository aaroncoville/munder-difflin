/**
 * Reads config.disableHiveGitCommits. Only the boolean true turns commits off, so a mistyped value leaves the hive as
 * it is by default; `warn` says so, because such a value is otherwise saved and ignored without a word.
 */
export function gitCommitsDisabled(value: unknown, warn: (line: string) => void = console.warn): boolean {
  if (value !== undefined && typeof value !== 'boolean') warn('[hive] disableHiveGitCommits is not true or false, so it is ignored');
  return value === true;
}

/**
 * Applies a config change. Turning commits back on prepares the hive again, because a hive that started with them off
 * has no repository and commit() does nothing without one. Only that flip does: this value comes with every settings
 * save, and preparing the hive rewrites the shims that live agents are running through.
 */
export function applyGitCommitsSetting(
  hive: { gitCommitsAreDisabled: () => boolean; setGitCommitsDisabled: (on: boolean) => void; ensureHive: () => void },
  value: unknown,
  warn?: (line: string) => void
): void {
  const disabled = gitCommitsDisabled(value, warn);
  const turnedOn = hive.gitCommitsAreDisabled() && !disabled;
  hive.setGitCommitsDisabled(disabled);
  if (turnedOn) hive.ensureHive();
}
