#!/usr/bin/env node
/**
 * Generates the ordi desktop icon set (PNG/ICO/ICNS) without dependencies:
 * a rounded #283b6b square with a white ring (the "o"). Run once; outputs are
 * committed so CI's tauri-action can bundle without extra tooling.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'src-tauri', 'icons');
mkdirSync(OUT, { recursive: true });

// ── raster: rounded square + ring ──
function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const cx = (size - 1) / 2;
  const ringOuter = size * 0.30;
  const ringInner = size * 0.17;
  const bg = [0x28, 0x3b, 0x6b];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-rect coverage
      const dx = Math.max(r - x, x - (size - 1 - r), 0);
      const dy = Math.max(r - y, y - (size - 1 - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      if (!inside) continue; // transparent
      const d = Math.hypot(x - cx, y - cx);
      const ring = d <= ringOuter && d >= ringInner;
      const aa = 1.5; // cheap edge softening for the ring
      let white = 0;
      if (ring) white = 1;
      else if (Math.abs(d - ringOuter) < aa || Math.abs(d - ringInner) < aa) white = 0.4;
      const c = white ? [
        Math.round(bg[0] + (255 - bg[0]) * white),
        Math.round(bg[1] + (255 - bg[1]) * white),
        Math.round(bg[2] + (255 - bg[2]) * white),
      ] : bg;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

// ── PNG encoder ──
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const px = raster(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-compressed entries) ──
function ico(sizes) {
  const pngs = sizes.map((s) => ({ s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { s, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// ── ICNS (PNG payload chunks) ──
function icns() {
  const types = [['ic07', 128], ['ic08', 256], ['ic09', 512]];
  const chunks = types.map(([type, s]) => {
    const data = png(s);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const total = chunks.reduce((n, c) => n + c.length, 8);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

writeFileSync(join(OUT, '32x32.png'), png(32));
writeFileSync(join(OUT, '128x128.png'), png(128));
writeFileSync(join(OUT, '128x128@2x.png'), png(256));
writeFileSync(join(OUT, 'icon.png'), png(512));
writeFileSync(join(OUT, 'icon.ico'), ico([32, 64, 256]));
writeFileSync(join(OUT, 'icon.icns'), icns());
console.log('✓ icons written to', OUT);
