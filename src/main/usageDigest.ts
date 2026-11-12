/**
 * The weekly usage digest (docs/usage-log.md): one markdown file per ISO week at
 * <hive>/usage/digest-YYYY-Www.md, built from the hive log, the cost ledger and
 * the owner-side usage files. No LLM and no network; it holds ids, counts and
 * durations only, like the logs it summarizes. The daily research pass reads it
 * instead of mining the logs by hand.
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_STATUSES } from './usageEvents';
import { VIEWS } from './usageLog';

const DAY = 86_400_000;

/** The ISO week containing `ts` (UTC): its label and [start, end) bounds. */
export function isoWeek(ts: number): { label: string; start: number; end: number } {
  const d = new Date(ts);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(midnight).getUTCDay() + 6) % 7; // Monday = 0
  const start = midnight - dow * DAY;
  const thursday = new Date(start + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const n = Math.round((start - week1) / (7 * DAY)) + 1;
  return { label: `${year}-W${String(n).padStart(2, '0')}`, start, end: start + 7 * DAY };
}

type Row = Record<string, unknown>;
const parse = (lines: string[]): Row[] => {
  const out: Row[] = [];
  for (const l of lines) { try { const r = JSON.parse(l); if (r && typeof r === 'object') out.push(r as Row); } catch { /* torn */ } }
  return out;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
// The log files sit in the hive folder, which agents can write, so nothing in
// them is printed because it looks like an id. A printed string must be a known
// value (trigger, status, shape, view, lock kind, canary feature or code), a
// card in the current tasks.json, a router-minted conversation, or a keyed ref.
const ID = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const ASK_KEY = /^(.+)@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MINTED_CONVERSATION = /^conv-[0-9a-f]{6}$/;
const REF = /^[0-9a-f]{12}$/;
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): T | null =>
  (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
/** For lookups only, never printed. */
const id = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
const trigger = oneOf(['mail', 'heartbeat', 'scheduler', 'breaker', 'system', 'direct']);
const shape = oneOf(['done-ack', 'option', 'short', 'sentence', 'long']);
const status = oneOf(CARD_STATUSES);
const view = oneOf(VIEWS);
const lockKind = oneOf(['suite', 'build']);
const canaryFeature = oneOf(['memory-search', 'memory-wakeup', 'kg-search', 'hook-socket', 'helpers-intact', 'node-on-path', 'model-matches-launch']);
const CANARY_CODES = [
  'off', 'not-probed-spawn', 'not-probed-remote', 'not-probed-switching', 'not-loopback', 'no-hits', 'redirect', 'error', 'closed',
  'timeout', 'bad-reply', 'other-instance', 'wrong-pong', 'threw', 'no-root', 'not-found'
];
/** A canary's failure code: a known code, an HTTP refusal or an errno name; anything else is 'other'. */
const canaryCode = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  return CANARY_CODES.includes(v) || /^refused-\d{3}$/.test(v) || /^E[A-Z]{2,15}$/.test(v) ? v : 'other';
};
const cents = (x: number): number => Math.round(x * 100) / 100;
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** `cards`: the card ids in the current tasks.json, the only card ids the digest prints. */
export interface DigestInput { log: string[]; ledger: string[]; usage: string[]; start: number; end: number; cards?: ReadonlySet<string> }

