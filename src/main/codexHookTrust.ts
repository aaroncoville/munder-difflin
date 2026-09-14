import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { tomlBasicString } from '../shared/codexTrust';

type Rpc = (method: string, params: unknown) => Promise<any>;
interface Context { home: string; cwd: string }
const EVENTS = ['preToolUse', 'postToolUse', 'stop', 'subagentStop',
  'sessionStart', 'userPromptSubmit', 'preCompact', 'postCompact'];

/** Persist the installed CLI's own hashes, rather than copying a version-specific
 * hash algorithm. Directory trust is a different gate. The local TUI's bypass
 * flag is not persisted for the separately launched remote app-server.
 *
 * Only the exact generated command is eligible. If any other enabled hook needs
 * review, the caller must use the existing local TUI fallback instead of sending
 * an unattended worker into the remote hooks menu. */
export async function prepareCodexHookTrust(ctx: Context, rpc: Rpc): Promise<boolean> {
  const filePath = join(realpathSync(ctx.home), 'config.toml');
  const config = readFileSync(filePath, 'utf8');
  const generated = config.split('# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n')[1];
  if (!generated) return false;
  const commands = [...generated.matchAll(/^command = (.+)$/gm)].map(m => JSON.parse(m[1]));
  if (commands.length !== EVENTS.length || commands.some(c => c !== commands[0])) return false;
  const list = async (): Promise<any[] | null> => {
    const result = await rpc('hooks/list', { cwds: [ctx.cwd] });
    const entry = result?.data?.[0];
    if (!entry || entry.errors?.length || !Array.isArray(entry.hooks)) return null;
    return entry.hooks;
  };
  const hooks = await list();
  if (!hooks) return false;
  const owned = hooks.filter(h => h.sourcePath === filePath && h.source === 'user'
    && h.handlerType === 'command' && h.command === commands[0]
    && h.async === false && h.matcher === null && h.timeoutSec === 30
    && EVENTS.includes(h.eventName) && h.enabled === true
    && typeof h.key === 'string' && h.key.startsWith(`${filePath}:`)
    && /^sha256:[a-f0-9]{64}$/.test(h.currentHash));
  if (EVENTS.some(event => !owned.some(h => h.eventName === event))) return false;
  const needsTrust = (h: any): boolean => h.enabled && !h.isManaged && h.trustStatus !== 'trusted';
  if (hooks.some(h => needsTrust(h) && !owned.includes(h))) return false;
  const edits = owned.filter(needsTrust).map(h => ({
    keyPath: `hooks.state.${tomlBasicString(h.key)}.trusted_hash`,
    value: h.currentHash,
    mergeStrategy: 'replace'
  }));
  if (!edits.length) return true;
  // Do not overwrite a config changed while discovery was in progress.
  if (readFileSync(filePath, 'utf8') !== config) return false;
  await rpc('config/batchWrite', { filePath, edits });
  const verified = await list();
  return !!verified && owned.every(h => verified.some(v => v.key === h.key
    && v.currentHash === h.currentHash && v.trustStatus === 'trusted'))
    && !verified.some(needsTrust);
}

/** Bounded, model-free stdio app-server session. No shell and no hook execution:
 * only initialize, hooks/list and config writes. Never log protocol payloads
 * (the inherited user configuration may contain sensitive values). */
export async function seedCodexHookTrust(
  ctx: Context & { executable: string; env: NodeJS.ProcessEnv },
  timeoutMs = 5000
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
    return await prepareCodexHookTrust(ctx, rpc);
  } catch { return false; }
  finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}
