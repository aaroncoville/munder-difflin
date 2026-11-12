/**
 * A machine-wide limit on heavy jobs (installs, builds, full test suites, benchmarks) enforced at
 * the PreToolUse boundary. Several agents starting these at once can make the machine unresponsive,
 * and a prose rule asking them to take turns does not hold.
 *
 *  - classifyHeavy: a pure, table-driven classifier of a tool call's command (no model). It will be
 *    wrong in both directions now and then. That is acceptable: this is a courtesy against overload,
 *    not a security boundary.
 *  - HeavyJobLock: a counting semaphore of `limit` slots, held per agent. A slot is freed by the
 *    call's PostToolUse, by the end of the agent's turn, by the job's processes exiting, by the
 *    agent's PTY exiting, or by a TTL.
 *  - A refused agent joins a first-in, first-out queue. A freed slot is reserved for the oldest live
 *    waiter for a few minutes and the waiter is told, so that agents do not write pollers.
 *
 * No Electron dependency: every piece is injectable, so tests never inspect the real machine.
 *
 * The classifier and the lock are adapted from Agent Stage (https://github.com/jdell64/agent-stage,
 * MIT, Copyright (c) 2026 Richard J Tindell II), which ported them from guppyos (MIT).
 */
import { execFile } from 'node:child_process';
import { carriesCommand, classifyGradle, classifyMaven, classifyPackageExtras, classifyPlaywright, classifyWorker, E2E_SCRIPT, RUN_PREFIXES, unwrapGroup } from './heavyJobRules';

export type HeavyKind = 'install' | 'build' | 'suite' | 'bench';
export interface HeavyClass { heavy: boolean; kind?: HeavyKind; why?: string }

/** The command in a tool call's input, in the shapes the providers send it. */
export function commandFromToolInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const v = r.command ?? r.cmd ?? r.script;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ');
  return typeof v === 'string' ? v : null;
}

/** Split a command line into words, honouring simple quotes (not a full shell parser). */
function words(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The segments a shell would run: split on ; && || | and newlines, outside quotes. */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = ''; let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] !== '&' && cmd[i - 1] !== '&') { cur += ' &'; out.push(cur); cur = ''; continue; } // a lone & = background
      out.push(cur); cur = '';
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash.exe']);
const BENCH_SCRIPT = /(mutant|mutation|replay|bench|backfill|parity|speed|stress|soak)[^\\/]*\.(c?m?js|ts)$/i;
export const SUITE_MANY_FILES = 20;
/** node flags that take their value as the next argument (so that value is not a test file). */
const NODE_VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-shard', '--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type']);

const VITEST_VALUE_FLAGS = new Set(['--config', '-c', '--dir', '--root', '-r', '--project', '--reporter', '--mode', '--outputFile', '--testNamePattern', '-t']);
const MAKE_VALUE_FLAGS = new Set(['-C', '-f', '-o', '-W', '-I']);
const BUILD_SCRIPT = /^(build|compile|dist|package)([-_.][^/]*)?\.(sh|bash)$/i;
const SUITE_SCRIPT = /^((run[-_.])?tests?|ci|verify|check)([-_.][^/]*)?\.(sh|bash)$/i;

function classifyScript(file: string): HeavyClass | null {
  const name = file.replace(/\\/g, '/').split('/').pop()!;
  if (BUILD_SCRIPT.test(name)) return { heavy: true, kind: 'build', why: name };
  if (SUITE_SCRIPT.test(name)) return { heavy: true, kind: 'suite', why: name };
  if (E2E_SCRIPT.test(name)) return { heavy: true, kind: 'suite', why: name };
  return null;
}

/** Positional arguments, leaving out the values of the flags in `valueFlags`. */
function positionals(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) { if (valueFlags.has(args[i])) i++; continue; }
    out.push(args[i]);
  }
  return out;
}

function classifyMake(args: string[]): HeavyClass {
  const targets = positionals(args, MAKE_VALUE_FLAGS).filter((a) => !a.includes('=') && !/^\d+$/.test(a));
  if (targets.some((t) => t === 'test' || t === 'tests' || t === 'check')) return { heavy: true, kind: 'suite', why: 'make test' };
  if (!targets.length || targets.some((t) => t === 'all' || t === 'build' || t === 'dist' || t === 'release')) return { heavy: true, kind: 'build', why: 'make' };
  return { heavy: false };
}

