/**
 * cleanSignature — lift a signature off the paper it was written on and crop to
 * the ink. Browser-side, canvas only: no dependency, no server CPU, and the
 * preview the user approves is the exact image that gets stored.
 *
 * Three stages, each earning its place on real uploads:
 *
 *  1. Sauvola local thresholding. A phone photo has uneven lighting, so a single
 *     global threshold either eats faint strokes or leaves a grey box. Sauvola
 *     thresholds each pixel against the local mean AND local contrast,
 *     T = m(1 + k(s/R - 1)), so blank paper — where s collapses to nothing —
 *     can never turn into ink. Both moments come from blurred copies.
 *  2. Hysteresis. Pixels well under T are seeds; pixels just under it survive
 *     only if they touch a seed. Faint stroke tails stay attached, paper grain
 *     dies.
 *  3. Ruled-line removal. Printed rules are ink to any thresholder, and people
 *     sign on whatever notebook is on the desk. Rules are found by vote over
 *     near-horizontal and near-vertical slopes, then followed and deleted.
 *
 * Every stage fails safe: anything unexpected returns the ORIGINAL file. A
 * cosmetic step must never block a signature upload.
 */

/** Reports render a signature ~150px tall; 1200 keeps it crisp and the PNG small. */
const MAX_DIM = 1200;
/** 0-255 alpha under which a pixel doesn't count as ink at all. */
const ALPHA_FLOOR = 8;
/** A row/column needs this share of ink pixels to bound the crop — kills dust. */
const EDGE_INK_SHARE = 0.003;
/** Fraction of the crop added back as breathing room. */
const PAD = 0.03;
/** Ink is deepened by up to this much, scaled by opacity: once the paper is gone
 *  there is nothing left to carry the contrast of a weakly-lit ballpoint. */
const INK_DARKEN = 0.22;

// ── Sauvola ──────────────────────────────────────────────────────────────────
/** Sensitivity. Lower grabs more ink; 0.34 is the usual document-binarisation pick. */
const SAUVOLA_K = 0.34;
/** Dynamic range of the local standard deviation, per the original paper. */
const SAUVOLA_R = 128;
/** Below this fraction of T a pixel is a confident seed rather than a maybe. */
const STRONG_AT = 0.78;
/** How far below T alpha takes to reach full — the anti-aliasing ramp. */
const SOFT_SPAN = 0.35;

// ── Ruled lines ──────────────────────────────────────────────────────────────
/** Coverage — ink on one line as a share of the frame — is the PRIMARY signal
 *  that something is printed rather than written. Measured across two real
 *  notebook photos: printed rules cover 0.55-0.84 of the frame, pen flourishes
 *  0.35-0.42, and that gap holds even when the rule is as dark as the ink. */
const LINE_VOTE = 0.5;
/** Above this coverage a candidate is printed no matter how dark it is: a bold
 *  margin rule measured 0.27 against the paper, darker than some pen strokes,
 *  and the darkness gate alone would never have caught it. */
const LINE_VOTE_DARK = 0.65;
/** Alpha a pixel needs to vote for a line. Low on purpose: a faint margin rule
 *  photographed at an angle carries alpha in the 30s, and excluding it meant the
 *  rule was never detected and survived the whole pipeline. */
const LINE_VOTE_ALPHA = 25;
/** Secondary check on candidates between LINE_VOTE and LINE_VOTE_DARK coverage:
 *  median darkness against the local paper. Printed rules land at 0.44-0.53,
 *  pen flourishes at 0.24-0.34. Also reused to spot leftover rule fragments. */
const LINE_RATIO_GATE = 0.39;
/** An ink run thicker than this across the rule is the signature crossing it. */
const LINE_MAX_THICK = 7;
/** How far off the predicted position to look for the rule. */
const LINE_SEARCH = 6;
/** Half-width cleared at a crossing, where the run can't be measured. */
const LINE_HALF = 2;
/** Ink within this distance on BOTH sides means a stroke passes through. */
const LINE_BRIDGE = 6;
/** Cap on how far the tracker may wander from the fitted line. */
const LINE_ANCHOR = 8;
/** Slopes swept, ±0.15 ≈ ±8.5° — covers any hand-held tilt. */
const LINE_SLOPES = 31;

