import { tomlBasicString } from './codexTrust';

/** Extra writable roots for Codex's `workspace-write` sandbox, written into a
 *  config.toml.
 *
 *  `--add-dir` is the per-launch way to grant them, but Codex refuses it once the
 *  TUI is attached to an app server with `--remote` ("Configure additional
 *  workspace roots on the server"), and refuses a `-c
 *  sandbox_workspace_write.writable_roots` override for the same reason. The app
 *  server reads config.toml from its CODEX_HOME, so the roots have to live there.
 *
 *  `config` is the generated file so far, which may already carry the user's own
 *  `[sandbox_workspace_write]` table. TOML forbids declaring a table twice and
 *  Codex refuses a config it cannot parse, so an existing table gains the key
 *  instead, and an existing `writable_roots` array keeps the user's entries after
 *  ours.
 *
 *  A table can also be defined with no header at all, by a top-level dotted key
 *  (`sandbox_workspace_write.network_access = true`) or an inline table
 *  (`sandbox_workspace_write = { ... }`). Neither can take another key from
 *  outside, so the config is returned unchanged and `warn` says why the roots
 *  were not granted. */
export function withCodexWritableRoots(
  config: string,
  roots: string[],
  warn: (message: string) => void = console.warn,
): string {
  if (roots.length === 0) return config;
  const items = roots.map(tomlBasicString).join(', ');
  const lines = config.split('\n');
  const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
  const topLevel = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
  if (topLevel.some((l) => /^\s*(sandbox_workspace_write|"sandbox_workspace_write")\s*[.=]/.test(l))) {
    warn('config.toml defines sandbox_workspace_write without a [sandbox_workspace_write] header; extra writable roots were not added');
    return config;
  }
  const header = lines.findIndex((l) => /^\s*\[\s*sandbox_workspace_write\s*\]\s*(#.*)?$/.test(l));
  if (header === -1) {
    return `${config}\n[sandbox_workspace_write]\nwritable_roots = [${items}]\n`;
  }
  for (let i = header + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    const m = /^(\s*writable_roots\s*=\s*\[)(.*)$/.exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}${items}, ${m[2]}`;
      return lines.join('\n');
    }
  }
  lines.splice(header + 1, 0, `writable_roots = [${items}]`);
  return lines.join('\n');
}