export function summarize(i: DigestInput) {
  const cards = i.cards ?? new Set<string>();
  const askKey = (v: unknown): string | null => {
    const m = typeof v === 'string' ? ASK_KEY.exec(v) : null;
    return m && cards.has(m[1]) ? (v as string) : null;
  };
  /** A conversation as printed: a card or router-minted id, else its keyed ref. */
  const conversation = (r: Row): string | null => {
    const c = r.conversation;
    if (typeof c === 'string' && (MINTED_CONVERSATION.test(c) || cards.has(c))) return c;
    return typeof r.conversationRef === 'string' && REF.test(r.conversationRef) ? `ref:${r.conversationRef}` : null;
  };
  const inWeek = (r: Row): boolean => { const t = num(r.ts); return t !== null && t >= i.start && t < i.end; };
  const log = parse(i.log).filter(inWeek);
  const usage = parse(i.usage).filter(inWeek);

  // Positive cost increments per agent (the ledger's usd is cumulative per session).
  const prev = new Map<string, number>();
  const incs = new Map<string, Array<[number, number]>>();
  for (const r of parse(i.ledger)) {
    const agent = str(r.agent_id); const ts = num(r.ts); const usd = num(r.usd) ?? 0;
    if (!agent || ts === null) continue;
    const key = `${agent}\u0000${String(r.session_id)}`;
    const p = prev.get(key);
    prev.set(key, usd);
    if (p === undefined) continue;
    const inc = usd >= p ? usd - p : usd;
    if (inc > 0) (incs.get(agent) ?? incs.set(agent, []).get(agent)!).push([ts, inc]);
  }
  const usdIn = (agent: string, from: number, to: number): number =>
    (incs.get(agent) ?? []).reduce((s, [t, x]) => (t >= from && t <= to ? s + x : s), 0);

  const turnsByTrigger: Record<string, { turns: number; usd: number }> = {};
  const usdByConversation: Record<string, number> = {};
  const stateHours: Record<string, number> = {};
  const lockWaits: Record<string, { n: number; totalMs: number }> = {};
  const canaries: Record<string, { failed: number; runs: number; details: Set<string> }> = {};
  const filed: string[] = [];
  const shapes: Record<string, number> = {};
  let answered = 0;

  for (const r of log) {
    if (r.kind === 'turn') {
      const agent = id(r.agentId); const start = num(r.startTs); const dur = num(r.durationMs);
      if (!agent || start === null || dur === null) continue;
      const usd = usdIn(agent, start, start + dur);
      const t = (turnsByTrigger[trigger(r.trigger) ?? 'other'] ??= { turns: 0, usd: 0 });
      t.turns++; t.usd += usd;
      const conv = conversation(r);
      if (conv) usdByConversation[conv] = (usdByConversation[conv] ?? 0) + usd;
    } else if (r.kind === 'heavy-lock' && r.action === 'acquire') {
      const w = num(r.waitMs);
      if (w !== null) { const k = (lockWaits[lockKind(r.heavyKind) ?? 'other'] ??= { n: 0, totalMs: 0 }); k.n++; k.totalMs += w; }
    } else if (r.kind === 'canary') {
      const f = canaryFeature(r.feature); if (!f) continue;
      const c = (canaries[f] ??= { failed: 0, runs: 0, details: new Set() });
      c.runs++;
      if (r.ok === false) { c.failed++; const d = canaryCode(r.detail); if (d) c.details.add(d); }
    } else if (r.kind === 'ask-filed') {
      const k = askKey(r.askKey); if (k) filed.push(k);
    } else if (r.kind === 'ask-answered') {
      answered++;
      const s = shape(r.answerShape); if (s) shapes[s] = (shapes[s] ?? 0) + 1;
    }
  }
  for (const t of Object.values(turnsByTrigger)) t.usd = cents(t.usd);
  for (const k of Object.keys(usdByConversation)) usdByConversation[k] = cents(usdByConversation[k]);
  // Time in a state: the gap between a card's consecutive transition rows, read
  // from the rows' own timestamps (counted in the week the later row falls in).
  // An app start breaks every chain, since changes while the app was down are
  // not logged.
  const lastMove = new Map<string, number>();
  for (const r of parse(i.log)) {
    const t = num(r.ts);
    if (r.kind === 'app-start') { lastMove.clear(); continue; }
    if (r.kind !== 'card-transition' || t === null) continue;
    const card = id(r.cardId); if (!card) continue;
    const prevTs = lastMove.get(card);
    const from = status(r.from);
    if (from && prevTs !== undefined && t >= prevTs && inWeek(r)) stateHours[from] = (stateHours[from] ?? 0) + (t - prevTs) / 3_600_000;
    lastMove.set(card, t);
  }
  for (const k of Object.keys(stateHours)) stateHours[k] = Math.round(stateHours[k] * 10) / 10;

  const seen = new Set<string>(); const unseen: number[] = []; const thinking: number[] = [];
  const views = new Map<string, { view: string; opens: number; dwellMs: number }>();
  for (const r of usage) {
    if (r.kind === 'ask-shown') { const k = askKey(r.askKey); if (k) seen.add(k); const a = num(r.ageMs); if (a !== null) unseen.push(a); }
    else if (r.kind === 'ask-submitted') { const m = num(r.msSinceShown); if (m !== null) thinking.push(m); }
    else if (r.kind === 'ui-view' || r.kind === 'ui-view-end') {
      const v = view(r.view); if (!v) continue;
      const e = views.get(v) ?? views.set(v, { view: v, opens: 0, dwellMs: 0 }).get(v)!;
      if (r.kind === 'ui-view') e.opens++; else e.dwellMs += num(r.dwellMs) ?? 0;
    }
  }
  const canaryFailures: Record<string, { failed: number; runs: number; details: string[] }> = {};
  for (const [f, c] of Object.entries(canaries)) if (c.failed) canaryFailures[f] = { failed: c.failed, runs: c.runs, details: [...c.details].sort() };

  return {
    turnsByTrigger, usdByConversation, stateHours, lockWaits, canaryFailures,
    canaryFeatures: Object.keys(canaries).sort(),
    views: [...views.values()].sort((a, b) => b.dwellMs - a.dwellMs || b.opens - a.opens),
    asks: {
      filed: filed.length, answered, shapes,
      unseenMedianMs: quantile(unseen, 0.5), unseenP90Ms: quantile(unseen, 0.9),
      thinkingMedianMs: quantile(thinking, 0.5), thinkingP90Ms: quantile(thinking, 0.9),
      neverSeen: filed.filter((k) => !seen.has(k)).sort()
    }
  };
}