function classifyCargo(args: string[]): HeavyClass {
  if (args.includes('--help') || args.includes('-h')) return { heavy: false };
  const sub = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
  if (sub === 'build' || sub === 'b' || sub === 'check' || sub === 'c' || sub === 'clippy' || sub === 'run' || sub === 'r') return { heavy: true, kind: 'build', why: `cargo ${sub}` };
  if (sub === 'test' || sub === 't') return { heavy: true, kind: 'suite', why: 'cargo test' };
  if (sub === 'bench') return { heavy: true, kind: 'bench', why: 'cargo bench' };
  if (sub === 'install') return { heavy: true, kind: 'install', why: 'cargo install' };
  return { heavy: false };
}

/** Strip the prefixes that do not change what runs: VAR=x, env [-u X]..., timeout N, nice, cd x. */
function leading(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (w === 'env') { i++; while (i < ws.length && (ws[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]))) { if (ws[i] === '-u') i++; i++; } continue; }
    if (w === 'timeout' || w === 'nice') { i++; while (i < ws.length && (/^-/.test(ws[i]) || /^\d+[smhd]?$/.test(ws[i]))) i++; continue; }
    if (RUN_PREFIXES.has(w)) { i++; while (i < ws.length && (/^-/.test(ws[i]) || /^\d+$/.test(ws[i]))) i++; continue; }
    if (w === 'cd' || w === 'pushd') return []; // `cd x` alone is its own segment
    break;
  }
  return ws.slice(i);
}

/** dotnet's heavy subcommands. A filtered or listing test run mirrors the single-test-file rule,
 *  and --no-build skips the compile that makes `dotnet run` heavy. Anything after a bare `--` is
 *  the program's, not dotnet's, so it cannot make a run light. */
function classifyDotnet(args: string[]): HeavyClass {
  const sep = args.indexOf('--');
  const own = sep >= 0 ? args.slice(0, sep) : args;
  if (own.some((a) => a === '--help' || a === '-h' || a === '-?')) return { heavy: false };
  const sub = own.find((a) => !a.startsWith('-'));
  if (sub === 'restore') return { heavy: true, kind: 'install', why: 'dotnet restore' };
  if (sub === 'build' || sub === 'publish' || sub === 'pack') return { heavy: true, kind: 'build', why: `dotnet ${sub}` };
  if (sub === 'run') return own.includes('--no-build') ? { heavy: false } : { heavy: true, kind: 'build', why: 'dotnet run' };
  if (sub === 'test') {
    const narrow = own.some((a) => /^--filter([:=]|$)/.test(a) || a === '--list-tests' || a === '-t');
    return narrow ? { heavy: false } : { heavy: true, kind: 'suite', why: 'dotnet test' };
  }
  return { heavy: false };
}

