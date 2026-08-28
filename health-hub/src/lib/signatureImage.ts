/**
 * cleanSignature — strip the paper background off an uploaded signature and crop
 * to the ink. Browser-side, canvas only: no dependency, no server CPU, and the
 * preview the user sees before saving is already the cleaned image.
 *
 * Phone photos of a signed slip have uneven lighting, so one global threshold
 * either eats faint strokes or leaves a grey box. The paper is instead estimated
 * locally with a heavy blur and every pixel divided by it (flat-field
 * correction): paper lands near 1.0 whatever the lamp was doing, ink well below.
 * Alpha ramps between the two so anti-aliased stroke edges stay smooth.
 *
 * Anything unexpected (decode failure, a result with almost no ink left) returns
 * the ORIGINAL file — a cosmetic step must never block a signature upload.
 */

/** Reports render a signature ~150px tall; 1200 keeps it crisp and the PNG small. */
const MAX_DIM = 1200;
/** paper/ink ratio at or above which a pixel is background. */
const PAPER = 0.9;
/** ratio at or below which a pixel is solid ink. */
const INK = 0.55;
/** 0-255 alpha under which a pixel doesn't count as ink at all. */
const ALPHA_FLOOR = 8;
/** A row/column needs this share of ink pixels to bound the crop — kills dust
 *  specks and the faint rim the blur leaves at the image border. */
const EDGE_INK_SHARE = 0.003;
/** Fraction of the crop added back as breathing room. */
const PAD = 0.03;
/** Ink is deepened by up to this much, scaled by opacity — a ballpoint photographed
 *  under a weak lamp prints washed out, and the paper it used to sit on is gone, so
 *  there's nothing left to carry the contrast. Edges darken less than stroke cores,
 *  which keeps the anti-aliasing soft. */
const INK_DARKEN = 0.22;

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Pixel alpha (0-255) from its luminance against the locally-estimated paper. */
export function inkAlpha(pixelLum: number, paperLum: number): number {
  const ratio = pixelLum / Math.max(paperLum, 1);
  if (ratio >= PAPER) return 0;
  if (ratio <= INK) return 255;
  return Math.round((255 * (PAPER - ratio)) / (PAPER - INK));
}

/**
 * Bounding box of the ink in an alpha plane, padded. Rows/columns are kept only
 * when enough of their pixels are ink, so a stray speck can't veto the crop.
 * Returns null when there is effectively no ink.
 */
export function contentBox(
  alpha: Uint8ClampedArray,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (alpha[y * w + x] > ALPHA_FLOOR) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  // Absolute floor of 2 as well as the share: on a small image the share rounds
  // to 1 and a single dust speck would define the crop.
  const minRow = Math.max(2, Math.ceil(w * EDGE_INK_SHARE));
  const minCol = Math.max(2, Math.ceil(h * EDGE_INK_SHARE));
  let top = rows.findIndex((n) => n >= minRow);
  let left = cols.findIndex((n) => n >= minCol);
  if (top < 0 || left < 0) return null;
  let bottom = h - 1;
  while (bottom > top && rows[bottom] < minRow) bottom -= 1;
  let right = w - 1;
  while (right > left && cols[right] < minCol) right -= 1;

  const pad = Math.round(Math.max(right - left, bottom - top) * PAD);
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad);
  bottom = Math.min(h - 1, bottom + pad);
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

function drawToCanvas(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  filter?: string,
  fillWhite = true,
): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Paper, not transparency, under the image: a JPEG has no alpha and a blurred
  // copy must fade to paper-white rather than to black.
  if (fillWhite) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  if (filter) ctx.filter = filter;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Frames for the reveal animation. Both URLs are object URLs the CALLER revokes. */
export interface SignatureReveal {
  /** The upload as drawn, unscaled aspect. */
  originalUrl: string;
  /** Same frame, background removed, NOT yet cropped — so the wipe lines up. */
  cutoutUrl: string;
  /** Crop box within that frame, normalised 0-1, for the zoom that follows. */
  box: { x: number; y: number; w: number; h: number };
  /** Frame aspect (w/h), so the preview box can match it. */
  aspect: number;
}

export interface CleanedSignature {
  /** Cleaned + cropped, or the ORIGINAL file when nothing could be improved. */
  file: File;
  /** null when no background was removed (already-transparent PNG, or fallback). */
  reveal: SignatureReveal | null;
}

export async function cleanSignature(file: File): Promise<CleanedSignature> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    // A PNG that already carries cut-out transparency keeps its own alpha —
    // re-thresholding someone's clean signature would only degrade it. It still
    // gets cropped.
    const alreadyCut = hasTransparency(file, bitmap);
    const src = drawToCanvas(bitmap, w, h, undefined, !alreadyCut);
    const blur = Math.max(6, Math.round(Math.min(w, h) / 10));
    const paper = alreadyCut ? null : drawToCanvas(bitmap, w, h, `blur(${blur}px)`);
    bitmap.close?.();

    const out = new ImageData(w, h);
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < src.data.length; i += 4, p += 1) {
      const r = src.data[i];
      const g = src.data[i + 1];
      const b = src.data[i + 2];
      const a = paper
        ? inkAlpha(lum(r, g, b), lum(paper.data[i], paper.data[i + 1], paper.data[i + 2]))
        : src.data[i + 3];
      // Deepen the ink in proportion to how solid it is (untouched for an
      // already-transparent PNG — that one was authored, not photographed).
      const k = paper ? 1 - INK_DARKEN * (a / 255) : 1;
      alpha[p] = a;
      out.data[i] = r * k;
      out.data[i + 1] = g * k;
      out.data[i + 2] = b * k;
      out.data[i + 3] = a;
    }

    const box = contentBox(alpha, w, h);
    if (!box) return { file, reveal: null };

    const full = document.createElement('canvas');
    full.width = w;
    full.height = h;
    full.getContext('2d')!.putImageData(out, 0, 0);

    const cropped = document.createElement('canvas');
    cropped.width = box.w;
    cropped.height = box.h;
    cropped
      .getContext('2d')!
      .drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

    const blob = await new Promise<Blob | null>((resolve) =>
      cropped.toBlob(resolve, 'image/png'),
    );
    // The upload endpoint caps at 2MB and keys the stored mime off the extension.
    if (!blob || blob.size > 2 * 1024 * 1024) return { file, reveal: null };
    const cleaned = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.png`, {
      type: 'image/png',
    });

    // Only worth animating when a background actually came off.
    let reveal: SignatureReveal | null = null;
    if (!alreadyCut) {
      const cutout = await new Promise<Blob | null>((resolve) =>
        full.toBlob(resolve, 'image/png'),
      );
      if (cutout) {
        reveal = {
          originalUrl: URL.createObjectURL(file),
          cutoutUrl: URL.createObjectURL(cutout),
          box: { x: box.x / w, y: box.y / h, w: box.w / w, h: box.h / h },
          aspect: w / h,
        };
      }
    }
    return { file: cleaned, reveal };
  } catch {
    return { file, reveal: null };
  }
}

/** True when the upload is a PNG carrying real cut-out transparency. */
function hasTransparency(file: File, bitmap: ImageBitmap): boolean {
  if (file.type !== 'image/png') return false;
  const probe = document.createElement('canvas');
  const size = Math.min(120, Math.max(bitmap.width, bitmap.height));
  probe.width = size;
  probe.height = size;
  const ctx = probe.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}