const mins = (ms: number | null): string => (ms === null ? 'n/a' : `${Math.round(ms / 60_000)} min`);

export function renderDigest(s: ReturnType<typeof summarize>, label: string): string {
  const out: string[] = [`# Usage digest ${label}`, '', 'Built locally from log.jsonl, cost-ledger.jsonl and usage/*.jsonl. Ids, counts and durations only.', ''];
  out.push('## Agent turns by trigger', '', '| trigger | turns | $ |', '|---|---|---|');
  for (const [k, v] of Object.entries(s.turnsByTrigger).sort((a, b) => b[1].usd - a[1].usd)) out.push(`| ${k} | ${v.turns} | $${v.usd.toFixed(2)} |`);
  out.push('', '## Dollars by conversation (top 15)', '', '| conversation | $ |', '|---|---|');
  for (const [k, v] of Object.entries(s.usdByConversation).sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`| ${k} | $${v.toFixed(2)} |`);
  out.push('', '## Asks', '',
    `- Filed ${s.asks.filed}, answered ${s.asks.answered}. Answer shapes: ${Object.entries(s.asks.shapes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    `- Time unseen (asked to first seen): median ${mins(s.asks.unseenMedianMs)}, p90 ${mins(s.asks.unseenP90Ms)}.`,
    `- Time thinking (seen to answered): median ${mins(s.asks.thinkingMedianMs)}, p90 ${mins(s.asks.thinkingP90Ms)}.`,
    `- Filed this week and never seen on the Ask Me board: ${s.asks.neverSeen.length ? s.asks.neverSeen.map((k) => `\`${k}\``).join(', ') : 'none'}.`);
  out.push('', '## Screens by attended time', '', '| view | opens | minutes |', '|---|---|---|');
  for (const v of s.views) out.push(`| ${v.view} | ${v.opens} | ${Math.round(v.dwellMs / 60_000)} |`);
  out.push('', '## Hours cards spent in each state (closed spells)', '', '| state | hours |', '|---|---|');
  for (const [k, v] of Object.entries(s.stateHours)) out.push(`| ${k} | ${v} |`);
  out.push('', '## Heavy-lock waits', '', '| kind | waits | total minutes |', '|---|---|---|');
  for (const [k, v] of Object.entries(s.lockWaits)) out.push(`| ${k} | ${v.n} | ${Math.round(v.totalMs / 60_000)} |`);
  out.push('', '## Canaries', '');
  if (!Object.keys(s.canaryFailures).length) out.push(`All passed (${s.canaryFeatures.join(', ') || 'none ran'}).`);
  for (const [k, v] of Object.entries(s.canaryFailures)) out.push(`- **${k}**: failed ${v.failed} of ${v.runs} (${v.details.join(', ') || 'no detail'})`);
  return out.join('\n') + '\n';
}

/** Lines of a file whose rows may be at or after `since`: read backwards in growing chunks, never the whole history. */
function linesSince(path: string, since: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let bytes = 4 << 20; ; bytes *= 2) {
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      const first = parse(lines.slice(0, 50)).map((r) => num(r.ts)).find((t) => t !== null);
      if (start === 0 || (first !== undefined && first !== null && first < since)) return lines.filter(Boolean);
    }
  } finally { closeSync(fd); }
}

/** Card ids in tasks.json; empty when it cannot be read. */
function cardIds(path: string): Set<string> {
  try {
    const tasks = (JSON.parse(readFileSync(path, 'utf8')) as { tasks?: unknown }).tasks;
    return new Set(Array.isArray(tasks) ? tasks.map((t) => (t as { id?: unknown })?.id).filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

/** Write last week's digest if it is not there yet; returns its path, or null when nothing was written. */
export function writeWeeklyDigest(root: string, now: number): string | null {
  const week = isoWeek(now - 7 * DAY);
  const dir = join(root, 'usage');
  try { if (lstatSync(dir).isSymbolicLink()) return null; } catch { mkdirSync(dir, { mode: 0o700 }); }
  const file = join(dir, `digest-${week.label}.md`);
  if (existsSync(file)) return null;
  const usage: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (m && Date.parse(`${m[1]}T00:00:00Z`) >= week.start - DAY && Date.parse(`${m[1]}T00:00:00Z`) < week.end) usage.push(...linesSince(join(dir, name), 0));
  }
  const summary = summarize({
    log: linesSince(join(root, 'log.jsonl'), week.start),
    ledger: linesSince(join(root, 'cost-ledger.jsonl'), week.start - DAY),
    usage, start: week.start, end: week.end, cards: cardIds(join(root, 'tasks.json'))
  });
  writeFileSync(file, renderDigest(summary, week.label), { mode: 0o600, flag: 'wx' });
  return file;
}
