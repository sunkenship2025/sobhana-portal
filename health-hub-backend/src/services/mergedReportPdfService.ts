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
import { resolveTenantAssets } from './tenantAssetResolver';
import { generatePdfFromHtml } from './pdfGenerationService';
import { getObject } from './r2StorageService';
import {
  getCachedMergedPdf,
  setCachedMergedPdf,
} from './mergedReportPdfCache';
import { logger } from '../lib/logger';
import type {
  ExternalUploadSnapshot,
  ReportSnapshot,
} from './reportSnapshotService';

// Page-anchored overlay sizing. Values mirror the report's CSS via the standard
// 1 CSS px = 0.75pt ratio (Puppeteer renders at 96dpi, PDF is 72dpi). That way
// the overlay band on appended pages looks identical to the rendered base report.
//
// CSS reference: public/css/report-screen.css (.header, .header-logo,
// .header-stripe-band, .footer, .footer-stripe, .footer-content).
const HEADER_LOGO_HEIGHT_PT = 41;          // CSS .header-logo height: 55px
const HEADER_LOGO_LEFT_PT = 15;            // CSS .header-logo-row padding-left: 20px
const HEADER_LOGO_TOP_OFFSET_PT = 7.5;     // CSS .header-logo-row padding-top: 10px
const HEADER_LOGO_STRIPE_GAP_PT = 3;       // CSS .header-logo-row padding-bottom: 4px
const HEADER_STRIPE_LINE_PT = 1.5;         // CSS stripe: 2px-thick blue lines
const HEADER_STRIPE_GAP_PT = 1.5;          // CSS stripe: 2px-thick white gaps

// Footer is anchored to the page bottom and stacked from the bottom up:
// [bottom padding] → [PARTIAL/phone line] → [Note/address line] → [stripe] → [...up the page]
const FOOTER_BOTTOM_PADDING_PT = 7;        // CSS .footer-content padding-bottom: 8px ≈ 6pt + descender slack
const FOOTER_LINE_GAP_PT = 1;              // CSS .text margin-bottom: 1px
const FOOTER_NOTE_SIZE_PT = 7;             // CSS .note-text font-size: 7pt
const FOOTER_PARTIAL_SIZE_PT = 6.5;        // CSS .partial-text font-size: 6.5pt
const FOOTER_ADDRESS_SIZE_PT = 7;          // CSS .address-text font-size: 7pt
const FOOTER_PHONE_SIZE_PT = 7.5;          // CSS .phone-text font-size: 7.5pt
const FOOTER_TEXT_LEFT_PT = 18;            // CSS .footer-content padding-left: 24px
const FOOTER_TEXT_RIGHT_MARGIN_PT = 18;    // CSS .footer-content padding-right: 24px
const FOOTER_STRIPE_TOP_GAP_PT = 4.5;      // CSS .footer-content padding-top: 6px
const FOOTER_STRIPE_HEIGHT_PT = 1.5;       // CSS .footer-stripe height: 2px

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
    const hit = await getCachedMergedPdf(snapshot.reportVersionId, mode).catch(() => null);
    if (hit) return hit;
  }

  const uploads = (snapshot.externalUploads ?? [])
    .slice()
    .sort((a, b) => {
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      return a.uploadedAt.localeCompare(b.uploadedAt);
    });

  // Pure external-upload visit: every report page is an external lab report that
  // already carries patient identifiers and lab branding. A blank Sobhana cover
  // adds no value, so skip the Puppeteer render entirely and start the merge
  // from an empty document. Saves ~1s per request and avoids a wasted page.
  const skipBaseRender = snapshot.departments.length === 0 && uploads.length > 0;

  if (!skipBaseRender) {
    const profile = mode === 'physical' ? 'pdf-physical' : 'pdf-digital';
    const tenantAssets = snapshot.tenantBrandingSnapshot || await resolveTenantAssets((snapshot.visit as any)?.tenantId || 'sobhana-default');
    const html = renderReportHtml(snapshot, { profile, baseUrl, qrDataUrl }, tenantAssets);
    const basePdf = await generatePdfFromHtml(html, { mode });

    if (uploads.length === 0) {
      if (cache) {
        void setCachedMergedPdf(snapshot.reportVersionId, mode, basePdf);
      }
      return basePdf;
    }

    // Continue with merge — load the base PDF, append uploads with overlay.
    return await mergeUploadsIntoBase(basePdf, uploads, snapshot, cache, mode);
  }

  // skipBaseRender path: start from a blank document, append uploads with overlay only.
  return await mergeUploadsIntoBase(null, uploads, snapshot, cache, mode);
}