function classifyWords(ws0: string[], depth: number): HeavyClass {
  ws0 = unwrapGroup(ws0);
  const ws = leading(ws0);
  if (!ws.length) return { heavy: false };
  const bin = ws[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
  const args = ws.slice(1);
  // One level of a shell wrapper: bash -c "...", cmd /c ..., powershell -Command ...
  if (WRAPPERS.has(bin) && depth === 0) {
    // -c also comes bundled with other flags, as in the login shell's -lc.
    const k = args.findIndex((a) => /^(-[a-z]*c|\/\/?c|\/\/?k|-command)$/i.test(a));
    if (k >= 0) return classifyCommand(args.slice(k + 1).join(' '), depth + 1);
    const at = args.findIndex((a) => !a.startsWith('-'));
    return at < 0 || args.slice(0, at).some((a) => /^-[a-z]*n[a-z]*$/.test(a)) ? { heavy: false } : classifyWords(args.slice(at), depth + 1);
  }
  const script = classifyScript(ws[0]);
  if (script) return args.length === 1 && (args[0] === '--help' || args[0] === '-h') ? { heavy: false } : script;
  if (bin === 'make' || bin === 'gmake') return classifyMake(args);
  if (bin === 'cargo') return classifyCargo(args);
  if (bin === 'dotnet') return classifyDotnet(args);
  if (bin === 'gradle' || bin === 'gradlew' || bin === 'gradlew.bat') return classifyGradle(args);
  if (bin === 'mvn' || bin === 'mvnw') return classifyMaven(args);
  if (bin === 'playwright' || bin.startsWith('playwright@')) return classifyPlaywright(args);
  const worker = classifyWorker(bin, args); if (worker) return worker;
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    const extra = classifyPackageExtras(bin, args, (w) => classifyWords(w, depth)); if (extra) return extra;
    const sub = args.find((a) => !a.startsWith('-')) ?? (bin === 'yarn' ? 'install' : '');
    if (sub === 'ci' || sub === 'rebuild') return { heavy: true, kind: 'install', why: `${bin} ${sub}` };
    if (sub === 'install' || sub === 'i' || sub === 'add') return { heavy: true, kind: 'install', why: `${bin} ${sub}` };
    if (sub === 'test' || sub === 't') return { heavy: true, kind: 'suite', why: `${bin} test` };
    if (sub === 'run' || sub === 'run-script') {
      const script = args.slice(args.indexOf(sub) + 1).find((a) => !a.startsWith('-')) ?? '';
      if (/^(build|dist)(:.*)?$/.test(script)) return { heavy: true, kind: 'build', why: `${bin} run ${script}` };
      if (/^test(:.*)?$/.test(script)) return { heavy: true, kind: 'suite', why: `${bin} run ${script}` };
    }
    // yarn and pnpm run a package script by its bare name.
    if (bin !== 'npm' && /^(build|dist)(:.*)?$/.test(sub)) return { heavy: true, kind: 'build', why: `${bin} ${sub}` };
    if (bin !== 'npm' && /^test(:.*)?$/.test(sub)) return { heavy: true, kind: 'suite', why: `${bin} ${sub}` };
    return { heavy: false };
  }
  if (bin === 'bunx') { const at = args.findIndex((a) => !a.startsWith('-')); return at < 0 ? { heavy: false } : classifyWords(args.slice(at), depth); }
  if (bin === 'npx') { const at = args.findIndex((a) => !a.startsWith('-')); return at < 0 ? { heavy: false } : classifyWords(args.slice(at), depth); }
  if (bin === 'electron-rebuild' || bin === 'node-gyp') return { heavy: true, kind: 'install', why: bin };
  if (bin === 'electron-builder') return { heavy: true, kind: 'build', why: bin };
  if (bin === 'electron-vite' && args.includes('build')) return { heavy: true, kind: 'build', why: 'electron-vite build' };
  if (bin === 'vitest') {
    const files = positionals(args, VITEST_VALUE_FLAGS).filter((a) => a !== 'run');
    return files.length ? { heavy: false } : { heavy: true, kind: 'suite', why: 'vitest (all)' };
  }
  if (bin === 'node' || bin === 'electron') {
    if (args.includes('--test')) {
      // Positional args only: the value of a flag that takes one is not a test file.
      const files: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
        files.push(a);
      }
      if (!files.length) return { heavy: true, kind: 'suite', why: 'node --test (all)' };
      if (files.some((f) => /[*?]/.test(f) || !/\.[cm]?[jt]s$/.test(f))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };
      if (files.length >= SUITE_MANY_FILES) return { heavy: true, kind: 'suite', why: `node --test (${files.length} files)` };
      return { heavy: false };
    }
    const script = args.find((a) => !a.startsWith('-'));
    if (script && BENCH_SCRIPT.test(script)) return { heavy: true, kind: 'bench', why: `node ${script.replace(/\\/g, '/').split('/').pop()}` };
    return { heavy: false };
  }
  return { heavy: false };
}

/** Classify a command line: heavy if any segment it runs is heavy. */
export function classifyCommand(cmd: string, depth = 0): HeavyClass {
  // A heredoc body is text, not commands, however much it looks like them.
  const text = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '');
  for (const seg of segments(text)) {
    const c = classifyWords(words(seg.replace(/\s&$/, '')), depth);
    if (c.heavy) return c;
  }
  // $(...) and backticks run outside single quotes, wherever they sit in the line.
  for (const m of text.replace(/'[^']*'/g, "''").matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const c = classifyCommand(m[1] ?? m[2], depth);
    if (c.heavy) return c;
  }
  return { heavy: false };
}

