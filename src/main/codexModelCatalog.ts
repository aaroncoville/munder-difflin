import { spawn } from 'node:child_process';
import { app } from 'electron';
import { resolveCommand, userShellPath } from './shellEnv';
import {
  parseCodexModelList,
  type ModelCatalogProvider,
  type ModelCatalogResult
} from '../shared/modelCatalog';

/** Runs the `model/list` query and resolves codex's raw result object.
 *  Injectable so the adapter's contract can be tested without the CLI. */
export type CodexRunner = (env: NodeJS.ProcessEnv) => Promise<unknown>;

/** The whole query is one cold CLI start plus one local read; anything slower
 *  than this is a wedged process, and the picker is waiting on a user click. */
const TIMEOUT_MS = 10_000;

/** Real transport: `codex app-server`, JSON-RPC over stdio.
 *
 *  Framing verified against codex-cli 0.149.1 — see the same app-server call
 *  documented in src/main/hive.ts:1924, which uses `initialize` then `hooks/list`
 *  to read codex's own normalized hook timeouts without spending a token:
 *
 *    → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{…}}}
 *    ← {"id":1,"result":{"userAgent":…,"codexHome":…}}
 *    → {"jsonrpc":"2.0","method":"initialized"}
 *    → {"jsonrpc":"2.0","id":2,"method":"model/list","params":{}}
 *    ← {"id":2,"result":{"data":[…],"nextCursor":null}}
 *
 *  Three details are load-bearing and were each observed, not assumed:
 *  `clientInfo.version` is REQUIRED (omitting it answers `-32600 Invalid
 *  request: missing field version`, and every later call then fails with "Not
 *  initialized"); messages are newline-delimited JSON, one object per line; and
 *  the server interleaves unsolicited notifications (`remoteControl/status/
 *  changed`) with responses, so a reader that assumes the next line is its
 *  answer will parse the wrong object. `model/list` reads the account's catalog
 *  and starts no conversation, so it costs nothing. */
export const defaultCodexRunner: CodexRunner = (env) =>
  new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveCommand('codex'), ['app-server'], {
        // Same env shape as the app's other CLI spawns (see hiddenClaude.ts):
        // the login-shell PATH, then the caller's overrides. CODEX_HOME is left
        // to the caller, so the query reads the account the user is logged into.
        env: { ...env, PATH: userShellPath() },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const timer = setTimeout(
      () => finish(() => reject(new Error(`codex model/list timed out after ${TIMEOUT_MS}ms`))),
      TIMEOUT_MS
    );
    const send = (msg: object): void => { try { child.stdin?.write(`${JSON.stringify(msg)}\n`); } catch { /* the exit handler reports it */ } };

    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code) =>
      finish(() => reject(new Error(`codex app-server exited with code ${code ?? 'unknown'}`))));

    let buf = '';
    child.stdout?.on('data', (chunk) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1 && msg.id !== 2) continue; // a notification, not our answer
        if (msg.error) {
          const failed = msg.id === 1 ? 'initialize' : 'model/list';
          finish(() => reject(new Error(`codex ${failed} failed: ${msg.error?.message ?? 'unknown error'}`)));
          return;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} });
        } else {
          const result = msg.result;
          finish(() => resolve(result));
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'munder-difflin',
          title: 'Munder Difflin',
          // Required by the server; it only ends up in codex's userAgent string.
          version: app.getVersion()
        }
      }
    });
  });

/** The codex adapter: run the query, parse it, and turn EVERY failure into null.
 *
 *  Null is the whole contract. This runs behind a button in the model picker, so
 *  a rejected promise here would surface as an unhandled main-process error and
 *  leave the picker waiting, where the caller's fallback to the built-in list is
 *  a perfectly good answer. */
export function createCodexModelCatalog(
  runner: CodexRunner = defaultCodexRunner,
  env: NodeJS.ProcessEnv = process.env
): ModelCatalogProvider {
  return {
    async queryModels(): Promise<ModelCatalogResult | null> {
      try {
        return parseCodexModelList(await runner(env));
      } catch {
        return null;
      }
    }
  };
}
