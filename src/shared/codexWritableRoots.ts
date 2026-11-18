import { parse as parseToml } from 'smol-toml';
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

/** The span of a `writable_roots = [...]` entry starting at `start`, through the end of its line; null when the
 *  value is not an array this scanner can follow. Strings and comments are honoured, so a `]` inside them does not
 *  end the array. */
function rootsEntryEnd(text: string, start: number): number | null {
  let i = text.indexOf('=', start);
  if (i === -1) return null;
  i++;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (text[i] !== '[') return null;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      for (i += close.length; i < text.length && !text.startsWith(close, i); i++) if (c === '"' && text[i] === '\\') i++;
      if (i >= text.length) return null;
      i += close.length - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      const eol = text.indexOf('\n', i);
      return eol === -1 ? text.length : eol + 1;
    }
  }
  return null;
}

const listedRoots = (config: string): unknown => {
  const doc = parseToml(config) as Record<string, unknown>;
  const table = doc.sandbox_workspace_write;
  return table && typeof table === 'object' ? (table as Record<string, unknown>).writable_roots : undefined;
};

/** As withCodexWritableRoots, for a seat given scoped write roots: the config's writable roots become exactly `roots`.
 *
 *  The generated config is a copy of the owner's, so a root the owner lists there would be added to every seat, and
 *  one that reaches another seat's folder or the hive's shared files undoes the scoping. Those entries are replaced,
 *  not kept after ours. When the owner's roots are in a form the key cannot be replaced in (an inline table, a dotted
 *  key), or the result does not read back as exactly `roots`, this throws: the spawn is refused rather than run with
 *  roots the app did not choose. */
export function withOnlyCodexWritableRoots(config: string, roots: string[]): string {
  let inherited: unknown;
  try { inherited = listedRoots(config); } catch { throw new Error('the Codex config could not be parsed, so its writable roots could not be replaced'); }
  let out = config;
  if (inherited !== undefined) {
    const lines = config.split('\n');
    const header = lines.findIndex((l) => /^\s*\[\s*sandbox_workspace_write\s*\]\s*(#.*)?$/.test(l));
    let offset = -1;
    for (let i = header + 1, at = lines.slice(0, header + 1).join('\n').length + 1; header !== -1 && i < lines.length && !/^\s*\[/.test(lines[i]); at += lines[i].length + 1, i++) {
      if (/^\s*writable_roots\s*=/.test(lines[i])) { offset = at; break; }
    }
    const end = offset === -1 ? null : rootsEntryEnd(config, offset);
    if (end === null) throw new Error('the owner\'s Codex config lists writable roots in a form the app cannot replace, so the seat\'s writable roots could not be limited to its own');
    out = config.slice(0, offset) + config.slice(end);
  }
  out = withCodexWritableRoots(out, roots);
  let written: unknown;
  try { written = listedRoots(out); } catch { written = null; }
  const exact = Array.isArray(written) && written.length === roots.length && written.every((r, i) => r === roots[i]);
  if (!exact && !(inherited === undefined && written === undefined)) {
    throw new Error('the seat\'s Codex config does not read back with exactly its scoped writable roots');
  }
  return out;
}