// ── Speckle ──────────────────────────────────────────────────────────────────
/** An island smaller than this share of the biggest one is debris. */
const SPECK_FRAC = 0.004;
const SPECK_MIN_PX = 40;
/** A leftover island this thin (px) and this elongated, and light against the
 *  paper, is a rule fragment that was too short to out-vote the frame. */
const DEBRIS_MAX_THICK = 4.5;
const DEBRIS_MIN_ELONGATION = 8;

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

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

// ── canvas helpers ───────────────────────────────────────────────────────────

function make(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return [canvas, canvas.getContext('2d', { willReadFrequently: true })!];
}

/**
 * Blur a single plane with the edges REPLICATED outward first.
 *
 * Canvas blurs against whatever is outside the frame — nothing — which drags the
 * paper estimate toward the fill colour along every border and paints a false
 * ink rim there. Stretching the outermost row and column into a margin first
 * costs eight drawImage calls and removes the artefact entirely.
 */
function blurPlane(values: Float32Array, w: number, h: number, radius: number): Float32Array {
  const [src, sctx] = make(w, h);
  const img = sctx.createImageData(w, h);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);

  // A CSS blur of radius r has support out to roughly 1.5r; pad 2r and be done.
  const p = Math.ceil(radius * 2);
  const [padded, pctx] = make(w + 2 * p, h + 2 * p);
  pctx.drawImage(src, 0, 0, 1, h, 0, p, p, h); // left
  pctx.drawImage(src, w - 1, 0, 1, h, w + p, p, p, h); // right
  pctx.drawImage(src, 0, 0, w, 1, p, 0, w, p); // top
  pctx.drawImage(src, 0, h - 1, w, 1, p, h + p, w, p); // bottom
  pctx.drawImage(src, 0, 0, 1, 1, 0, 0, p, p); // corners
  pctx.drawImage(src, w - 1, 0, 1, 1, w + p, 0, p, p);
  pctx.drawImage(src, 0, h - 1, 1, 1, 0, h + p, p, p);
  pctx.drawImage(src, w - 1, h - 1, 1, 1, w + p, h + p, p, p);
  pctx.drawImage(src, p, p);

  const [, bctx] = make(w + 2 * p, h + 2 * p);
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(padded, 0, 0);
  const { data } = bctx.getImageData(p, p, w, h);

  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i += 1) out[i] = data[i * 4];
  return out;
}

function drawFrame(bitmap: ImageBitmap, w: number, h: number, fillWhite: boolean): ImageData {
  const [, ctx] = make(w, h);
  if (fillWhite) {
    // Paper, not transparency, under the image: a JPEG has no alpha of its own.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// ── stage 1 + 2: Sauvola with hysteresis ─────────────────────────────────────

export interface InkMask {
  alpha: Uint8ClampedArray;
  /** Local paper estimate — reused to judge whether a line is printed or drawn. */
  mean: Float32Array;
  gray: Float32Array;
}

export function inkMask(src: ImageData, w: number, h: number): InkMask {
  const gray = new Float32Array(w * h);
  const sq = new Float32Array(w * h);
  for (let i = 0, p = 0; i < src.data.length; i += 4, p += 1) {
    const g = lum(src.data[i], src.data[i + 1], src.data[i + 2]);
    gray[p] = g;
    sq[p] = (g * g) / 255;
  }

  const win = Math.max(8, Math.round(Math.min(w, h) / 12));
  const mean = blurPlane(gray, w, h, win);
  const meanSq = blurPlane(sq, w, h, win);

  const alpha = new Uint8ClampedArray(w * h);
  const weak = new Uint8Array(w * h);
  const soft = new Float32Array(w * h);
  const stack: number[] = [];

  for (let p = 0; p < gray.length; p += 1) {
    const m = mean[p];
    const sd = Math.sqrt(Math.max(0, meanSq[p] * 255 - m * m));
    const t = m * (1 + SAUVOLA_K * (sd / SAUVOLA_R - 1));
    const g = gray[p];
    soft[p] = t <= 0 ? 0 : Math.max(0, Math.min(1, (t - g) / Math.max(1, t * SOFT_SPAN)));
    if (g < t * STRONG_AT) {
      alpha[p] = Math.round(255 * Math.max(soft[p], 0.85));
      stack.push(p);
    } else if (g < t) {
      weak[p] = 1;
    }
  }

  // Hysteresis: a maybe-pixel only counts if it touches a confident one.
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!weak[q]) continue;
        weak[q] = 0;
        alpha[q] = Math.round(255 * soft[q]);
        stack.push(q);
      }
    }
  }

  return { alpha, mean, gray };
}

