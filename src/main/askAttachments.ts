/**
 * Storage for images a human attaches to an ASK ME answer.
 *
 * The renderer hands over BYTES ONLY. It never proposes a filename, a directory
 * or an extension: every attachment is written under
 * `<hiveRoot>/asks/attachments/<task>/<timestamp>-<n>.<ext>`, with the task
 * folder slugged and the file name generated here. That is what leaves a
 * hostile — or merely careless — renderer nothing to traverse WITH, and it is
 * why the extension is decided by sniffing the leading bytes rather than by
 * trusting a name or a MIME string: a text file renamed to `.png`, or a
 * `image/png` label on arbitrary bytes, is not an image.
 *
 * Generating the path is not the same as confining it, though — see
 * `saveAskAttachment` for why the shared `safeResolve` guard runs over a path
 * this module built itself, and why the write is an exclusive create.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openForCreate, safeResolve } from './fs';

/** Images above this never touch the disk. Screenshots are far below it. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type SaveAttachmentResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** The formats an agent's file tool can actually read back. */
type ImageExt = 'png' | 'jpg' | 'gif' | 'webp';

const startsWith = (bytes: Uint8Array, sig: number[], at = 0): boolean =>
  sig.every((b, i) => bytes[at + i] === b);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * The image format these bytes actually are, or null.
 *
 * Signatures only — a file's name and its declared MIME type are both caller
 * input and neither is evidence of anything.
 */
export function sniffImageExt(bytes: Uint8Array): ImageExt | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  // RIFF container, "WEBP" form type at byte 8.
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  return null;
}

/**
 * A task id reduced to one safe path segment.
 *
 * Everything outside `[A-Za-z0-9_-]` becomes `-`, so separators, dots and
 * drive letters cannot survive: no `..`, no nesting, no absolute path.
 */
export function attachmentFolder(taskId: string): string {
  const slug = taskId.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'task';
}

/** `2026-01-02T03-04-05-678Z` — sortable, and legal on every filesystem. */
const stamp = (now: Date): string => now.toISOString().replace(/[:.]/g, '-');

/**
 * Validate and store one attachment. Returns the absolute path written, or the
 * reason it was refused — which the caller shows to the human verbatim.
 *
 * Generating the whole path here stops a caller STRING from traversing out, but
 * that is string math and string math cannot see a symlink. The hive is a shared
 * directory that agents, backups and clones all write into, so a link can
 * already be sitting at `asks/attachments/<task>`: an in-root name to the check,
 * an external directory to the kernel that resolves the write. Both the folder
 * and the file therefore go through the same `safeResolve` guard the file IPC
 * uses, and the write itself is an exclusive create through `openForCreate` —
 * the guard and the open resolve the name separately, so a link that appears
 * between them is refused by the kernel rather than followed.
 *
 * Async because containment cannot be decided without touching the filesystem.
 */
export async function saveAskAttachment(opts: {
  hiveRoot: string;
  taskId: unknown;
  bytes: unknown;
  now?: Date;
}): Promise<SaveAttachmentResult> {
  const { hiveRoot, taskId, bytes } = opts;
  if (typeof taskId !== 'string' || !taskId) return { ok: false, error: 'invalid task id' };
  const data =
    bytes instanceof Uint8Array ? bytes
      : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
        : null;
  if (!data) return { ok: false, error: 'attachment is not an image' };
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: 'image is too large — the limit is 10MB' };
  }
  const ext = sniffImageExt(data);
  if (!ext) return { ok: false, error: 'attachment is not an image (PNG, JPEG, GIF or WebP only)' };

  const relDir = join('asks', 'attachments', attachmentFolder(taskId));
  const dir = await safeResolve(hiveRoot, relDir);
  if (!dir) return { ok: false, error: 'the attachments folder escapes the hive' };
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not save the image: ${(err as Error).message}` };
  }

  const base = stamp(opts.now ?? new Date());
  for (let n = 1; n <= 1000; n += 1) {
    const target = await safeResolve(hiveRoot, join(relDir, `${base}-${n}.${ext}`));
    // Refused rather than free: something is at that name that leaves the hive.
    // Skip it — a poisoned name is one name, not a reason to lose the image.
    if (!target) continue;
    let fh;
    try {
      fh = await openForCreate(target);
      await fh.writeFile(data);
      return { ok: true, path: target };
    } catch (err) {
      // EEXIST is the answer to "is this name free?", asked atomically. Anything
      // else — a full disk, a read-only hive — is a real failure to report.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, error: `could not save the image: ${(err as Error).message}` };
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  return { ok: false, error: 'too many attachments on this answer' };
}