/** Classify a tool call (any provider: the command-shaped input only). */
export function classifyHeavy(_toolName: string | undefined, input: unknown): HeavyClass {
  const cmd = commandFromToolInput(input);
  return cmd ? classifyCommand(cmd) : { heavy: false };
}

/** Does this tool call leave the job running after the call returns? */
export function isBackground(input: unknown): boolean {
  if (input && typeof input === 'object' && (input as Record<string, unknown>).run_in_background === true) return true;
  const cmd = commandFromToolInput(input) ?? '';
  return /(^|[^&])&\s*$/.test(cmd.trim()) || /\bnohup\b|\bStart-Job\b|\bsetsid\b/.test(cmd);
}

// — the lock —

export type HeavyLimit = number | 'off';
export const HEAVY_DEFAULT_LIMIT = 2;
/** The config value: exactly 'off' or an integer 1..16. Anything else gets the default, so a
 *  mistyped value cannot quietly switch the lock off or change its size. */
export function heavyLimit(v: unknown): HeavyLimit {
  if (v === 'off') return 'off';
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 16 ? v : HEAVY_DEFAULT_LIMIT;
}

/** One heavy tool call. Each call is its own job with its own slot, even when an agent repeats a
 *  command, because a process listing could not otherwise say which of the two has ended. */
export interface HeavyCall {
  key: number;
  agentId: string;
  /** The provider's id for the call, or the command when it sends none, so it need not be unique. */
  callId: string;
  kind: HeavyKind;
  /** The classifier's label. Shown to other agents and logged, unlike the command itself, which
   *  can carry secrets (`TOKEN=x npm test`). */
  label: string;
  /** The raw command, kept in memory only, to recognise the job in a process listing. */
  command: string;
  why?: string;
  /** The provider session that made the call, for providers that run several under one PTY. */
  session?: string;
  since: number;
  /** Last acquire or sighting in a process listing: the TTL runs from here. */
  touched: number;
  /** A backgrounded job: its PostToolUse says nothing about whether it has finished. */
  background: boolean;
  /** Its PostToolUse arrived, or its turn ended, so it is past any permission prompt. */
  posted: boolean;
  /** Seen in a process listing. Until then, and until `posted`, it may be at a permission prompt. */
  seen: boolean;
  /** The process at the top of this call's tree. No other call can claim it or anything under it. */
  pid?: number;
  /** Consecutive watcher scans that found no job for this call. */
  misses: number;
}

export interface ProcRow { pid: number; parentPid: number; commandLine: string }
export interface HeavyLockDeps {
  limit: () => HeavyLimit;
  /** How many of the held and reserved slots may be test suites. Absent = no limit beyond `limit`. */
  suiteLimit?: () => HeavyLimit;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** The PTY root pid of each agent. */
  roots?: () => Array<{ agentId: string; pid: number }>;
  /** A process listing (only ever called while a slot is held). */
  probe?: () => Promise<ProcRow[]>;
  log?: (row: Record<string, unknown>) => void;
  /** Whether a queued agent still has a PTY. Absent = assume so. */
  alive?: (agentId: string) => boolean;
  /** Tell a queued agent that a slot is reserved for it until `until`. Returns whether any channel
   *  took the message. */
  notify?: (agentId: string, kind: HeavyKind, until: number) => boolean;
}

export const HEAVY_TTL_MS = 60 * 60_000;
export const HEAVY_SCAN_MS = 20_000;
export const HEAVY_SCAN_MISSES = 2;
export const HEAVY_RESERVE_MS = 5 * 60_000;
const COMMAND_KEEP = 200;

export type HeavyDecision = { allow: true; acquired: boolean } | { allow: false; reason: string };
type ReleaseReason = 'posttool' | 'turn-end' | 'process-exit' | 'pty-exit' | 'ttl';
const clock = (ms: number): string => `${new Date(ms).toISOString().slice(11, 19)}Z`;

export class HeavyJobLock {
  private readonly calls = new Map<number, HeavyCall>();
  private nextKey = 1;
  private readonly queue: Array<{ agentId: string; kind: HeavyKind; since: number }> = [];
  private readonly reservations = new Map<string, { kind: HeavyKind; until: number; queuedSince?: number }>();
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: HeavyLockDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** The calls holding slots, oldest first. Expired ones are released first. */
  snapshot(): Array<{ agentId: string; kind: HeavyKind; job: string; since: string; background: boolean; started: boolean }> {
    this.expire();
    return [...this.calls.values()].map((c) => ({ agentId: c.agentId, kind: c.kind, job: c.label, since: new Date(c.since).toISOString(), background: c.background, started: c.seen || c.posted }));
  }

