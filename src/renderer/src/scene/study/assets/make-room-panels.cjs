'use strict';
/**
 * Draw one flat placeholder panel per room image the manifest names.
 *
 * The painted rooms arrive on their own track; until they do the cross-section
 * still needs an image behind every panel, at the natural size its berths were
 * authored against, so the stacking can be judged and the per-panel letterboxing
 * exercised. This paints exactly that: a flat ground in the room kind's colour,
 * a faint block under every berth, and a disc at every light point — which makes
 * a mis-authored coordinate visible IN THE IMAGE rather than only as a card
 * hovering over nothing.
 *
 * Rooms sharing an image (the eight reading rooms do) are drawn once, from the
 * first room that names the file; a later room disagreeing about that file's
 * natural size is a manifest bug and is reported rather than silently redrawn.
 *
 * Regenerate with `node make-room-panels.cjs` from this directory.
 * No dependencies: a PNG is a signature plus three chunks, and zlib is builtin.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** A ground per kind, so the storeys read apart at a glance. */
const GROUND = {
  desk:        [0x17, 0x13, 0x22],   // --cth-cream-200, the app ground
  godStudy:    [0x1e, 0x18, 0x2c],   // a shade richer — the foreground room
  cardTable:   [0x2e, 0x28, 0x1c],   // warm, so the props read apart from desks
  writingDesk: [0x2e, 0x28, 0x1c],
  almanac:     [0x2e, 0x28, 0x1c],
  hearth:      [0x35, 0x24, 0x18],   // embers
  shelves:     [0x21, 0x1b, 0x14]
};
const BERTH = [0x26, 0x21, 0x34];    // --cth-paper-100, a shade up from the ground
const GILT = [0x6b, 0x5a, 0x2e];     // --cth-gilt-soft, for the berth hairline
const GLOW = [0x4a, 0x3e, 0x22];     // a candle's pool of light

const CRC = (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
};

function paint(room, file) {
  const W = room.natural.w;
  const H = room.natural.h;
  const px = Buffer.alloc(W * H * 3);
  const ground = GROUND[room.kind];
  for (let i = 0; i < W * H; i++) px.set(ground, i * 3);

  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    px.set(rgb, (y * W + x) * 3);
  };

  for (const b of room.berths) {
    const x0 = Math.round(b.x * W), y0 = Math.round(b.y * H);
    const x1 = Math.round((b.x + b.w) * W), y1 = Math.round((b.y + b.h) * H);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
        put(x, y, edge ? GILT : BERTH);
      }
    }
  }
  const r = Math.max(6, Math.round(Math.min(W, H) * 0.08));
  for (const p of room.lightPoints ?? []) {
    const cx = Math.round(p.x * W), cy = Math.round(p.y * H);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r) put(cx + x, cy + y, GLOW);
    }
  }

  // Scanlines, each prefixed with filter type 0 (None) — the simplest legal PNG.
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

const house = JSON.parse(fs.readFileSync(path.join(__dirname, 'room.json'), 'utf8'));
const drawn = new Map();
for (const room of house.rooms) {
  const seen = drawn.get(room.image);
  if (seen) {
    if (seen.natural.w !== room.natural.w || seen.natural.h !== room.natural.h) {
      throw new Error(
        `${room.id} and ${seen.id} share ${room.image} but disagree about its natural size`
      );
    }
    continue;
  }
  drawn.set(room.image, room);
  paint(room, path.resolve(__dirname, room.image));
}
console.log(`painted ${drawn.size} room panels`);