// ── stage 3: ruled lines ─────────────────────────────────────────────────────

interface RuledLine {
  /** Slope, in the swept direction. */
  m: number;
  /** Intercept at the start of the frame. */
  b: number;
}

/**
 * Vote over near-horizontal (or near-vertical) slopes: for each slope and
 * intercept, count the ink lying on that line. Anything polling above
 * LINE_VOTE of the span is a printed rule — unless it is too dark against the
 * paper, in which case it is a pen stroke that merely happens to be straight.
 */
export function findRuledLines(
  mask: InkMask,
  w: number,
  h: number,
  vertical: boolean,
): RuledLine[] {
  const span = vertical ? h : w;
  const need = Math.round(span * LINE_VOTE);
  const offset = Math.ceil(0.15 * span) + 2;
  const size = (vertical ? w : h) + 2 * offset;
  const candidates: Array<RuledLine & { votes: number }> = [];

  for (let si = 0; si < LINE_SLOPES; si += 1) {
    const m = -0.15 + (0.3 * si) / (LINE_SLOPES - 1);
    const acc = new Int32Array(size);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (mask.alpha[y * w + x] <= LINE_VOTE_ALPHA) continue;
        const b = Math.round(vertical ? x - m * y : y - m * x);
        acc[b + offset] += 1;
      }
    }
    for (let i = 0; i < size; i += 1) {
      if (acc[i] < need) continue;
      const b = i - offset;
      // Darkness of this candidate against the local paper decides printed vs pen.
      // Median, not mean: the few places where the signature crosses the rule are
      // very dark and would drag an average below the gate.
      const ratios: number[] = [];
      for (let a = 0; a < (vertical ? h : w); a += 1) {
        const c = Math.round(m * a + b);
        const x = vertical ? c : a;
        const y = vertical ? a : c;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const p = y * w + x;
        if (mask.alpha[p] <= LINE_VOTE_ALPHA) continue;
        ratios.push(mask.gray[p] / Math.max(1, mask.mean[p]));
      }
      if (!ratios.length) continue;
      ratios.sort((p, q) => p - q);
      const darkness = ratios[ratios.length >> 1];
      if (acc[i] < span * LINE_VOTE_DARK && darkness < LINE_RATIO_GATE) continue;
      candidates.push({ m, b, votes: acc[i] });
    }
  }

  candidates.sort((a, b) => b.votes - a.votes);
  const kept: RuledLine[] = [];
  const half = (vertical ? h : w) / 2;
  for (const c of candidates) {
    const mid = c.m * half + c.b;
    if (kept.some((k) => Math.abs(k.m * half + k.b - mid) < 10)) continue;
    kept.push({ m: c.m, b: c.b });
  }
  return kept;
}

/**
 * Delete the rules, then put back only what a stroke needs to stay continuous.
 *
 * Photographed paper curves, so the fitted line drifts off the rule near the
 * edges: the sweep re-centres on the local ink run at every step but is anchored
 * to within LINE_ANCHOR of the model, or it loses the rule and leaves fragments.
 * A run thicker than LINE_MAX_THICK is the signature crossing, so it survives.
 */