  /** Who is waiting, and which slots are set aside for whom. */
  queueSnapshot(): { waiting: Array<{ agentId: string; kind: HeavyKind; since: string }>; reservations: Array<{ agentId: string; kind: HeavyKind; until: string }> } {
    return {
      waiting: this.queue.map((w) => ({ agentId: w.agentId, kind: w.kind, since: new Date(w.since).toISOString() })),
      reservations: [...this.reservations].map(([agentId, r]) => ({ agentId, kind: r.kind, until: new Date(r.until).toISOString() }))
    };
  }

  /** The whole picture, for fleet.json. */
  status(): { limit: HeavyLimit; holders: ReturnType<HeavyJobLock['snapshot']> } & ReturnType<HeavyJobLock['queueSnapshot']> {
    const holders = this.snapshot();
    return { limit: this.d.limit(), holders, ...this.queueSnapshot() };
  }

  /** PreToolUse: a heavy call from `agentId`. Take a slot, or queue it. */
  acquire(agentId: string, cls: HeavyClass, command: string, callId: string, background: boolean, session?: string): HeavyDecision {
    const limit = this.d.limit();
    if (limit === 'off' || !cls.heavy || !cls.kind) {
      if (limit === 'off') this.dropWaiting(agentId);
      return { allow: true, acquired: false };
    }
    this.expire();
    this.serve(); // a raised limit serves the queue before anyone new
    if (cls.kind === 'suite' && this.reservations.get(agentId)?.kind !== 'suite' && !this.suiteRoom()) return this.refuse(agentId, cls, limit, true);
    const reservation = this.reservations.get(agentId);
    const reserved = this.reservations.delete(agentId);
    if (!reserved && this.calls.size + this.reservations.size >= limit) return this.refuse(agentId, cls, limit);
    const now = this.now();
    const key = this.nextKey++;
    this.calls.set(key, { key, agentId, callId, kind: cls.kind, label: cls.why ?? cls.kind, command: command.slice(0, COMMAND_KEEP), why: cls.why, session, since: now, touched: now, background, posted: false, seen: false, misses: 0 });
    // How long the agent queued for this slot, for the usage log (measure only).
    const waitMs = reserved && reservation?.queuedSince !== undefined ? now - reservation.queuedSince : undefined;
    this.log({ kind: 'heavy-lock', action: 'acquire', agentId, heavyKind: cls.kind, job: cls.why, background, limit, reserved, ...(waitMs !== undefined ? { waitMs } : {}) });
    this.arm();
    return { allow: true, acquired: true };
  }

  /** Room for one more suite: suites held plus suite reservations stay under the suite limit. */
  private suiteRoom(): boolean {
    const cap = this.d.suiteLimit?.() ?? 'off';
    if (cap === 'off') return true;
    const held = [...this.calls.values()].filter((c) => c.kind === 'suite').length;
    return held + [...this.reservations.values()].filter((r) => r.kind === 'suite').length < cap;
  }

