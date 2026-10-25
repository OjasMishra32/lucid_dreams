// Minimal PNG codec for the court scripts (no packages): 8-bit grey, grey+alpha, RGB and RGBA, non-interlaced.
// encodePng / decodePng work on { width, height, channels, data: Uint8Array } (rows top to bottom, no padding).
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 }; // channels -> PNG colour type
const CHANNELS = { 0: 1, 4: 2, 2: 3, 6: 4 }; // PNG colour type -> channels

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** { width, height, channels (1-4), data } -> PNG bytes. */
export function encodePng({ width, height, channels, data }) {
  if (!(channels in COLOR_TYPE)) throw new Error(`encodePng: ${channels} channels`);
  if (data.length !== width * height * channels) throw new Error(`encodePng: ${data.length} bytes for ${width}x${height}x${channels}`);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter 1 (Sub) per row: small and fast for smooth synthetic images
    const o = y * (stride + 1);
    raw[o] = 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (data[row + x] - (x >= channels ? data[row + x - channels] : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE[channels];
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** PNG bytes -> { width, height, channels, data }. */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("decodePng: not a PNG");
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`decodePng: bit depth ${data[8]} (only 8)`);
      channels = CHANNELS[data[9]];
      if (!channels) throw new Error(`decodePng: colour type ${data[9]} (no palettes)`);
      if (data[12] !== 0) throw new Error("decodePng: interlaced");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels] : 0;
      const v = raw[src + x];
      let p;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`decodePng: filter ${f}`);
      out[row + x] = p & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

export const writePng = (file, image) => writeFileSync(file, encodePng(image));
export const readPng = (file) => decodePng(readFileSync(file));
