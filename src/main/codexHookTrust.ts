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
 * hash algorithm. Directory trust is a different gate.
 *
 * Only the exact generated command is eligible. If any other enabled hook needs
 * review (one planted in a project layer, say), this returns false and says why
 * through `why`; the caller refuses the spawn rather than starting a worker
 * that would either sit in the hooks menu or run a hook nobody reviewed. */
export async function prepareCodexHookTrust(ctx: Context, rpc: Rpc, why: (reason: string) => void = () => {}): Promise<boolean> {
  const filePath = join(realpathSync(ctx.home), 'config.toml');
  const config = readFileSync(filePath, 'utf8');
  const generated = config.split('# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n')[1];
  if (!generated) { why('the generated hook block is missing from config.toml'); return false; }
  const commands = [...generated.matchAll(/^command = (.+)$/gm)].map(m => JSON.parse(m[1]));
  if (commands.length !== EVENTS.length || commands.some(c => c !== commands[0])) { why('the generated hook block was changed'); return false; }
  const list = async (): Promise<any[] | null> => {
    const result = await rpc('hooks/list', { cwds: [ctx.cwd] });
    const entry = result?.data?.[0];
    if (!entry || entry.errors?.length || !Array.isArray(entry.hooks)) return null;
    return entry.hooks;
  };
  const hooks = await list();
  if (!hooks) { why('Codex could not list the hooks'); return false; }
  const owned = hooks.filter(h => h.sourcePath === filePath && h.source === 'user'
    && h.handlerType === 'command' && h.command === commands[0]
    && h.async === false && h.matcher === null && h.timeoutSec === 30
    && EVENTS.includes(h.eventName) && h.enabled === true
    && typeof h.key === 'string' && h.key.startsWith(`${filePath}:`)
    && /^sha256:[a-f0-9]{64}$/.test(h.currentHash));
  if (EVENTS.some(event => !owned.some(h => h.eventName === event))) { why('Codex did not list every generated hook'); return false; }
  const needsTrust = (h: any): boolean => h.enabled && !h.isManaged && h.trustStatus !== 'trusted';
  const foreign = hooks.filter(h => needsTrust(h) && !owned.includes(h));
  if (foreign.length) {
    why(`a hook the app did not write would need trust: ${foreign.map(h => `${h.eventName} from ${h.sourcePath}`).join(', ')}`);
    return false;
  }
  const edits = owned.filter(needsTrust).map(h => ({
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
    && !verified.some(needsTrust);
  if (!ok) why('the trust Codex recorded did not match the generated hooks');
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
