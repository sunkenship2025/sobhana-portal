// npx tsx src/lib/squeezeSignature.check.ts — same size, same look, fewer bytes, idempotent.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { squeezeSignature } from './squeezeSignature';

// A noisy "scan": dark ink with per-pixel shade noise and soft edges, on transparent.
const w = 300, h = 120;
const src = new PNG({ width: w, height: h });
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (w * y + x) * 4;
    const dist = Math.abs(y - (60 + 30 * Math.sin(x / 20)));
    src.data[i] = 40 + ((x * 7 + y * 13) % 23);
    src.data[i + 1] = 30 + ((x * 11 + y * 5) % 19);
    src.data[i + 2] = 90 + ((x * 3 + y * 17) % 29);
    src.data[i + 3] = dist < 3 ? 255 : dist < 6 ? Math.round(255 * (6 - dist) / 3) : 0;
  }
}
const before = `data:image/png;base64,${PNG.sync.write(src).toString('base64')}`;
const after = squeezeSignature(before);
const a = PNG.sync.read(Buffer.from(after.split(',')[1], 'base64'));

assert.equal(a.width, w);
assert.equal(a.height, h);
assert.ok(after.length < before.length * 0.6, `expected a much smaller file: ${before.length} → ${after.length}`);
// Composited on white paper, no pixel moves more than one 16-level step.
const onWhite = (d: Buffer, i: number, c: number) => (d[i + c] * d[i + 3] + 255 * (255 - d[i + 3])) / 255;
for (let i = 0; i < src.data.length; i += 4) {
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(onWhite(src.data, i, c) - onWhite(a.data, i, c)) <= 32, `pixel ${i / 4} moved too far`);
}
assert.equal(squeezeSignature(after), after, 'idempotent');
assert.equal(squeezeSignature('data:image/jpeg;base64,/9j/AAAA'), 'data:image/jpeg;base64,/9j/AAAA', 'JPEG passes through');
assert.equal(squeezeSignature('data:image/png;base64,bm90IGEgcG5n'), 'data:image/png;base64,bm90IGEgcG5n', 'garbage passes through');
console.log(`squeezeSignature: ok (${before.length} → ${after.length} chars)`);
