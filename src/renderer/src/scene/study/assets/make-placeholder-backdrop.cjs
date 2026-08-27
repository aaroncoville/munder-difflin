'use strict';
/**
 * Draw `backdrop-placeholder.png` — the stand-in Study interior.
 *
 * The painted backdrop arrives on its own track; until it does the scene still
 * needs an image at the right aspect with the berths visible, so the layout can
 * be judged and the letterboxing exercised. This paints exactly that: the room
 * ground with a faint block under every rectangle room.json declares, which
 * makes a mis-authored coordinate visible at a glance instead of only as a card
 * hovering over nothing.
 *
 * Regenerate with `node make-placeholder-backdrop.cjs` from this directory.
 * No dependencies: a PNG is a signature plus three chunks, and zlib is builtin.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const W = 1344;
const H = 768;
const GROUND = [0x17, 0x13, 0x22];   // --cth-cream-200, the app ground
const DESK = [0x26, 0x21, 0x34];     // --cth-paper-100, a shade up
const ANCHOR = [0x2e, 0x28, 0x1c];   // warm, so props read apart from desks
const GILT = [0x6b, 0x5a, 0x2e];     // --cth-gilt-soft, for the berth hairline
const GLOW = [0x4a, 0x3e, 0x22];     // a candle's pool of light

const room = JSON.parse(fs.readFileSync(path.join(__dirname, 'room.json'), 'utf8'));
const px = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) px.set(GROUND, i * 3);

const put = (x, y, rgb) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  px.set(rgb, (y * W + x) * 3);
};

const block = (b, fill) => {
  const x0 = Math.round(b.x * W), y0 = Math.round(b.y * H);
  const x1 = Math.round((b.x + b.w) * W), y1 = Math.round((b.y + b.h) * H);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
      put(x, y, edge ? GILT : fill);
    }
  }
};

const disc = (p, r) => {
  const cx = Math.round(p.x * W), cy = Math.round(p.y * H);
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (x * x + y * y <= r * r) put(cx + x, cy + y, GLOW);
  }
};

for (const b of Object.values(room.anchors)) block(b, ANCHOR);
for (const b of room.deskBerths) block(b, DESK);
block(room.godBerth, DESK);
for (const p of room.lightPoints) disc(p, 26);

// Scanlines, each prefixed with filter type 0 (None) — the simplest legal PNG.
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0;
  px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
}

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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // colour type: truecolour RGB
fs.writeFileSync(path.join(__dirname, 'backdrop-placeholder.png'), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]));
