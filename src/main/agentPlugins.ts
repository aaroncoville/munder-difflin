/**
 * Which Claude plugins a hive agent's session loads. The owner's ~/.claude/settings.json enables plugins for every
 * session, so every agent started each plugin's MCP servers (a container per session, for some) and carried each
 * plugin's skill list in its context. The per-agent settings file the app passes with --settings sets enabledPlugins,
 * which outranks the owner's user-level value for that session only; the owner's own sessions are untouched.
 *
 * enabledPlugins has no "everything else" entry, so the map names every plugin the owner has: the ids in their
 * settings, the installed ones, and the ones synced from their organisation (`<name>@synced`). Kept names are on, all
 * others off. Plugins built into the CLI (`@builtin`) are left to it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_AGENT_PLUGINS } from '../shared/agentPluginDefaults';
export { DEFAULT_AGENT_PLUGINS };

/** The owner's Claude folder: CLAUDE_CONFIG_DIR when the app runs with one, else ~/.claude. */
export function claudeUserDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
const isTable = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Every plugin id the owner has: enabledPlugins keys in their settings, installed plugins, and synced plugins. */
export function knownPluginIds(dir: string): string[] {
  const ids = new Set<string>();
  const settings = readJson(join(dir, 'settings.json'));
  if (isTable(settings) && isTable(settings.enabledPlugins)) for (const k of Object.keys(settings.enabledPlugins)) ids.add(k);
  const installed = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  if (isTable(installed) && isTable(installed.plugins)) for (const k of Object.keys(installed.plugins)) ids.add(k);
  const synced = join(dir, 'plugins', 'synced');
  try {
    if (existsSync(synced)) {
      for (const org of readdirSync(synced)) {
        let entries: string[] = [];
        try { entries = readdirSync(join(synced, org)); } catch { continue; }
        for (const p of entries) {
          const m = readJson(join(synced, org, p, '.claude-plugin', 'plugin.json'));
          if (isTable(m) && typeof m.name === 'string' && m.name) ids.add(`${m.name}@synced`);
        }
      }
    }
  } catch { /* an unreadable synced folder lists nothing */ }
  return [...ids];
}

/** Bounds on the kept list as read from the app's settings. */
const MAX_KEPT = 200;
const MAX_NAME = 200;

/** The kept list from the app's settings, checked on read: unset is the default list; a list of plain non-empty strings
 *  within the bounds is used as given (trimmed; an empty list turns every plugin off); anything else (a hand-edited
 *  string, an object, a number, an over-long list or name) is the default list and one `log` call. Never throws. */
export function agentPluginList(raw: unknown, log: (why: string) => void): string[] {
  if (raw === undefined) return [...DEFAULT_AGENT_PLUGINS];
  const ok = Array.isArray(raw) && raw.length <= MAX_KEPT
    && raw.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= MAX_NAME);
  if (ok) return (raw as string[]).map((x) => x.trim());
  try { log(Array.isArray(raw) ? 'not a bounded list of plugin names' : `a ${raw === null ? 'null' : typeof raw}, not a list`); } catch { /* nothing further */ }
  return [...DEFAULT_AGENT_PLUGINS];
}

/** The enabledPlugins map for an agent: each known id on when the list keeps its name or its full id (any case), else
 *  off; built-ins are not listed. Matches are whole names or ids, never substrings. */
export function agentEnabledPlugins(ids: readonly string[], keep: readonly string[]): Record<string, boolean> {
  const kept = new Set(keep.map((k) => k.toLowerCase()));
  const out: Record<string, boolean> = {};
  for (const id of ids) {
    const at = id.lastIndexOf('@');
    if (at > 0 && id.slice(at + 1) === 'builtin') continue;
    out[id] = kept.has(id.toLowerCase()) || kept.has((at > 0 ? id.slice(0, at) : id).toLowerCase());
  }
  return out;
}
