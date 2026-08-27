'use strict';
/**
 * A minimal PNG reader, so a test can ask what a shipped panel actually paints
 * at a given point.
 *
 * The Study's berths are normalized coordinates read off paintings by eye, and
 * nothing in the tree can tell whether one of them still lands on the desk it
 * was read from — a berth nudged onto a painted window looks exactly as valid
 * as one resting on the desk. Sampling the pixel is the only check that knows
 * the difference.
 *
 * This handles just enough of the format for the panels in the tree: 8 bits a
 * channel, no interlace, no palette. Anything else throws rather than returning
 * a plausible-looking wrong answer. It exists because the alternative is a new
 * image dependency for eight files that never change.
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Undo one scanline's filter, in place, against the row already decoded. */
function unfilter(type, line, prev, out, at, channels) {
  for (let i = 0; i < line.length; i++) {
    const raw = line[i];
    const a = i >= channels ? out[at + i - channels] : 0;
    const b = prev ? prev[i] : 0;
    const c = i >= channels && prev ? prev[i - channels] : 0;
    let value;
    switch (type) {
      case 0: value = raw; break;
      case 1: value = raw + a; break;
      case 2: value = raw + b; break;
      case 3: value = raw + ((a + b) >> 1); break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
      default: throw new Error(`unsupported PNG scanline filter ${type}`);
    }
    out[at + i] = value & 255;
  }
}

/** `{ width, height, at(x, y) -> [r, g, b] }` for the PNG at `file`. */
function readPng(file) {
  const bytes = fs.readFileSync(file);
  const parts = [];
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (depth !== 8 || !channels) {
    throw new Error(`${file}: only 8-bit greyscale/RGB/RGBA PNGs are supported`);
  }

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0, read = 0; y < height; y++) {
    const filter = raw[read++];
    unfilter(
      filter,
      raw.subarray(read, read + stride),
      y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null,
      pixels,
      y * stride,
      channels
    );
    read += stride;
  }

  return {
    width,
    height,
    /** The colour at a point, greyscale expanded to r=g=b and alpha dropped. */
    at(x, y) {
      const cx = Math.min(width - 1, Math.max(0, Math.round(x)));
      const cy = Math.min(height - 1, Math.max(0, Math.round(y)));
      const i = (cy * width + cx) * channels;
      if (channels <= 2) return [pixels[i], pixels[i], pixels[i]];
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    }
  };
}

module.exports = readPng;