export function stripRuledLines(mask: InkMask, w: number, h: number): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(mask.alpha);
  const removed = new Uint8Array(w * h);
  const idx = (a: number, c: number, vertical: boolean) =>
    vertical
      ? c < 0 || c >= w || a < 0 || a >= h
        ? -1
        : a * w + c
      : c < 0 || c >= h || a < 0 || a >= w
        ? -1
        : c * w + a;

  const sweep = (lines: RuledLine[], vertical: boolean) => {
    const along = vertical ? h : w;
    for (const line of lines) {
      let c = line.b;
      for (let a = 0; a < along; a += 1) {
        const model = line.m * a + line.b;
        c = Math.min(Math.max(c, model - LINE_ANCHOR), model + LINE_ANCHOR);

        let lo = -1;
        let hi = -1;
        for (let d = 0; d <= LINE_SEARCH * 2; d += 1) {
          // 0, -1, +1, -2, +2 … so the nearest run wins
          const step = d === 0 ? 0 : (d % 2 ? -1 : 1) * Math.ceil(d / 2);
          const seed = Math.round(c) + step;
          const i = idx(a, seed, vertical);
          if (i < 0 || out[i] <= ALPHA_FLOOR) continue;
          lo = seed;
          hi = seed;
          for (;;) {
            const j = idx(a, lo - 1, vertical);
            if (j < 0 || out[j] <= ALPHA_FLOOR) break;
            lo -= 1;
          }
          for (;;) {
            const j = idx(a, hi + 1, vertical);
            if (j < 0 || out[j] <= ALPHA_FLOOR) break;
            hi += 1;
          }
          break;
        }

        if (lo < 0) {
          c += line.m; // rule broken here — coast on the model
          continue;
        }
        if (hi - lo + 1 > LINE_MAX_THICK) {
          // The signature crossing. Clear only the thin core of the rule.
          c += line.m;
          for (let k = Math.round(c - LINE_HALF); k <= Math.round(c + LINE_HALF); k += 1) {
            const i = idx(a, k, vertical);
            if (i >= 0 && out[i] > 0) {
              removed[i] = 1;
              out[i] = 0;
            }
          }
          continue;
        }
        for (let k = lo; k <= hi; k += 1) {
          const i = idx(a, k, vertical);
          if (i >= 0 && out[i] > 0) {
            removed[i] = 1;
            out[i] = 0;
          }
        }
        c = (lo + hi) / 2 + line.m;
      }
    }
  };

  sweep(findRuledLines(mask, w, h, false), false);
  sweep(findRuledLines(mask, w, h, true), true);

  // Restore a removed pixel only where ink continues on BOTH sides — that is a
  // stroke passing through. A stub hanging off the rule has one side only.
  const near = (p: number, step: number, count: number) => {
    let best = 0;
    for (let i = 1; i <= count; i += 1) {
      const q = p + step * i;
      if (q < 0 || q >= out.length) break;
      best = Math.max(best, out[q]);
    }
    return best;
  };
  for (let p = 0; p < removed.length; p += 1) {
    if (!removed[p]) continue;
    const up = near(p, -w, LINE_BRIDGE);
    const down = near(p, w, LINE_BRIDGE);
    const left = near(p, -1, LINE_BRIDGE);
    const right = near(p, 1, LINE_BRIDGE);
    if ((up > ALPHA_FLOOR && down > ALPHA_FLOOR) || (left > ALPHA_FLOOR && right > ALPHA_FLOOR)) {
      out[p] = mask.alpha[p];
    }
  }
  return out;
}

/**
 * Drop islands that aren't the signature: grain, stray marks, and rule fragments
 * that were too short to out-vote the frame but still look printed — thin, long,
 * and light against the paper. The signature is thick, or dark, or both.
 */