async function mergeUploadsIntoBase(
  basePdf: Buffer | null,
  uploads: ExternalUploadSnapshot[],
  snapshot: ReportSnapshot,
  cache: boolean,
  mode: 'physical' | 'digital',
): Promise<Buffer> {
  // Physical mode prints on pre-printed Sobhana letterhead — the paper already
  // carries the logo + stripe + footer, so drawing our overlay on top would
  // double up. Skip the overlay; appended pages print as-is into the
  // letterhead's content area.
  const drawOverlay = mode === 'digital';

  // Fetch all uploads in parallel — saves N× R2 latency for multi-upload visits.
  const fetchedBuffers = await Promise.all(
    uploads.map((upload) =>
      getObject(upload.r2Key).catch((err) => {
        logger.error(
          {
            err,
            uploadId: upload.uploadId,
            reportVersionId: snapshot.reportVersionId,
          },
          'R2 fetch failed for upload — skipping in merge',
        );
        return null;
      }),
    ),
  );

  const merged = basePdf ? await PDFDocument.load(basePdf) : await PDFDocument.create();
  // Only embed font/logo when we're going to draw the overlay.
  const overlayAssets = drawOverlay
    ? {
        helvetica: await merged.embedFont(StandardFonts.Helvetica),
        helveticaBold: await merged.embedFont(StandardFonts.HelveticaBold),
        logoImage: await merged.embedPng(getLogoBytes()),
      }
    : null;

  for (let i = 0; i < uploads.length; i++) {
    const upload = uploads[i];
    const buf = fetchedBuffers[i];
    if (!buf) continue; // R2 fetch failed for this one — skip, keep going.

    try {
      await appendUpload(merged, upload, buf, overlayAssets);
    } catch (err: any) {
      logger.error(
        {
          err,
          uploadId: upload.uploadId,
          reportVersionId: snapshot.reportVersionId,
        },
        'pdf-lib failed to append upload — skipping',
      );
    }
  }

  const out = Buffer.from(await merged.save());

  if (cache) {
    void setCachedMergedPdf(snapshot.reportVersionId, mode, out);
  }

  return out;
}

interface OverlayAssets {
  logoImage: PDFImage;
  helvetica: PDFFont;
  helveticaBold: PDFFont;
}

async function appendUpload(
  merged: PDFDocument,
  upload: ExternalUploadSnapshot,
  uploadBuffer: Buffer,
  overlayAssets: OverlayAssets | null,
): Promise<void> {
  void upload; // reserved for future per-upload labels in the band
  const src = await PDFDocument.load(uploadBuffer, { ignoreEncryption: true });
  const copied = await merged.copyPages(src, src.getPageIndices());

  for (const page of copied) {
    merged.addPage(page);
    if (overlayAssets) {
      drawOverlayOnPage(
        page,
        overlayAssets.logoImage,
        overlayAssets.helvetica,
        overlayAssets.helveticaBold,
      );
    }
  }
}

