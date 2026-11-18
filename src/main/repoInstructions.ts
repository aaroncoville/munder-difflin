/**
 * A repository's instructions for a Claude seat that was launched without the repository's own setting sources.
 *
 * With scopedRoots on, Claude seats launch with `--setting-sources user`, so a repository's settings and hooks are not
 * loaded. That also drops the repository's CLAUDE.md and .claude/rules, which carry the instructions the repository
 * gives agents. The app reads those itself and passes them in the seat's appended system prompt, from a source no seat
 * can steer:
 *  - the checkout is the one the app recorded at spawn (an isolated worker's origin checkout, never its worktree; else
 *    the spawn's cwd when it is a git checkout), never found by reading anything inside a worktree;
 *  - files come from that checkout's working tree, never from git objects (every seat that commits from a worktree
 *    writes the base repository's .git);
 *  - a file any live seat, or the seat being spawned, can write is withheld, as is a link or anything that is not a
 *    regular file. Each is opened without following a link and without blocking on a pipe;
 *  - over REPO_INSTRUCTIONS_CAP in total, nothing is included: a truncated instruction can say the opposite of the
 *    whole one.
 *
 * The files, in order: CLAUDE.md and .claude/CLAUDE.md at the checkout root; CLAUDE.md in each folder above it, up to
 * but not including HOME (the farthest first, the nearest last); then .claude/rules/*.md at the checkout root whose
 * front matter sets no `paths`, in name order. CLAUDE.local.md and CLAUDE.md files in subfolders are not read, and an
 * `@path` import is left as literal text, never expanded.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_SETTINGS, readSettings } from './writeRoots';

/** The most text, in bytes, the block may hold. */
export const REPO_INSTRUCTIONS_CAP = 64 * 1024;

/** Why a file was withheld. */
export const WITHHELD_REASONS = ['writable', 'link', 'too-large', 'unreadable'] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

export interface RepoInstructions {
  /** The text for the prompt; empty when there is nothing to say. */
  block: string;
  /** Files included. */
  included: number;
  /** Files found and not included. */
  withheld: number;
  /** Why the first was withheld (too-large when the cap was passed). */
  reason?: WithheldReason;
}

/** The checkout a seat was started from, as the app recorded it: an isolated worker's origin, else the spawn's cwd when
 *  it is a git checkout; undefined when there is none. */
export async function sourceCheckout(origin: string | undefined, cwd: string, isRepo: (cwd: string) => Promise<boolean>): Promise<string | undefined> {
  if (origin) return origin;
  try { return cwd && (await isRepo(cwd)) ? cwd : undefined; } catch { return undefined; }
}

/** True when the front matter at the start of a rule sets `paths` (a rule that applies only to some files). */
export function hasPathsField(text: string): boolean {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^﻿/, ''));
  return !!m && /^paths[ \t]*:/m.test(m[1]);
}

/** CLAUDE.md in each folder above the checkout, up to but not including HOME (or the filesystem root), farthest first. */
function parentFiles(checkout: string, home: string): string[] {
  const stop = resolve(home);
  const out: string[] = [];
  for (let d = dirname(checkout); d !== stop && dirname(d) !== d; d = dirname(d)) out.unshift(join(d, 'CLAUDE.md'));
  return out;
}

/** True when a folder between the checkout and this file (inside the checkout) is a link. */
function linkedFolder(checkout: string, file: string): boolean {
  const rel = relative(checkout, dirname(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  let d = checkout;
  for (const part of rel.split(sep)) {
    d = join(d, part);
    try { if (lstatSync(d).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

type Judged = { kind: 'absent' } | { kind: 'withheld'; reason: WithheldReason } | { kind: 'text'; text: string };

/** One file: absent, withheld (and why), or its text. `reaches` says whether a seat can write the path. */
function judge(checkout: string, file: string, reaches: (file: string) => boolean): Judged {
  let st;
  try { st = lstatSync(file); } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    return c === 'ENOENT' || c === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'withheld', reason: 'unreadable' };
  }
  if (reaches(file)) return { kind: 'withheld', reason: 'writable' };
  if (st.isSymbolicLink() || linkedFolder(checkout, file)) return { kind: 'withheld', reason: 'link' };
  if (!st.isFile()) return { kind: 'withheld', reason: 'unreadable' };
  // Larger than any file read here: over the cap whatever it says. Smaller ones are read, so a rule's front matter is
  // known before its size counts.
  if (st.size > MAX_SETTINGS) return { kind: 'withheld', reason: 'too-large' };
  // Opened without following a link and without blocking on a pipe, and judged again on the handle.
  const r = readSettings(file);
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind !== 'text') return { kind: 'withheld', reason: 'unreadable' };
  return { kind: 'text', text: r.text };
}

/** The repository instructions block for a checkout, with counts for the usage row. `reaches` is true for a path a
 *  live seat, or the seat being spawned, can write. Never throws for a file it cannot use: that file is withheld. */
export function repoInstructions(checkout: string, home: string, reaches: (file: string) => boolean): RepoInstructions {
  const root = resolve(checkout);
  const fixed = [join(root, 'CLAUDE.md'), join(root, '.claude', 'CLAUDE.md'), ...parentFiles(root, home)];
  let rules: string[] = [];
  try { rules = readdirSync(join(root, '.claude', 'rules')).filter((n) => n.endsWith('.md')).sort().map((n) => join(root, '.claude', 'rules', n)); } catch { /* none */ }

  const included: Array<{ file: string; text: string }> = [];
  let withheld = 0;
  let reason: WithheldReason | undefined;
  let tooLarge = false;
  let bytes = 0;
  for (const file of [...fixed, ...rules]) {
    const j = judge(root, file, reaches);
    if (j.kind === 'absent') continue;
    if (j.kind === 'withheld') {
      if (j.reason === 'too-large') { tooLarge = true; withheld++; continue; }
      withheld++;
      reason ??= j.reason;
      continue;
    }
    // A rule that applies only to some paths is not an instruction for the whole checkout.
    if (rules.includes(file) && hasPathsField(j.text)) continue;
    included.push({ file, text: j.text });
    bytes += Buffer.byteLength(j.text, 'utf8');
  }
  if (tooLarge || bytes > REPO_INSTRUCTIONS_CAP) {
    return {
      block: `Repository instructions (${basename(root)})\nSome repository instructions were withheld because they are too large.`,
      included: 0, withheld: withheld + included.length, reason: 'too-large'
    };
  }
  if (!included.length && !withheld) return { block: '', included: 0, withheld: 0 };
  const parts = [`Repository instructions (${basename(root)})`];
  for (const f of included) parts.push('', `--- ${relative(root, f.file)} ---`, f.text);
  if (withheld) parts.push('', 'Some repository instructions were withheld because an agent can write them.');
  return { block: parts.join('\n'), included: included.length, withheld, ...(reason ? { reason } : {}) };
}
