/**
 * `hive tasks add|patch|ask`: edits the task ledger (`<hive>/tasks.json`) from a shell.
 *
 * An agent or a service that edits tasks.json with a file-edit tool does so outside the ledger lock, so its
 * write can interleave with the app's and either side's cards can be lost. These commands make the same edits
 * through updateTaskLedgerFile instead: under tasks.json.lock, against the cards on disk at that moment, and
 * replaced by rename. A tasks.json that is not valid JSON is refused, never overwritten. Nothing here commits
 * or runs git: committing the hive stays with the app.
 *
 * runHiveCli takes its arguments, environment and output as parameters and returns the exit status, so it can
 * be run in process; hiveCliMain.ts is the entry that wires it to the real process.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TaskLedgerLockLost, TaskLedgerLockTimeout, updateTaskLedgerFile } from './taskLedgerFile';

export interface HiveCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads a file named on the command line (`--json @path`, `--q-file`). Default: fs, as UTF-8. */
  readFile?: (path: string) => string;
}

export const HIVE_CLI_USAGE = `usage: hive [--hive <dir>] tasks <command> [arguments]

Edits the hive's task ledger, <dir>/tasks.json, under its lock, so the edit
cannot interleave with the app's or another process's. Never commits.

commands:
  hive tasks add --json <card>
      Add <card>, an object with a string "id", unless a card with that id
      exists. Prints "added <id>" or "exists <id>".
  hive tasks patch <id> --json <patch>
      Merge the fields of <patch>, an object, into card <id>. The id is kept.
  hive tasks ask <id> --q-file <path>
      Append the question in file <path> to card <id>'s humanQA list as
      { "q", "askedAt" }, and set the card's status to "blocked".

options:
  --hive <dir>     the hive folder (default: $HIVE_ROOT)
  --json <json>    JSON text, or @<path> to read it from a file; use @path
                   when your shell would mangle the quotes
  --help           this text

environment:
  HIVE_ROOT                   the hive folder, when --hive is not given
  HIVE_TASKS_LOCK_TIMEOUT_MS  how long to wait for the ledger lock (default 5000)

exit status: 0 done; 1 error (unknown card, bad JSON, unreadable ledger);
  2 usage; 75 the ledger lock stayed held by, or was taken over by, another
  process; nothing was written (try again)
`;

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_LOCKED = 75;

class UsageError extends Error {}
class CliError extends Error {}

type Card = Record<string, unknown>;

const VALUE_OPTIONS = new Set(['--hive', '--json', '--q-file']);

