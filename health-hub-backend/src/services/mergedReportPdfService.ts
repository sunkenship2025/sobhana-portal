/**
 * Merged Report PDF Service
 *
 * Single writer for the patient-facing PDF. Renders the base report (panels,
 * values, signatures) via the existing pipeline, then appends each external
 * upload as additional pages with the Sobhana header/footer overlaid on every
 * page so branding stays consistent regardless of the source PDF.
 *
 * If a snapshot has no external uploads this short-circuits to the base PDF
 * unchanged — non-upload visits pay zero overhead.
 *
 * The overlay is drawn natively with pdf-lib primitives (no Puppeteer second
 * pass), which keeps overlay text selectable/copiable and eliminates the
 * 3–5s overlay-render cost that was hitting every cold request.
 */

import fs from 'fs';
import path from 'path';
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import { renderReportHtml } from './reportRendererService';
import { generatePdfFromHtml } from './pdfGenerationService';
import { getObject } from './r2StorageService';
import {
  getCachedMergedPdf,
  setCachedMergedPdf,
} from './mergedReportPdfCache';
import type {
  ExternalUploadSnapshot,
  ReportSnapshot,
} from './reportSnapshotService';

// Page-anchored overlay sizing. Drawn relative to each appended page's actual
// dimensions so non-A4 imaging PDFs still get a properly proportioned band.
const HEADER_LOGO_HEIGHT_PT = 55;
const HEADER_LOGO_LEFT_PT = 14;
const HEADER_LOGO_TOP_OFFSET_PT = 8;
const HEADER_STRIPE_HEIGHT_PT = 10;
const HEADER_STRIPE_TOP_OFFSET_PT = HEADER_LOGO_HEIGHT_PT + HEADER_LOGO_TOP_OFFSET_PT + 4;

const FOOTER_STRIPE_HEIGHT_PT = 2;
const FOOTER_TEXT_TOP_PT = 24; // distance from bottom edge to the top text line
const FOOTER_TEXT_LEFT_PT = 24;
const FOOTER_TEXT_RIGHT_MARGIN_PT = 24;

// Brand palette (mirrors public/css/report-screen.css).
const COLOR_PRIMARY = rgb(0x1f / 0xff, 0x3e / 0xff, 0x6e / 0xff); // #1f3e6e
const COLOR_RED = rgb(0xcc / 0xff, 0x22 / 0xff, 0x22 / 0xff);     // #cc2222
const COLOR_DARK = rgb(0.1, 0.1, 0.1);

// Static footer text (verbatim from reportRendererService.ts:1023-1028).
const FOOTER_NOTE_LINE_1 = 'Note : This report is subject to the terms and conditions overleaf.';
const FOOTER_NOTE_LINE_2 = 'PARTIAL REPRODUCTION OF THIS REPORT IS NOT PERMITTED.';
const FOOTER_ADDRESS_LINE = 'Balanagar : # 3-67, Sobhana Complex, Balanagar, Hyderabad-500042.';
const FOOTER_PHONE_LINE = 'Ph : 040-2377 2929, 4016 3301';

// Lazy-loaded logo bytes. The same file is already used by the report renderer.
const LOGO_PATH = path.join(__dirname, '../../public/images/sobhana-logo-cropped.png');
let cachedLogoBytes: Buffer | null = null;
function getLogoBytes(): Buffer {
  if (cachedLogoBytes) return cachedLogoBytes;
  cachedLogoBytes = fs.readFileSync(LOGO_PATH);
  return cachedLogoBytes;
}

export interface GenerateMergedPdfOptions {
  mode: 'physical' | 'digital';
  baseUrl: string;
  qrDataUrl: string;
  /**
   * When true, look up Redis for a cached PDF and write the generated buffer
   * back on miss. Only the public download path passes `cache: true`; staff
   * preview / draft paths leave it false so they never serve stale bytes and
   * never pollute the cache with unfinalized snapshots.
   */
  cache?: boolean;
}

/**
 * The single writer for the patient-facing PDF.
 *
 * Flow:
 *   1. (cache mode) Try Redis. Hit → return immediately.
 *   2. Render base report HTML → PDF via the existing pipeline.
 *   3. If snapshot.externalUploads is empty, return that buffer (and cache).
 *   4. Otherwise: load base PDF into pdf-lib, fetch all uploads from R2 in
 *      parallel, copy each upload's pages, and draw the Sobhana header/footer
 *      band on every appended page using native pdf-lib primitives.
 *   5. (cache mode) Write the merged buffer back to Redis.
 */
