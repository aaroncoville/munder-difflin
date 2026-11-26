/**
 * The hooks a seat starts with, counted per settings source, for one usage row per spawn.
 *
 * Hooks run outside the seat's sandbox, and they come from several places: the app's own generated settings, the
 * owner's user and managed settings, a Claude seat's project and local files in its working folder (unless the spawn
 * dropped them), and for Codex the owner's own config the app copied. The row counts the hooks each source gives,
 * and a digest over (source, event, sha256 of the command) for every hook, sorted, so it is the same on every spawn
 * until a hook is added, removed or changed. Observe only: it holds source classes, counts and a digest, never a
 * command, a path or file content; a source that cannot be read or understood counts as null; nothing here throws.
 */
import { createHash } from 'node:crypto';
import { isPlainObject } from './launchLine';
import { readSettings } from './writeRoots';

/** The source classes a hook-inventory row may name. */
export const HOOK_SOURCES = ['app', 'user', 'managed', 'project', 'local', 'owner'] as const;
export type HookSource = (typeof HOOK_SOURCES)[number];
/** One hook: the event it runs on and its command (as written; only ever hashed). */
export interface HookEntry { event: string; command: unknown }
/** A source's hooks, or null when it could not be read or understood. */
export interface SourceHooks { source: HookSource; hooks: HookEntry[] | null }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The hooks in a Claude settings object ({ hooks: { Event: [{ matcher?, hooks: [{ command }] }] } }); null when the
 *  hooks key has another shape. No hooks key is no hooks. */
export function claudeHookEntries(doc: unknown): HookEntry[] | null {
  if (!isPlainObject(doc)) return null;
  if (!Object.hasOwn(doc, 'hooks')) return [];
  const table = doc.hooks;
  if (!isPlainObject(table)) return null;
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) return null;
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) return null;
      for (const h of g.hooks) {
        if (!isPlainObject(h)) return null;
        out.push({ event, command: h.command });
      }
    }
  }
  return out;
}

/** The hooks in Claude settings files read as one source (missing files add none); null if any cannot be read or
 *  understood. Each file is read without following a link and never blocks on a pipe (readSettings). */
export function claudeFileHooks(files: string[]): HookEntry[] | null {
  const out: HookEntry[] = [];
  for (const f of files) {
    const r = readSettings(f);
    if (r.kind === 'missing') continue;
    if (r.kind !== 'text') return null;
    let doc: unknown;
    try { doc = JSON.parse(r.text); } catch { return null; }
    const hooks = claudeHookEntries(doc);
    if (!hooks) return null;
    out.push(...hooks);
  }
  return out;
}

/** The usage row for one spawn's sources. */
export function hookInventoryRow(agentId: string, provider: 'claude' | 'codex', sources: SourceHooks[]): Record<string, unknown> {
  const lines: string[] = [];
  for (const s of sources) {
    if (s.hooks === null) { lines.push(`${s.source}\0!unreadable`); continue; }
    for (const h of s.hooks) {
      const command = typeof h.command === 'string' ? h.command : JSON.stringify(h.command ?? null);
      lines.push(`${s.source}\0${h.event}\0${sha256(command)}`);
    }
  }
  lines.sort();
  return {
    kind: 'hook-inventory', agentId, provider,
    sources: sources.map((s) => ({ source: s.source, count: s.hooks === null ? null : s.hooks.length })),
    digest: sha256(lines.join('\n')),
  };
}
