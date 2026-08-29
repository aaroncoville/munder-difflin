/**
 * The page-turn film for each desk that has one, keyed by the path the manifest
 * declares.
 *
 * The same arrangement as `roomImages`, and for the same reason: the manifest
 * names its art as a relative path, which is data, and the bundler needs a
 * static `import` to fingerprint the file and put it in the build. This module
 * is the one place the two are tied together, so a berth whose clip has no
 * import fails a test rather than playing as a hole in the desk.
 *
 * Each clip is a few seconds of that corner of that room's own painting, with
 * the book's pages turning — generated from the panel itself, one per berth,
 * with the crop and the seed recorded in `tools/occult-art`. They are per BERTH
 * rather than per room because a reading room holds two desks and each was
 * framed to keep its own candle out of shot.
 */
import berth1 from './assets/book-turn-berth-1.mp4';
import berth2 from './assets/book-turn-berth-2.mp4';
import berth3 from './assets/book-turn-berth-3.mp4';
import berth4 from './assets/book-turn-berth-4.mp4';
import berth5 from './assets/book-turn-berth-5.mp4';
import berth6 from './assets/book-turn-berth-6.mp4';
import berth7 from './assets/book-turn-berth-7.mp4';
import berth8 from './assets/book-turn-berth-8.mp4';

export const TURN_SRC: Record<string, string> = {
  './book-turn-berth-1.mp4': berth1,
  './book-turn-berth-2.mp4': berth2,
  './book-turn-berth-3.mp4': berth3,
  './book-turn-berth-4.mp4': berth4,
  './book-turn-berth-5.mp4': berth5,
  './book-turn-berth-6.mp4': berth6,
  './book-turn-berth-7.mp4': berth7,
  './book-turn-berth-8.mp4': berth8
};
