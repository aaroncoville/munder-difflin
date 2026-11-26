/**
 * The weekly usage digest (docs/usage-log.md): one markdown file per ISO week at
 * <userData>/usage/digest-YYYY-Www.md, in the app's own data folder, built from
 * the hive's log and cost ledger (read only) and the owner-side usage files. No
 * LLM and no network; it holds ids, counts and durations only, like the logs it
 * summarizes. The daily research pass reads it instead of the raw files.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_STATUSES } from './usageEvents';
import { VIEWS, deletedAt } from './usageLog';

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
/** A duration: finite and not negative, else not used. */
const dur = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? n : null; };
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
// The hive's log and tasks.json are files agents can write, so nothing in
// them is printed because it looks like an id. A printed string must be a known
// value (trigger, status, shape, view, lock kind, canary feature or code), a
// card in the current tasks.json, or a keyed ref.
const ID = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const ASK_KEY = /^(.+)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
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
/** Error codes a canary probe can report (Node errno names). */
const ERRNO_CODES = [
  'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EACCES', 'EPERM', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ENOTSOCK', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENOTFOUND', 'EAI_AGAIN'
];
const CANARY_CODES = [
  'off', 'not-probed-spawn', 'not-probed-remote', 'not-probed-switching', 'not-loopback', 'no-hits', 'redirect', 'error', 'closed',
  'timeout', 'bad-reply', 'other-instance', 'wrong-pong', 'threw', 'no-root', 'not-found'
];
/** A canary's failure code: a known code, an HTTP refusal or a known errno name; anything else is 'other'. */
const canaryCode = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  return CANARY_CODES.includes(v) || ERRNO_CODES.includes(v) || /^refused-[1-5]\d{2}$/.test(v) ? v : 'other';
};
/** How many never-seen asks the digest lists by key. */
const NEVER_SEEN_LISTED = 50;
const cents = (x: number): number => Math.round(x * 100) / 100;
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * `cards`: the card ids in the current tasks.json; only those that are also id
 * tokens are printed. `ownerData`: whether any owner-side day file covers the
 * week (default: whether `usage` has rows); without it the owner-side sections
 * say "no data" rather than report empty facts. `seenLater`: owner-side rows
 * after the week, read only to tell whether an ask was seen at all.
 */
export interface DigestInput {
  log: string[]; ledger: string[]; usage: string[]; start: number; end: number;
  cards?: ReadonlySet<string>; ownerData?: boolean; seenLater?: string[];
}

