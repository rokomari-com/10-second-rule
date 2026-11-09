// Generates simple PNG icons (dark square, light ring) with no dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(s) {
  const raw = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0;
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x + 0.5 - s / 2, y + 0.5 - s / 2) / (s / 2);
      const ring = d > 0.62 && d < 0.84;
      const hand = Math.abs(x + 0.5 - s / 2) < s * 0.04 && y + 0.5 < s / 2 && y + 0.5 > s * 0.28;
      const v = ring || hand ? 242 : 11;
      const o = y * (s * 4 + 1) + 1 + x * 4;
      raw[o] = v; raw[o + 1] = v; raw[o + 2] = ring || hand ? 245 : 15; raw[o + 3] = 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(s, 0); ih.writeUInt32BE(s, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync('icons', { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`icons/icon${s}.png`, png(s));
