import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse as parseToml } from 'smol-toml';
import { tomlBasicString } from '../shared/codexTrust';
import { isPlainObject } from './launchLine';

type Rpc = (method: string, params: unknown) => Promise<any>;
interface Context { home: string; cwd: string }
const EVENTS = ['preToolUse', 'postToolUse', 'stop', 'subagentStop',
  'sessionStart', 'userPromptSubmit', 'preCompact', 'postCompact'];

const MARKER = '# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';

interface OwnerHook { eventName: string; command: unknown; matcher: string | null }

/** The hooks in the owner's own config as the app copied it into the generated
 *  one (everything above the generated block), and the trust the owner recorded
 *  for them in that file (hooks.state, by hook id); null when they cannot be read. */
function ownerHooks(text: string): { hooks: OwnerHook[]; state: Record<string, string> } | null {
  let doc: unknown;
  try { doc = parseToml(text); } catch { return null; }
  if (!isPlainObject(doc)) return null;
  const out: { hooks: OwnerHook[]; state: Record<string, string> } = { hooks: [], state: {} };
  if (!Object.hasOwn(doc, 'hooks')) return out;
  const table = doc.hooks;
  if (!isPlainObject(table)) return null;
  for (const [event, groups] of Object.entries(table)) {
    if (event === 'state') {
      if (!isPlainObject(groups)) return null;
      for (const [id, v] of Object.entries(groups)) if (isPlainObject(v) && typeof v.trusted_hash === 'string') out.state[id] = v.trusted_hash;
      continue;
    }
    if (!Array.isArray(groups)) return null;
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) return null;
      if (g.matcher !== undefined && typeof g.matcher !== 'string') return null;
      for (const h of g.hooks) {
        if (!isPlainObject(h)) return null;
        out.hooks.push({ eventName: event.charAt(0).toLowerCase() + event.slice(1), command: h.command, matcher: (g.matcher as string | undefined) ?? null });
      }
    }
  }
  return out;
}

/** Persist the installed CLI's own hashes, rather than copying a version-specific
 * hash algorithm. Directory trust is a different gate.
 *
 * The hooks Codex lists for this agent must be exactly an allowed set: the
 * app's generated hooks, plus the hooks in the owner's own ~/.codex/config.toml
 * as the app copied it at spawn. Any other listed hook (one planted in a
 * project layer, a bare hooks.json, an extra entry in the home's config) is
 * refused whether it is trusted, untrusted, disabled or managed: trust that is
 * already recorded says nothing about who wrote the hook. Generated hooks get
 * trust for their exact hashes; an owner hook keeps only the trust the owner
 * recorded for that same hash in their own config, and one the owner never
 * trusted refuses, since a worker would otherwise wait in the review menu.
 * On refusal this returns false and says why through `why`. */
