/**
 * The one format in which an ASK ME answer carries its attached images.
 *
 * The same block has to appear in TWO places that are written seconds apart and
 * read months apart: the answer stored on the card (`humanQA[].a`) and the
 * message mailed to the agent. If they ever drifted, the card would document an
 * answer the agent never actually received. One function, both call sites.
 *
 * Plain absolute paths, one per line: the agent opens them with its own file
 * tool, so a path is all it needs — no encoding, no copy of the bytes.
 */

const HEADING = 'Attached images:';

/** `text` with a trailing block listing `paths`, or `text` unchanged when there
 *  are none. Duplicate paths are listed once. */
export function withAttachedImages(text: string, paths: readonly string[] | undefined): string {
  const unique = [...new Set(paths ?? [])];
  if (unique.length === 0) return text;
  return `${text}\n\n${HEADING}\n${unique.map((p) => `- ${p}`).join('\n')}`;
}
