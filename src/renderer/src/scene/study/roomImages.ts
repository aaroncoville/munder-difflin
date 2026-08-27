/**
 * The panel image behind each room, keyed by the path `room.json` declares.
 *
 * The manifest names its art as a relative path, which is data; the bundler
 * needs a static `import` to fingerprint the file and put it in the build. This
 * module is the one place the two are tied together, so a room whose image has
 * no import fails a test rather than painting as a hole in the house.
 *
 * Rooms may share a file — the eight reading rooms all do — so this is keyed by
 * path, not by room.
 */
import almanac from './assets/room-almanac.png';
import cardTable from './assets/room-card-table.png';
import desk from './assets/room-desk.png';
import godStudy from './assets/room-god-study.png';
import hearth from './assets/room-hearth.png';
import shelves from './assets/room-shelves.png';
import writingDesk from './assets/room-writing-desk.png';

export const ROOM_SRC: Record<string, string> = {
  './room-almanac.png': almanac,
  './room-card-table.png': cardTable,
  './room-desk.png': desk,
  './room-god-study.png': godStudy,
  './room-hearth.png': hearth,
  './room-shelves.png': shelves,
  './room-writing-desk.png': writingDesk
};
