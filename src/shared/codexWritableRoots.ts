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
 *  ours. */
export function withCodexWritableRoots(config: string, roots: string[]): string {
  if (roots.length === 0) return config;
  const items = roots.map(tomlBasicString).join(', ');
  const lines = config.split('\n');
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