  private refuse(agentId: string, cls: HeavyClass, limit: number, suites = false): HeavyDecision {
    let at = this.queue.findIndex((w) => w.agentId === agentId);
    if (at < 0) at = this.queue.push({ agentId, kind: cls.kind!, since: this.now() }) - 1;
    else this.queue[at].kind = cls.kind!; // it waits for what it asked for last, not what it first asked for
    // A slot set aside for another kind of job would sit unused while this agent waits for a suite.
    if (suites && this.reservations.delete(agentId)) { this.log({ kind: 'heavy-lock', action: 'reserve-dropped', agentId }); this.serve(); }
    const holders = [...this.calls.values()].filter((h) => !suites || h.kind === 'suite');
    const reserved = [...this.reservations].filter(([, r]) => !suites || r.kind === 'suite').map(([id]) => id);
    const taken: string[] = [];
    if (holders.length) taken.push(`held by ${holders.map((h) => `${h.agentId} (${h.kind}: ${h.label}, since ${clock(h.since)})`).join('; ')}`);
    if (reserved.length) taken.push(`reserved for ${reserved.join(', ')}`);
    const one = holders.length + reserved.length === 1;
    const cap = suites ? this.d.suiteLimit?.() : limit;
    const allows = suites ? `${cap} test suite${cap === 1 ? '' : 's'} at a time` : `${limit} heavy job${limit === 1 ? '' : 's'} at once`;
    const reason = `Denied by the heavy-job lock: this machine allows ${allows} and ${one ? 'it is' : 'they are'} ${taken.join(' and ')}. `
      + `You are queued (position ${at + 1}): when a slot frees it is reserved for you for ${Math.round(HEAVY_RESERVE_MS / 60_000)} minutes and you will get a message saying so. `
      + 'Do not retry or poll in the meantime; carry on with light work (single test files, reads and edits are not limited) until you are told.';
    this.log({ kind: 'heavy-lock', action: 'deny', agentId, heavyKind: cls.kind, position: at + 1, holders: holders.map((h) => h.agentId), limit, ...(suites ? { suiteLimit: cap } : {}) });
    return { allow: false, reason };
  }

  private callsOf(agentId: string): HeavyCall[] {
    return [...this.calls.values()].filter((c) => c.agentId === agentId);
  }

  /** PostToolUse of a heavy call. Calls that share an id share a command, and scans bind the oldest
   *  first, so the oldest is the one that can be running. */
  callDone(agentId: string, callId: string): void {
    const call = this.callsOf(agentId).find((c) => c.callId === callId && !c.posted);
    if (!call) return;
    if (call.background) call.posted = true;
    else this.release(call.key, 'posttool');
  }

  /** The agent's turn ended, so no foreground call of its can still be running. This catches the
   *  calls that never get a PostToolUse: one the user rejected at the permission prompt (which
   *  comes after PreToolUse) and one that was interrupted. With `session`, only that provider
   *  session's turn ended, and the agent's other sessions may still be running calls. */
  turnOver(agentId: string, session?: string): void {
    for (const c of this.callsOf(agentId)) {
      if (session !== undefined && c.session !== session) continue;
      if (c.background) c.posted = true;
      else this.release(c.key, 'turn-end');
    }
  }

  /** The agent's PTY exited: its jobs are gone with it, and it is no longer waiting. */
  agentGone(agentId: string): void {
    this.dropWaiting(agentId);
    for (const c of this.callsOf(agentId)) this.release(c.key, 'pty-exit');
    this.serve();
  }

  /** Several PTYs are closing together (quit, reset, change of home), which skips their exit
   *  callbacks. Every waiter among them is dropped first, so no agent that is itself going away
   *  gets told that a slot just freed up. */
  agentsGone(agentIds: Iterable<string>): void {
    const ids = new Set(agentIds);
    for (const id of ids) this.dropWaiting(id);
    for (const id of ids) this.agentGone(id);
  }

