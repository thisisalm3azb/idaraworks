/**
 * H31 — a minimal PNG encoder with no native dependency.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The per-tenant icon is normally drawn by `sharp`, which is a native binding.
 * On the day H31 shipped, the manifest returned 200 and the icon returned 500 in
 * production, because sharp's Linux libraries were not traced into that
 * serverless function.
 *
 * That is worth more than a bug fix. A 500 on an icon is not cosmetic: Chromium
 * requires a 192px and a 512px icon to consider an app installable, so a failing
 * icon endpoint can make the whole feature unavailable. An icon route must
 * therefore never depend on something that can be absent at runtime.
 *
 * So this encodes a solid-colour PNG using only `node:zlib`. It produces a plain
 * brand-coloured square — less handsome than the initials mark, and still the
 * customer's colour, still a valid icon, still installable. sharp draws the good
 * one when it is available; this guarantees there is always one.
 *
 * Pure, deterministic, and small enough to read: a PNG is a signature, an IHDR,
 * one zlib-compressed IDAT and an IEND, each chunk with a CRC32.
 */
import { deflateSync } from "node:zlib";

/** CRC32, as the PNG specification defines it. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * A square PNG filled with one opaque colour.
 *
 * 8-bit RGBA, no interlacing, one filter byte (0 = None) per scanline — the
 * simplest form the specification allows, which is exactly what is wanted from
 * a fallback that must never itself fail.
 */
export function solidPng(size: number, r: number, g: number, b: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each row is one filter byte followed by size RGBA pixels.
  const rowLength = 1 + size * 4;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