export function summarize(i: DigestInput) {
  const cardSet = i.cards ?? new Set<string>();
  /** A card id the digest may print: an id token that tasks.json holds. */
  const isCard = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && cardSet.has(v);
  const askKey = (v: unknown): string | null => {
    const m = typeof v === 'string' ? ASK_KEY.exec(v) : null;
    if (!m || !isCard(m[1])) return null;
    const t = Date.parse(m[2]);
    return Number.isFinite(t) && new Date(t).toISOString() === m[2] ? (v as string) : null;
  };
  /** A turn's conversation group: its card (when in tasks.json) or its keyed
   *  ref. A conversation value itself is never printed. */
  const conversation = (r: Row): string | null => {
    if (isCard(r.cardId)) return r.cardId;
    return typeof r.conversationRef === 'string' && REF.test(r.conversationRef) ? `ref:${r.conversationRef}` : null;
  };
  const inWeek = (r: Row): boolean => { const t = num(r.ts); return t !== null && t >= i.start && t < i.end; };
  const log = parse(i.log).filter(inWeek);
  const usage = parse(i.usage).filter(inWeek);
  const ownerData = i.ownerData ?? usage.length > 0;

  // Positive cost increments per agent (the ledger's usd is cumulative per session).
  const prev = new Map<string, number>();
  const incs = new Map<string, Array<[number, number]>>();
  for (const r of parse(i.ledger)) {
    const agent = str(r.agent_id); const ts = num(r.ts); const usd = num(r.usd) ?? 0;
    if (!agent || ts === null) continue;
    const key = `${agent}\u0000${String(r.session_id)}`;
    const p = prev.get(key);
    prev.set(key, usd);
    // A session's first sample is all it has spent so far; after that, the rise
    // since the previous sample (a drop means the counter restarted).
    const inc = p === undefined ? usd : usd >= p ? usd - p : usd;
    if (inc > 0) (incs.get(agent) ?? incs.set(agent, []).get(agent)!).push([ts, inc]);
  }
  const usdIn = (agent: string, from: number, to: number): number =>
    (incs.get(agent) ?? []).reduce((s, [t, x]) => (t >= from && t <= to ? s + x : s), 0);

  const turnsByTrigger: Record<string, { turns: number; usd: number }> = {};
  // Keyed by card ids and refs, so a Map: a card named `constructor` is just a key.
  const usdByConversation = new Map<string, number>();
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
      if (conv) usdByConversation.set(conv, (usdByConversation.get(conv) ?? 0) + usd);
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
      // Counted by the same rule as filed asks: a valid key on a card tasks.json holds.
      if (!askKey(r.askKey)) continue;
      answered++;
      const s = shape(r.answerShape); if (s) shapes[s] = (shapes[s] ?? 0) + 1;
    }
  }
  for (const t of Object.values(turnsByTrigger)) t.usd = cents(t.usd);
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
  const views = new Map<string, { view: string; opens: number; dwellMs: number; unclosed: number }>();
  // Views opened and not yet ended, per app run and window. Whatever is left at
  // the end was still open when the app quit or the window closed: its dwell is
  // unknown, so it is counted apart rather than as zero.
  const openViews = new Map<string, number>();
  const runKey = (r: Row, v: string): string => `${typeof r.session === 'string' ? r.session : ''}\u0000${num(r.win) ?? ''}\u0000${v}`;
  for (const r of parse(i.seenLater ?? [])) if (r.kind === 'ask-shown') { const k = askKey(r.askKey); if (k) seen.add(k); }
  for (const r of usage) {
    if (r.kind === 'ask-shown') { const k = askKey(r.askKey); if (k) seen.add(k); const a = dur(r.ageMs); if (a !== null) unseen.push(a); }
    else if (r.kind === 'ask-submitted') { const m = dur(r.msSinceShown); if (m !== null) thinking.push(m); }
    else if (r.kind === 'ui-view' || r.kind === 'ui-view-end') {
      const v = view(r.view); if (!v) continue;
      const e = views.get(v) ?? views.set(v, { view: v, opens: 0, dwellMs: 0, unclosed: 0 }).get(v)!;
      const key = runKey(r, v);
      if (r.kind === 'ui-view') { e.opens++; openViews.set(key, (openViews.get(key) ?? 0) + 1); }
      else {
        e.dwellMs += dur(r.dwellMs) ?? 0;
        const n = openViews.get(key) ?? 0;
        if (n > 1) openViews.set(key, n - 1); else openViews.delete(key);
      }
    }
  }
  const unclosedOf = (view: string): number =>
    [...openViews].reduce((n, [k, c]) => (k.endsWith(`\u0000${view}`) ? n + c : n), 0);
  const canaryFailures: Record<string, { failed: number; runs: number; details: string[] }> = {};
  for (const [f, c] of Object.entries(canaries)) if (c.failed) canaryFailures[f] = { failed: c.failed, runs: c.runs, details: [...c.details].sort() };

  return {
    turnsByTrigger, stateHours, lockWaits, canaryFailures, ownerData,
    usdByConversation: Object.fromEntries([...usdByConversation].map(([k, v]) => [k, cents(v)])),
    canaryFeatures: Object.keys(canaries).sort(),
    views: [...views.values()].map((v) => ({ ...v, unclosed: unclosedOf(v.view) })).sort((a, b) => b.dwellMs - a.dwellMs || b.opens - a.opens),
    asks: {
      filed: filed.length, answered, shapes,
      unseenMedianMs: quantile(unseen, 0.5), unseenP90Ms: quantile(unseen, 0.9),
      thinkingMedianMs: quantile(thinking, 0.5), thinkingP90Ms: quantile(thinking, 0.9),
      neverSeen: ownerData ? filed.filter((k) => !seen.has(k)).sort() : []
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
  );
  if (s.ownerData) {
    const listed = s.asks.neverSeen.slice(0, NEVER_SEEN_LISTED).map((k) => `\`${k}\``).join(', ');
    const more = s.asks.neverSeen.length - NEVER_SEEN_LISTED;
    out.push(
      `- Time unseen (asked to first seen): median ${mins(s.asks.unseenMedianMs)}, p90 ${mins(s.asks.unseenP90Ms)}.`,
      `- Time thinking (seen to answered): median ${mins(s.asks.thinkingMedianMs)}, p90 ${mins(s.asks.thinkingP90Ms)}.`,
      `- Filed this week and never seen on the Ask Me board by the time this was written: ${listed || 'none'}${more > 0 ? `, and ${more} more` : ''}.`);
    out.push('', '## Screens by attended time', '', 'Views still open at the end of the week or when the app quit have unknown dwell and are not in the minutes.', '',
      '| view | opens | minutes | still open (week end or quit) |', '|---|---|---|---|');
    for (const v of s.views) out.push(`| ${v.view} | ${v.opens} | ${Math.round(v.dwellMs / 60_000)} | ${v.unclosed} |`);
  } else {
    out.push('', '## Screens and ask attention', '', 'No owner-side data for this week (the usage log was off, or its files were deleted).');
  }
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

/**
 * Cost-ledger lines for a week starting at `since`. The ledger is not in time
 * order (an idle agent's unchanged row is re-appended with its old ts), so it is
 * read forward in full, in chunks: each session's last row before `since` (its
 * baseline) and every row at or after `since`, in file order. Rows older than
 * `since` that come after a session's in-week rows are stale repeats and are
 * dropped. Cost grows with the ledger; this runs once a week.
 */
function ledgerSince(path: string, since: number): string[] {
  if (!existsSync(path)) return [];
  const baseline = new Map<string, string>();
  const inWeekSessions = new Set<string>();
  const out: string[] = [];
  const take = (line: string): void => {
    if (!line) return;
    let r: Row;
    try { r = JSON.parse(line) as Row; } catch { return; }
    const ts = num(r?.ts);
    if (ts === null) return;
    const key = `${String(r.agent_id)}\u0000${String(r.session_id)}`;
    if (ts >= since) { inWeekSessions.add(key); out.push(line); }
    else if (!inWeekSessions.has(key)) baseline.set(key, line);
  };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4 << 20);
    let rest = '';
    for (let pos = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const lines = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) take(l);
    }
    take(rest);
  } finally { closeSync(fd); }
  return [...baseline.values(), ...out];
}