  private dropWaiting(agentId: string): void {
    const at = this.queue.findIndex((w) => w.agentId === agentId);
    if (at >= 0) { this.queue.splice(at, 1); this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId }); }
    if (this.reservations.delete(agentId)) this.log({ kind: 'heavy-lock', action: 'reserve-dropped', agentId });
  }

  private release(key: number, reason: ReleaseReason): void {
    const c = this.calls.get(key);
    if (!c) return;
    this.calls.delete(key);
    this.log({ kind: 'heavy-lock', action: 'release', agentId: c.agentId, heavyKind: c.kind, reason, heldMs: this.now() - c.since });
    this.serve();
    if (!this.calls.size && !this.reservations.size && this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }

  /** Hand free slots to the oldest live waiters. */
  private serve(): void {
    const limit = this.d.limit();
    while (this.queue.length && (limit === 'off' || this.calls.size + this.reservations.size < limit)) {
      // The oldest waiter that can run: a suite waits while the suites are full, without holding up the rest.
      const next = this.queue.findIndex((q) => q.kind !== 'suite' || this.suiteRoom());
      if (next < 0) break;
      const w = this.queue.splice(next, 1)[0];
      if (this.d.alive && !this.d.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId }); continue; }
      const until = this.now() + HEAVY_RESERVE_MS;
      // Told first: a reservation for an agent that will never hear of it would just strand the slot.
      let told = true;
      try { if (this.d.notify) told = this.d.notify(w.agentId, w.kind, until) !== false; } catch { told = false; }
      if (!told) { this.log({ kind: 'heavy-lock', action: 'notice-failed', agentId: w.agentId, heavyKind: w.kind }); continue; }
      this.reservations.set(w.agentId, { kind: w.kind, until, queuedSince: w.since });
      this.log({ kind: 'heavy-lock', action: 'reserve', agentId: w.agentId, heavyKind: w.kind, until });
      this.arm();
    }
  }

  private expire(): void {
    const t = this.now();
    for (const c of [...this.calls.values()]) if (t - c.touched >= HEAVY_TTL_MS) this.release(c.key, 'ttl');
    for (const [agentId, r] of [...this.reservations]) {
      if (t < r.until) continue;
      this.reservations.delete(agentId);
      this.log({ kind: 'heavy-lock', action: 'reserve-expired', agentId, heavyKind: r.kind });
    }
    this.serve();
  }

  /** The watcher runs only while a slot is held or reserved. */
  private arm(): void {
    if (this.timer || (!this.calls.size && !this.reservations.size)) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.scan().finally(() => this.arm()); }, HEAVY_SCAN_MS);
  }

  /** One watcher tick: expiry for everyone, and a process check for calls that may not get a
   *  PostToolUse. Each call claims one process tree: the topmost process under the agent's PTY that
   *  carries its command or classifies with its label, since the shell wrapper keeps the command's
   *  text even when the process doing the work looks like `node x/y.mjs`. A claimed tree is evidence
   *  for that call alone, so one running `npm test` cannot vouch for a second one. The PTY root is
   *  left out: its arguments can quote a command without running it. A failed probe is no evidence
   *  either way, and a process id reused while its call is still held would read as still running.
   *
   *  No listing can free a call that has never been seen running: it may be waiting at a permission
   *  prompt, which comes after PreToolUse and reports nothing, and an approval arriving after its
   *  slot went to someone else would run uncounted. Such a call is freed by its PostToolUse, the
   *  turn ending, the PTY exiting or the TTL. */
  async scan(): Promise<void> {
    this.expire();
    if (!this.calls.size || !this.d.probe || !this.d.roots) return;
    let procs: ProcRow[];
    try { procs = await this.d.probe(); } catch { return; }
    const parent = new Map(procs.map((p) => [p.pid, p.parentPid]));
    const rootOf = new Map(this.d.roots().map((r) => [r.pid, r.agentId]));
    const lineage = (pid: number): number[] => {
      const seen: number[] = []; let cur: number | undefined = parent.get(pid);
      while (cur !== undefined && !seen.includes(cur)) { seen.push(cur); cur = parent.get(cur); }
      return seen;
    };
    const ownerOf = (pid: number): string | null => {
      for (const p of [pid, ...lineage(pid)]) { const a = rootOf.get(p); if (a) return a; }
      return null;
    };
    const under = new Map<string, ProcRow[]>();
    for (const p of procs) {
      if (rootOf.has(p.pid)) continue;
      const a = ownerOf(p.pid);
      if (a) under.set(a, [...(under.get(a) ?? []), p]);
    }
    const listed = new Set(procs.map((p) => p.pid));
    const claimed = new Set<number>();
    for (const c of this.calls.values()) if (c.pid !== undefined && listed.has(c.pid)) claimed.add(c.pid);
    for (const c of [...this.calls.values()]) {
      if (!this.calls.has(c.key)) continue;
      if (c.pid === undefined || !listed.has(c.pid)) {
        c.pid = undefined;
        const matches = (under.get(c.agentId) ?? []).filter((p) => !claimed.has(p.pid) && !lineage(p.pid).some((a) => claimed.has(a))
          && (carriesCommand(p.commandLine, c.command, c.command.length >= COMMAND_KEEP) || (!!c.why && classifyCommand(p.commandLine).why === c.why)));
        const mine = new Set(matches.map((p) => p.pid));
        c.pid = matches.find((p) => !lineage(p.pid).some((a) => mine.has(a)))?.pid;
        if (c.pid !== undefined) claimed.add(c.pid);
      }
      if (c.pid !== undefined) { c.seen = true; c.misses = 0; c.touched = this.now(); continue; }
      if (!c.seen && !c.posted) { c.misses = 0; continue; }
      c.misses++;
      if (c.misses >= HEAVY_SCAN_MISSES) this.release(c.key, 'process-exit');
    }
  }

  private log(row: Record<string, unknown>): void { try { this.d.log?.(row); } catch { /* best effort */ } }
}

