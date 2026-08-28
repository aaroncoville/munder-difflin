/**
 * The panel image behind each room, keyed by the path `room.json` declares.
 *
 * The manifest names its art as a relative path, which is data; the bundler
 * needs a static `import` to fingerprint the file and put it in the build. This
 * module is the one place the two are tied together, so a room whose image has
 * no import fails a test rather than painting as a hole in the house.
 *
 * Keyed by path rather than by room, because the manifest names its art as a
 * path and this table's whole job is to answer that name. Every room in the
 * house currently hangs a painting of its own; nothing here requires that, and
 * a house that grew past the paintings it has could hang one twice.
 */
import almanac from './assets/room-almanac.png';
import cardTable from './assets/room-card-table.png';
import deskA from './assets/room-desk-a.png';
import deskB from './assets/room-desk-b.png';
import deskC from './assets/room-desk-c.png';
import deskD from './assets/room-desk-d.png';
import godStudy from './assets/room-god-study.png';
import shelves from './assets/room-shelves.png';

export const ROOM_SRC: Record<string, string> = {
  './room-almanac.png': almanac,
  './room-card-table.png': cardTable,
  './room-desk-a.png': deskA,
  './room-desk-b.png': deskB,
  './room-desk-c.png': deskC,
  './room-desk-d.png': deskD,
  './room-god-study.png': godStudy,
  './room-shelves.png': shelves
};