export async function prepareCodexHookTrust(ctx: Context, rpc: Rpc, why: (reason: string) => void = () => {}): Promise<boolean> {
  const filePath = join(realpathSync(ctx.home), 'config.toml');
  const config = readFileSync(filePath, 'utf8');
  const [ownerPart, generated] = config.split(MARKER);
  if (!generated) { why('the generated hook block is missing from config.toml'); return false; }
  const commands = [...generated.matchAll(/^command = (.+)$/gm)].map(m => JSON.parse(m[1]));
  if (commands.length !== EVENTS.length || commands.some(c => c !== commands[0])) { why('the generated hook block was changed'); return false; }
  const owner = ownerHooks(ownerPart);
  if (!owner) { why(`the owner's Codex config copied into ${filePath} could not be read`); return false; }
  const ownerFile = join(homedir(), '.codex', 'config.toml');
  let ownerReal = ownerFile;
  try { ownerReal = realpathSync(ownerFile); } catch { /* none: no owner trust to carry */ }
  const list = async (): Promise<any[] | null> => {
    const result = await rpc('hooks/list', { cwds: [ctx.cwd] });
    const entry = result?.data?.[0];
    if (!entry || entry.errors?.length || !Array.isArray(entry.hooks)) return null;
    return entry.hooks;
  };
  const isGenerated = (h: any): boolean => h.sourcePath === filePath && h.source === 'user'
    && h.handlerType === 'command' && h.command === commands[0]
    && h.async === false && h.matcher === null && h.timeoutSec === 30
    && EVENTS.includes(h.eventName) && h.enabled === true
    && typeof h.key === 'string' && h.key.startsWith(`${filePath}:`)
    && /^sha256:[a-f0-9]{64}$/.test(h.currentHash);
  const isOwners = (h: any): boolean => !isGenerated(h) && h.sourcePath === filePath && h.source === 'user'
    && typeof h.key === 'string' && h.key.startsWith(`${filePath}:`)
    && owner.hooks.some(o => o.eventName === h.eventName && o.command === h.command && o.matcher === (h.matcher ?? null));
  // The trust the owner recorded for this hook in their own file: same position, same hash.
  const ownerTrusted = (h: any): boolean => {
    const at = (h.key as string).slice(filePath.length + 1);
    return [ownerReal, ownerFile].some(f => owner.state[`${f}:${at}`] === h.currentHash);
  };
  const named = (hs: any[]): string => hs.map(h => `${h.eventName} from ${h.sourcePath}`).join(', ');
  const needsTrust = (h: any): boolean => h.enabled && !h.isManaged && h.trustStatus !== 'trusted';
  const hooks = await list();
  if (!hooks) { why('Codex could not list the hooks'); return false; }
  const owned = hooks.filter(isGenerated);
  if (EVENTS.some(event => !owned.some(h => h.eventName === event))) { why('Codex did not list every generated hook'); return false; }
  const others = hooks.filter(h => !isGenerated(h) && !isOwners(h));
  if (others.length) {
    why(`a hook the app did not write is listed for this agent: ${named(others)}`);
    return false;
  }
  const owners = hooks.filter(isOwners);
  const unvouched = owners.filter(h => needsTrust(h) && !ownerTrusted(h));
  if (unvouched.length) {
    why(`a hook in the owner's own Codex config is not trusted in ${ownerFile}: ${named(unvouched)}`);
    return false;
  }
  const edits = [...owned, ...owners].filter(needsTrust).map(h => ({
    keyPath: `hooks.state.${tomlBasicString(h.key)}.trusted_hash`,
    value: h.currentHash,
    mergeStrategy: 'replace'
  }));
  if (!edits.length) return true;
  // Do not overwrite a config changed while discovery was in progress.
  if (readFileSync(filePath, 'utf8') !== config) { why('config.toml changed while hooks were being listed'); return false; }
  await rpc('config/batchWrite', { filePath, edits });
  const verified = await list();
  const ok = !!verified && owned.every(h => verified.some(v => v.key === h.key
    && v.currentHash === h.currentHash && v.trustStatus === 'trusted'))
    && verified.every(h => isGenerated(h) || isOwners(h))
    && !verified.some(needsTrust);
  if (!ok) why('the trust Codex recorded did not match the allowed hooks');
  return ok;
}

/** Bounded, model-free stdio app-server session. No shell and no hook execution:
 * only initialize, hooks/list and config writes. Never log protocol payloads
 * (the inherited user configuration may contain sensitive values). */
export async function seedCodexHookTrust(
  ctx: Context & { executable: string; env: NodeJS.ProcessEnv },
  timeoutMs = 5000,
  why: (reason: string) => void = () => {}
): Promise<boolean> {
  const child = spawn(ctx.executable, ['app-server'], {
    env: { ...ctx.env, CODEX_HOME: ctx.home }, cwd: ctx.cwd,
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const fail = (): void => {
    for (const request of pending.values()) request.reject(new Error('Codex hook trust preparation failed'));
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error('Codex hook trust request rejected'));
      else request.resolve(response.result);
    } catch { fail(); }
  });
  const rpc: Rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, timeoutMs);
  try {
    await rpc('initialize', { clientInfo: { name: 'munder-difflin', version: '1' }, capabilities: { experimentalApi: true } });
    return await prepareCodexHookTrust(ctx, rpc, why);
  } catch { why('the Codex app server did not answer'); return false; }
  finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}
