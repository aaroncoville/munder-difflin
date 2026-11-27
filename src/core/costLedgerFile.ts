/**
 * Appends to `<hive>/cost-ledger.jsonl`, the append-only record of what each turn cost, under the ledger's lock
 * (`cost-ledger.jsonl.lock`, the shared file lock of fileLock.ts, as for tasks.json), so two writers' rows can
 * never interleave.
 */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, linkSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLock, confirmFileLock, defaultStartTime, releaseFileLock, type FileLockHooks, type OwnLock } from './fileLock';
import { writeAllSync } from './taskLedgerFile';

export const COST_LEDGER_FILE = 'cost-ledger.jsonl';

/** How long an append waits for another writer's ledger lock before it gives up. */
export const LEDGER_LOCK_WAIT_MS = 5000;
/** A lock whose holder cannot be identified (no readable record, or another host) is stale after this. */
const LEDGER_LOCK_STALE_MS = 30_000;

/** Test seams, the wait for the lock (default LEDGER_LOCK_WAIT_MS), and the budget for each start-time read (see
 *  FileLockOptions.startReadMs). */
export interface CostLedgerIo {
  writeSync?: typeof writeSync; lockWaitMs?: number; startReadMs?: number; link?: (existingPath: string, newPath: string) => void;
  hooks?: FileLockHooks & { afterLock?: () => void; afterOpen?: () => void };
}

/** Append `row` to `<hiveRoot>/cost-ledger.jsonl` as one line, whole or not at all (appendCostLedgerRows). */
export function appendCostLedgerRow(hiveRoot: string, row: object, disabled: string, io: CostLedgerIo = {}): void {
  appendCostLedgerRows(hiveRoot, [row], disabled, io);
}

/** Append `rows` to `<hiveRoot>/cost-ledger.jsonl`, one line each, all or none; throws when they were not appended.
 *  The ledger's lock is held once for the whole batch, which is written in one piece and flushed once, and it is
 *  confirmed to be still this writer's immediately before appending; a volume without hard links cannot hold it, so
 *  nothing is appended there (`disabled` names what stops, in that error). A ledger whose last line has no newline (a
 *  writer that stopped part-way) gets one first, so the rows start on a line of their own. The bytes are written in
 *  full (writeAllSync); a write that stops short is undone, by cutting the ledger back to where it was when what
 *  follows that point is only this batch's own bytes. */
export function appendCostLedgerRows(hiveRoot: string, rows: readonly object[], disabled: string, io: CostLedgerIo = {}): void {
  if (rows.length === 0) return;
  const ledger = join(hiveRoot, COST_LEDGER_FILE);
  const lock = `${ledger}.lock`;
  let own: OwnLock | null = null;
  let fd: number | null = null;
  try {
    own = acquireFileLock(lock, {
      waitMs: io.lockWaitMs ?? LEDGER_LOCK_WAIT_MS, staleMs: LEDGER_LOCK_STALE_MS, retryMs: 10,
      startTime: defaultStartTime, startReadMs: io.startReadMs, link: io.link ?? linkSync, hooks: io.hooks ?? {},
      name: COST_LEDGER_FILE, disabled,
      timeout: (l, waitedMs, holder) => new Error(`could not lock ${l} within ${waitedMs} ms: held by ${holder}`),
    });
    io.hooks?.afterLock?.();
    const held = own;
    const confirm = (): void => confirmFileLock(lock, held, (l, holder) => new Error(`${l} no longer holds this writer's record (now ${holder}), so no row was appended`));
    // Before the ledger is even opened (which may create it), and again just before the row is written.
    confirm();
    fd = openSync(ledger, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    const before = fstatSync(fd).size;
    let lead = '';
    if (before > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, before - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    const line = Buffer.from(`${lead}${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    io.hooks?.afterOpen?.();
    confirm();
    try {
      writeAllSync(fd, ledger, line, io.writeSync);
      fsyncSync(fd);
    } catch (e) {
      const size = fstatSync(fd).size;
      const tail = Buffer.alloc(Math.max(0, size - before));
      if (tail.length) readSync(fd, tail, 0, tail.length, before);
      if (tail.length <= line.length && tail.equals(line.subarray(0, tail.length))) ftruncateSync(fd, before);
      throw e;
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (own) releaseFileLock(lock, own);
  }
}