// — the hook boundary —

interface HeavyHookPayload { tool_name?: string; tool_input?: unknown; tool_use_id?: unknown; notification_type?: string; tool_session_id?: string }


/** The id that pairs a call's PreToolUse with its PostToolUse: the provider's tool-use id when it
 *  sends one, else the command itself (identical in both hooks). */
function heavyCallId(p: HeavyHookPayload): string {
  if (typeof p.tool_use_id === 'string' && p.tool_use_id) return `id:${p.tool_use_id}`;
  return `cmd:${(commandFromToolInput(p.tool_input) ?? '').slice(0, 500)}`;
}

/** PreToolUse: take a slot for a heavy call. Returns the reason to deny it with, or null to let it
 *  through. Call this only after any gate that can still deny the call: a denied call gets no
 *  PostToolUse, so a slot taken earlier would stay held. */
export function gateHeavyCall(lock: HeavyJobLock, agentId: string, p: HeavyHookPayload): string | null {
  const cls = classifyHeavy(p.tool_name, p.tool_input);
  if (!cls.heavy) return null;
  const d = lock.acquire(agentId, cls, commandFromToolInput(p.tool_input) ?? '', heavyCallId(p), isBackground(p.tool_input), p.tool_session_id);
  return d.allow ? null : d.reason;
}

/** The hook events that end a call: its PostToolUse (a command that exits non-zero fires
 *  PostToolUseFailure instead), or the turn ending or being replaced by a new prompt. */
export function settleHeavyCall(lock: HeavyJobLock, agentId: string, event: string, p: HeavyHookPayload): void {
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') lock.callDone(agentId, heavyCallId(p));
  else if (event === 'Stop' || event === 'UserPromptSubmit') lock.turnOver(agentId, p.tool_session_id);
  else if (event === 'SubagentStop' && p.tool_session_id !== undefined) lock.turnOver(agentId, p.tool_session_id);
  else if (event === 'Notification' && (p.notification_type === 'idle' || p.notification_type === 'idle_prompt')) lock.turnOver(agentId);
}

/** What a queued agent is told when its slot comes free. */
export function heavySlotNotice(kind: HeavyKind, until: number): { subject: string; body: string } {
  const at = `${new Date(until).toISOString().slice(11, 16)}Z`;
  return {
    subject: `Heavy-job slot free: the ${kind} you were refused can run now, reserved for you until ${at}`,
    body: `A heavy-job slot is reserved for you until ${at}. Run your ${kind} now if you still need it. If you do not start it by then, the slot passes to the next agent in the queue. No reply is needed.`
  };
}

// — process listing —

/** Parse `ps -axo pid=,ppid=,command=`. */
export function parsePsOutput(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), parentPid: Number(m[2]), commandLine: m[3] });
  }
  return rows;
}

/** The default process listing. Rejects when it cannot read one, which the watcher treats as no
 *  evidence, so a broken listing leaves slots to the TTL rather than freeing them under a live job.
 *  The win32 branch comes with the port and has not been run on this codebase. */
export function probeProcesses(): Promise<ProcRow[]> {
  const options = { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  if (process.platform !== 'win32') {
    return new Promise((resolve, reject) => execFile('ps', ['-axo', 'pid=,ppid=,command='], options, (err, stdout) => {
      if (err) return reject(err);
      const rows = parsePsOutput(stdout);
      if (rows.length) resolve(rows); else reject(new Error('Process probe returned no rows'));
    }));
  }
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options, (err, stdout) => {
    if (err) return reject(err);
    try {
      const rows = JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
      const procs = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && Number.isInteger(r.ProcessId)).map((r) => ({ pid: r.ProcessId, parentPid: r.ParentProcessId, commandLine: r.CommandLine ?? '' }));
      if (procs.length) resolve(procs); else reject(new Error('Process probe returned no rows'));
    } catch (e) { reject(e); }
  }));
}