function drawOverlayOnPage(
  page: ReturnType<PDFDocument['addPage']>,
  logoImage: PDFImage,
  helvetica: PDFFont,
  helveticaBold: PDFFont,
): void {
  const { width, height } = page.getSize();

  // ── Header band (top of page, top-down layout) ──────────────────────
  // Logo: scaled to a fixed height, anchored top-left. width auto via aspect.
  const logoDims = logoImage.scale(HEADER_LOGO_HEIGHT_PT / logoImage.height);
  const logoBottomY = height - HEADER_LOGO_TOP_OFFSET_PT - logoDims.height;
  page.drawImage(logoImage, {
    x: HEADER_LOGO_LEFT_PT,
    y: logoBottomY,
    width: logoDims.width,
    height: logoDims.height,
  });

  // Striped band immediately below the logo. Three 1.5pt blue lines separated
  // by 1.5pt white gaps = 7.5pt total. Mirrors the CSS repeating-linear-gradient
  // (2px blue / 2px white pattern) at the 0.75 px→pt ratio.
  const stripeTopY = logoBottomY - HEADER_LOGO_STRIPE_GAP_PT;
  for (let i = 0; i < 3; i++) {
    const lineTopY = stripeTopY - i * (HEADER_STRIPE_LINE_PT + HEADER_STRIPE_GAP_PT);
    page.drawRectangle({
      x: 0,
      y: lineTopY - HEADER_STRIPE_LINE_PT,
      width,
      height: HEADER_STRIPE_LINE_PT,
      color: COLOR_PRIMARY,
    });
  }

  // ── Footer band (bottom of page, bottom-up stack) ───────────────────
  // Layout from page bottom upwards:
  //   [FOOTER_BOTTOM_PADDING_PT]
  //   [PARTIAL / phone line]
  //   [FOOTER_LINE_GAP_PT]
  //   [Note / address line]
  //   [FOOTER_STRIPE_TOP_GAP_PT]
  //   [Red stripe]
  const partialBaselineY = FOOTER_BOTTOM_PADDING_PT;
  const noteBaselineY =
    partialBaselineY + FOOTER_PARTIAL_SIZE_PT + FOOTER_LINE_GAP_PT;
  const stripeBottomY =
    noteBaselineY + FOOTER_NOTE_SIZE_PT + FOOTER_STRIPE_TOP_GAP_PT;

  // Red stripe ABOVE the text (matches HTML order: <footer-stripe> then <footer-content>)
  page.drawRectangle({
    x: 0,
    y: stripeBottomY,
    width,
    height: FOOTER_STRIPE_HEIGHT_PT,
    color: COLOR_RED,
  });

  // Left column
  page.drawText(FOOTER_NOTE_LINE_1, {
    x: FOOTER_TEXT_LEFT_PT,
    y: noteBaselineY,
    size: FOOTER_NOTE_SIZE_PT,
    font: helveticaBold,
    color: COLOR_DARK,
  });
  page.drawText(FOOTER_NOTE_LINE_2, {
    x: FOOTER_TEXT_LEFT_PT,
    y: partialBaselineY,
    size: FOOTER_PARTIAL_SIZE_PT,
    font: helveticaBold,
    color: COLOR_DARK,
  });

  // Right column — right-aligned by measuring rendered text width.
  const addressWidth = helvetica.widthOfTextAtSize(FOOTER_ADDRESS_LINE, FOOTER_ADDRESS_SIZE_PT);
  page.drawText(FOOTER_ADDRESS_LINE, {
    x: width - FOOTER_TEXT_RIGHT_MARGIN_PT - addressWidth,
    y: noteBaselineY,
    size: FOOTER_ADDRESS_SIZE_PT,
    font: helvetica,
    color: COLOR_DARK,
  });
  const phoneWidth = helveticaBold.widthOfTextAtSize(FOOTER_PHONE_LINE, FOOTER_PHONE_SIZE_PT);
  page.drawText(FOOTER_PHONE_LINE, {
    x: width - FOOTER_TEXT_RIGHT_MARGIN_PT - phoneWidth,
    y: partialBaselineY,
    size: FOOTER_PHONE_SIZE_PT,
    font: helveticaBold,
    color: COLOR_DARK,
  });
}
