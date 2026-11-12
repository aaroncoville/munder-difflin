/**
 * Which commit is deployed (spec 10.4; steel-thread ST-9), for the `http-json` kind:
 * GET a URL and read one JSON field holding the deployed commit.
 *
 * Anything but a full 40-hex sha is "unknown": a probe that fails to connect,
 * times out, answers an error, or returns something else never counts as "not
 * live" and never as "live". T7's guard is ancestry, which the conductor checks in
 * its mirror; this only reads D.
 */
import type { LiveProbeConfig } from './config';
import { own } from './forgeGitlab';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as { parseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } };

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' }) => Promise<{ ok: boolean; text(): Promise<string> }>;

const SHA_RE = /^[0-9a-f]{40}$/;

export async function probeLive(cfg: LiveProbeConfig, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<{ deployed: string | null }> {
  try {
    const res = await fetchFn(cfg.url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) return { deployed: null };
    const body = core.parseJson((await res.text()).slice(0, 1024 * 1024 + 1));
    const value = body.ok ? own(body.value, cfg.field) : undefined;
    return { deployed: typeof value === 'string' && SHA_RE.test(value) ? value : null };
  } catch {
    return { deployed: null };
  }
}