interface Parsed { positional: string[]; options: Map<string, string>; help: boolean }

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option ${name}`);
    if (options.has(name)) throw new UsageError(`${name} given twice`);
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length) value = argv[++i];
    if (value === undefined) throw new UsageError(`${name} needs a value`);
    options.set(name, value);
  }
  return { positional, options, help };
}

function isObject(value: unknown): value is Card {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(spec: string, readFile: (path: string) => string, what: string): Card {
  let text = spec;
  if (spec.startsWith('@')) {
    const path = spec.slice(1);
    try { text = readFile(path); } catch (e) { throw new CliError(`cannot read ${what} from ${path}: ${(e as Error).message}`); }
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (e) { throw new CliError(`${what} is not valid JSON: ${(e as Error).message}`); }
  if (!isObject(value)) throw new CliError(`${what} must be a JSON object`);
  return value;
}

function lockWaitMs(env: Record<string, string | undefined>): number | undefined {
  const raw = env.HIVE_TASKS_LOCK_TIMEOUT_MS;
  if (raw === undefined || raw === '') return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) throw new UsageError(`HIVE_TASKS_LOCK_TIMEOUT_MS must be a number of milliseconds, not ${raw}`);
  return ms;
}

const idOf = (card: unknown): unknown => (isObject(card) ? card.id : undefined);

/** Runs `hive <argv…>` and returns its exit status. */
export function runHiveCli(argv: string[], env: Record<string, string | undefined>, io: HiveCliIo): number {
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  try {
    const { positional, options, help } = parse(argv);
    if (help || positional.length === 0) throw new UsageError('');
    const [group, command, ...rest] = positional;
    if (group !== 'tasks') throw new UsageError(`unknown command ${group}`);
    if (!command) throw new UsageError('');

    const want = (...allowed: string[]): void => {
      for (const name of options.keys()) if (name !== '--hive' && !allowed.includes(name)) throw new UsageError(`${name} does not apply to tasks ${command}`);
      for (const name of allowed) if (!options.has(name)) throw new UsageError(`tasks ${command} needs ${name}`);
    };
    const oneId = (): string => {
      if (rest.length !== 1 || !rest[0]) throw new UsageError(`tasks ${command} takes exactly one card id`);
      return rest[0];
    };

    let edit: (cards: unknown[]) => unknown[] | null;
    let report: () => string;
    if (command === 'add') {
      if (rest.length) throw new UsageError('tasks add takes no card id; the id is in the card');
      want('--json');
      const card = jsonObject(options.get('--json')!, readFile, 'the card');
      if (typeof card.id !== 'string' || !card.id) throw new CliError('the card needs a non-empty string "id"');
      const id = card.id;
      let existed = false;
      edit = (cards) => {
        existed = cards.some((c) => idOf(c) === id);
        return existed ? null : [...cards, card];
      };
      report = () => `${existed ? 'exists' : 'added'} ${id}\n`;
    } else if (command === 'patch') {
      const id = oneId();
      want('--json');
      const patch = jsonObject(options.get('--json')!, readFile, 'the patch');
      edit = (cards) => {
        const index = cards.findIndex((c) => idOf(c) === id);
        if (index < 0) throw new CliError(`no card with id ${id} in the ledger`);
        const next = cards.slice();
        next[index] = { ...(cards[index] as Card), ...patch, id };
        return next;
      };
      report = () => `patched ${id}\n`;
    } else if (command === 'ask') {
      const id = oneId();
      want('--q-file');
      const qFile = options.get('--q-file')!;
      let q: string;
      try { q = readFile(qFile).trimEnd(); } catch (e) { throw new CliError(`cannot read the question from ${qFile}: ${(e as Error).message}`); }
      if (!q.trim()) throw new CliError(`the question in ${qFile} is empty`);
      edit = (cards) => {
        const index = cards.findIndex((c) => idOf(c) === id);
        if (index < 0) throw new CliError(`no card with id ${id} in the ledger`);
        const current = cards[index] as Card;
        const past = current.humanQA ?? [];
        if (!Array.isArray(past)) throw new CliError(`card ${id} has a humanQA that is not a list; it was left as it is`);
        const next = cards.slice();
        next[index] = { ...current, humanQA: [...past, { q, askedAt: new Date().toISOString() }], status: 'blocked' };
        return next;
      };
      report = () => `asked ${id}\n`;
    } else {
      throw new UsageError(`unknown command tasks ${command}`);
    }

    const root = options.get('--hive') ?? env.HIVE_ROOT;
    if (!root) throw new UsageError('no hive folder: pass --hive <dir> or set HIVE_ROOT');
    let isDir = false;
    try { isDir = statSync(root).isDirectory(); } catch { /* reported below */ }
    if (!isDir) throw new CliError(`the hive folder ${root} is not a folder`);
    const waitMs = lockWaitMs(env);

    updateTaskLedgerFile(join(root, 'tasks.json'), edit, waitMs === undefined ? {} : { waitMs });
    io.stdout(report());
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message ? `hive: ${e.message}\n\n` : ''}${HIVE_CLI_USAGE}`);
      return EXIT_USAGE;
    }
    if (e instanceof TaskLedgerLockTimeout || e instanceof TaskLedgerLockLost) {
      io.stderr(`hive: the task ledger is busy, nothing was written: ${e.message}\n`);
      return EXIT_LOCKED;
    }
    io.stderr(`hive: ${(e as Error).message}\n`);
    return EXIT_ERROR;
  }
}