/** Card ids in tasks.json; empty when it cannot be read. */
function cardIds(path: string): Set<string> {
  try {
    const tasks = (JSON.parse(readFileSync(path, 'utf8')) as { tasks?: unknown }).tasks;
    return new Set(Array.isArray(tasks) ? tasks.map((t) => (t as { id?: unknown })?.id).filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

/**
 * Write last week's digest if it is not there yet; returns its path, or null
 * when nothing was written. The hive (`root`) is only read: its log, ledger and
 * tasks.json. The owner's usage files are read from, and the digest written to,
 * `dir`, the usage folder in the app's own data folder.
 */
export function writeWeeklyDigest(root: string, dir: string, now: number): string | null {
  const week = isoWeek(now - 7 * DAY);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `digest-${week.label}.md`);
  if (existsSync(file)) return null;
  // The owner deleted the log after this week began: leave it deleted.
  const deleted = deletedAt(dir);
  if (deleted !== null && week.start < deleted) return null;
  const usage: string[] = [];
  const seenLater: string[] = [];
  let ownerData = false;
  for (const name of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    const day = Date.parse(`${m[1]}T00:00:00Z`);
    if (day >= week.start && day < week.end) ownerData = true;
    if (day >= week.start - DAY && day < week.end) usage.push(...linesSince(join(dir, name), 0));
    else if (day >= week.end) seenLater.push(...linesSince(join(dir, name), 0));
  }
  const summary = summarize({
    log: linesSince(join(root, 'log.jsonl'), week.start),
    ledger: ledgerSince(join(root, 'cost-ledger.jsonl'), week.start - DAY),
    usage, seenLater, ownerData, start: week.start, end: week.end, cards: cardIds(join(root, 'tasks.json'))
  });
  writeFileSync(file, renderDigest(summary, week.label), { mode: 0o600, flag: 'wx' });
  return file;
}
