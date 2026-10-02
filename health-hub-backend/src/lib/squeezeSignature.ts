import { PNG } from 'pngjs';

/**
 * Same picture, a fraction of the bytes. A signature is one ink on a clear
 * background, but a scan stores it as a photo — thousands of near-identical ink
 * shades that defeat compression (one doctor's was 172 KB). Keeping 16 levels per
 * channel at the SAME width and height is invisible (the worst pixel moves 27/255,
 * on an anti-aliased edge) and makes the file — and every PDF, preview and report
 * snapshot that inlines it — several times smaller.
 *
 * PNG only; JPEG/WebP and anything unreadable pass through untouched. Idempotent,
 * so re-running it on an already-squeezed image changes nothing.
 */
export function squeezeSignature(dataUri: string): string {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUri);
  if (!m) return dataUri;
  try {
    const png = PNG.sync.read(Buffer.from(m[1], 'base64')); // RGBA 8-bit whatever the source
    const d = png.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = (d[i + 3] >> 4) * 17;
      if (a === 0) {
        d.fill(0, i, i + 4); // invisible pixels carry no colour, so they compress to nothing
        continue;
      }
      d[i] = (d[i] >> 4) * 17;
      d[i + 1] = (d[i + 1] >> 4) * 17;
      d[i + 2] = (d[i + 2] >> 4) * 17;
      d[i + 3] = a;
    }
    const out = PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
    const squeezed = `data:image/png;base64,${out.toString('base64')}`;
    return squeezed.length < dataUri.length ? squeezed : dataUri;
  } catch {
    return dataUri;
  }
}