export function despeckle(
  alpha: Uint8ClampedArray,
  mask: InkMask,
  w: number,
  h: number,
): Uint8ClampedArray {
  const label = new Int32Array(w * h);
  const stack: number[] = [];
  interface Blob {
    area: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    ratios: number[];
  }
  const blobs: Blob[] = [{ area: 0, minX: 0, maxX: 0, minY: 0, maxY: 0, ratios: [] }];

  for (let start = 0; start < alpha.length; start += 1) {
    if (alpha[start] <= ALPHA_FLOOR || label[start]) continue;
    const id = blobs.length;
    const blob: Blob = { area: 0, minX: w, maxX: 0, minY: h, maxY: 0, ratios: [] };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      blob.area += 1;
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      blob.ratios.push(mask.gray[p] / Math.max(1, mask.mean[p]));
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (alpha[q] <= ALPHA_FLOOR || label[q]) continue;
          label[q] = id;
          stack.push(q);
        }
      }
    }
    blobs.push(blob);
  }
  if (blobs.length < 2) return alpha;

  const biggest = blobs.reduce((n, b) => Math.max(n, b.area), 0);
  const floor = Math.max(SPECK_MIN_PX, biggest * SPECK_FRAC);
  const drop = blobs.map((b, i) => {
    if (i === 0 || b.area === biggest) return false;
    if (b.area < floor) return true;
    const span = Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1);
    const thickness = b.area / Math.max(span, 1);
    if (thickness > DEBRIS_MAX_THICK) return false;
    if (span / Math.max(thickness, 0.1) < DEBRIS_MIN_ELONGATION) return false;
    b.ratios.sort((p, q) => p - q);
    return b.ratios[b.ratios.length >> 1] >= LINE_RATIO_GATE;
  });

  const out = Uint8ClampedArray.from(alpha);
  for (let p = 0; p < out.length; p += 1) {
    if (label[p] && drop[label[p]]) out[p] = 0;
  }
  return out;
}

// ── crop ─────────────────────────────────────────────────────────────────────

/**
 * Bounding box of the ink, padded. Rows/columns are kept only when enough of
 * their pixels are ink, so a stray speck can't veto the crop. Null when there is
 * effectively no ink.
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

/** True when the upload is a PNG carrying real cut-out transparency. */
function hasTransparency(file: File, bitmap: ImageBitmap): boolean {
  if (file.type !== 'image/png') return false;
  const size = Math.min(120, Math.max(bitmap.width, bitmap.height));
  const [, ctx] = make(size, size);
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
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
    const src = drawFrame(bitmap, w, h, !alreadyCut);
    bitmap.close?.();

    let alpha: Uint8ClampedArray;
    if (alreadyCut) {
      alpha = new Uint8ClampedArray(w * h);
      for (let i = 0, p = 0; i < src.data.length; i += 4, p += 1) alpha[p] = src.data[i + 3];
    } else {
      const mask = inkMask(src, w, h);
      alpha = despeckle(stripRuledLines(mask, w, h), mask, w, h);
    }

    const out = new ImageData(w, h);
    for (let i = 0, p = 0; i < src.data.length; i += 4, p += 1) {
      const a = alpha[p];
      // Deepen the ink in proportion to how solid it is (untouched for an
      // already-transparent PNG — that one was authored, not photographed).
      const k = alreadyCut ? 1 : 1 - INK_DARKEN * (a / 255);
      out.data[i] = src.data[i] * k;
      out.data[i + 1] = src.data[i + 1] * k;
      out.data[i + 2] = src.data[i + 2] * k;
      out.data[i + 3] = a;
    }

    const box = contentBox(alpha, w, h);
    if (!box) return { file, reveal: null };

    const [full, fctx] = make(w, h);
    fctx.putImageData(out, 0, 0);
    const [cropped, cctx] = make(box.w, box.h);
    cctx.drawImage(full, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

    const blob = await new Promise<Blob | null>((resolve) => cropped.toBlob(resolve, 'image/png'));
    // The upload endpoint caps at 2MB and keys the stored mime off the extension.
    if (!blob || blob.size > 2 * 1024 * 1024) return { file, reveal: null };
    const cleaned = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.png`, {
      type: 'image/png',
    });

    // Only worth animating when a background actually came off.
    let reveal: SignatureReveal | null = null;
    if (!alreadyCut) {
      const cutout = await new Promise<Blob | null>((resolve) => full.toBlob(resolve, 'image/png'));
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
