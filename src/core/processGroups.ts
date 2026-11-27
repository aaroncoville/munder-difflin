/**
 * The process table with each process's group: what a sweep needs to tell whether a process group a run started is
 * still that run's. On Windows there are no process groups, so the table is read without them.
 */
import { execFile } from 'node:child_process';
import { probeProcesses, type ProcRow } from './heavyJob';

/** A process table row with the id of the process group the process is in, where it could be read. */
export interface GroupProcRow extends ProcRow { pgid?: number }

/** Rows of `ps -axo pid=,ppid=,pgid=,command=` output; a line that does not read as one is skipped. */
export function parsePsGroupOutput(out: string): GroupProcRow[] {
  const rows: GroupProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), parentPid: Number(m[2]), pgid: Number(m[3]), commandLine: m[4] });
  }
  return rows;
}

/** The process table with process groups. Rejects when it cannot be read, or reads as no rows. */
export function probeProcessGroups(): Promise<GroupProcRow[]> {
  if (process.platform === 'win32') return probeProcesses();
  const options = { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  return new Promise((resolve, reject) => execFile('ps', ['-axo', 'pid=,ppid=,pgid=,command='], options, (err, stdout) => {
    if (err) return reject(err);
    const rows = parsePsGroupOutput(stdout);
    if (rows.length) resolve(rows); else reject(new Error('Process probe returned no rows'));
  }));
}