export async function generateMergedReportPdf(
  snapshot: ReportSnapshot,
  options: GenerateMergedPdfOptions
): Promise<Buffer> {
  const { mode, baseUrl, qrDataUrl, cache = false } = options;

  if (cache) {
    const hit = await getCachedMergedPdf(snapshot.reportVersionId).catch(() => null);
    if (hit) return hit;
  }

  const profile = mode === 'physical' ? 'pdf-physical' : 'pdf-digital';
  const html = renderReportHtml(snapshot, { profile, baseUrl, qrDataUrl });
  const basePdf = await generatePdfFromHtml(html, { mode });

  const uploads = (snapshot.externalUploads ?? [])
    .slice()
    .sort((a, b) => {
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      return a.uploadedAt.localeCompare(b.uploadedAt);
    });

  if (uploads.length === 0) {
    if (cache) {
      void setCachedMergedPdf(snapshot.reportVersionId, basePdf);
    }
    return basePdf;
  }

  // Fetch all uploads in parallel — saves N× R2 latency for multi-upload visits.
  const fetchedBuffers = await Promise.all(
    uploads.map((upload) =>
      getObject(upload.r2Key).catch((err) => {
        console.error(
          `[mergedReportPdfService] R2 fetch failed for upload ${upload.uploadId}:`,
          err?.message,
        );
        return null;
      }),
    ),
  );

  const merged = await PDFDocument.load(basePdf);
  const helvetica = await merged.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await merged.embedFont(StandardFonts.HelveticaBold);
  const logoImage = await merged.embedPng(getLogoBytes());

  for (let i = 0; i < uploads.length; i++) {
    const upload = uploads[i];
    const buf = fetchedBuffers[i];
    if (!buf) continue; // R2 fetch failed for this one — skip, keep going.

    try {
      await appendUploadWithOverlay(
        merged,
        upload,
        buf,
        logoImage,
        helvetica,
        helveticaBold,
      );
    } catch (err: any) {
      console.error(
        `[mergedReportPdfService] Skipping upload ${upload.uploadId} after error:`,
        err?.message,
      );
    }
  }

  const out = Buffer.from(await merged.save());

  if (cache) {
    void setCachedMergedPdf(snapshot.reportVersionId, out);
  }

  return out;
}

async function appendUploadWithOverlay(
  merged: PDFDocument,
  upload: ExternalUploadSnapshot,
  uploadBuffer: Buffer,
  logoImage: PDFImage,
  helvetica: PDFFont,
  helveticaBold: PDFFont,
): Promise<void> {
  void upload; // reserved for future per-upload labels in the band
  const src = await PDFDocument.load(uploadBuffer, { ignoreEncryption: true });
  const copied = await merged.copyPages(src, src.getPageIndices());

  for (const page of copied) {
    merged.addPage(page);
    drawOverlayOnPage(page, logoImage, helvetica, helveticaBold);
  }
}

function drawOverlayOnPage(
  page: ReturnType<PDFDocument['addPage']>,
  logoImage: PDFImage,
  helvetica: PDFFont,
  helveticaBold: PDFFont,
): void {
  const { width, height } = page.getSize();

  // ── Header band ─────────────────────────────────────────────────────
  // Logo, scaled to a fixed height, anchored at top-left.
  const logoDims = logoImage.scale(HEADER_LOGO_HEIGHT_PT / logoImage.height);
  page.drawImage(logoImage, {
    x: HEADER_LOGO_LEFT_PT,
    y: height - HEADER_LOGO_TOP_OFFSET_PT - logoDims.height,
    width: logoDims.width,
    height: logoDims.height,
  });

  // Solid stripe band below the logo (vector — no rasterization, scales perfectly).
  page.drawRectangle({
    x: 0,
    y: height - HEADER_STRIPE_TOP_OFFSET_PT - HEADER_STRIPE_HEIGHT_PT,
    width,
    height: HEADER_STRIPE_HEIGHT_PT,
    color: COLOR_PRIMARY,
  });

  // ── Footer band ─────────────────────────────────────────────────────
  // Red 2pt stripe at the very bottom + 2 lines of text above it.
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height: FOOTER_STRIPE_HEIGHT_PT,
    color: COLOR_RED,
  });

  const noteSize = 7;
  const partialSize = 6.5;
  const addressSize = 7;
  const phoneSize = 7.5;

  // Left column: note + partial-reproduction line
  page.drawText(FOOTER_NOTE_LINE_1, {
    x: FOOTER_TEXT_LEFT_PT,
    y: FOOTER_TEXT_TOP_PT,
    size: noteSize,
    font: helveticaBold,
    color: COLOR_DARK,
  });
  page.drawText(FOOTER_NOTE_LINE_2, {
    x: FOOTER_TEXT_LEFT_PT,
    y: FOOTER_TEXT_TOP_PT - 10,
    size: partialSize,
    font: helveticaBold,
    color: COLOR_DARK,
  });

  // Right column: address + phone (right-aligned by measuring text width)
  const addressWidth = helvetica.widthOfTextAtSize(FOOTER_ADDRESS_LINE, addressSize);
  page.drawText(FOOTER_ADDRESS_LINE, {
    x: width - FOOTER_TEXT_RIGHT_MARGIN_PT - addressWidth,
    y: FOOTER_TEXT_TOP_PT,
    size: addressSize,
    font: helvetica,
    color: COLOR_DARK,
  });
  const phoneWidth = helveticaBold.widthOfTextAtSize(FOOTER_PHONE_LINE, phoneSize);
  page.drawText(FOOTER_PHONE_LINE, {
    x: width - FOOTER_TEXT_RIGHT_MARGIN_PT - phoneWidth,
    y: FOOTER_TEXT_TOP_PT - 11,
    size: phoneSize,
    font: helveticaBold,
    color: COLOR_DARK,
  });
}
