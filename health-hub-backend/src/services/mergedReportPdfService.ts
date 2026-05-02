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
 */

import { PDFDocument } from 'pdf-lib';
import { renderReportHtml } from './reportRendererService';
import { generatePdfFromHtml } from './pdfGenerationService';
import { getObject } from './r2StorageService';
import type {
  ExternalUploadSnapshot,
  ReportSnapshot,
} from './reportSnapshotService';

// A4 in PDF points (1pt = 1/72in). Used to size the rendered overlay PNGs.
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

// Visual heights of the overlay strips. Tuned to match the report's own header/footer.
const HEADER_OVERLAY_PT = 80;
const FOOTER_OVERLAY_PT = 32;

interface OverlayAssets {
  headerPng: Buffer;
  footerPng: Buffer;
}

let cachedOverlay: OverlayAssets | null = null;
let overlayInflight: Promise<OverlayAssets> | null = null;

/**
 * Builds the inline overlay HTML used to capture header/footer PNGs.
 * Rendered once via Puppeteer at A4 width; the resulting buffers are reused
 * for every uploaded PDF page.
 */
function buildOverlayHtml(baseUrl: string, qrDataUrl: string | null): string {
  const logoSrc = `${baseUrl}/images/sobhana-logo-cropped.png`;
  // Width matches A4 at 96dpi: 595.28pt / 72 * 96 ≈ 793.7px. Round to 794.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; background: white; width: 794px; }
  .header {
    background: white;
    padding: 0;
    width: 100%;
  }
  .header-logo-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 20px 4px 20px;
  }
  .header-logo { height: 55px; width: auto; }
  .header-qr { display: flex; align-items: center; gap: 6px; }
  .header-qr-img { width: 40px; height: 40px; }
  .header-qr-text {
    font-size: 7pt;
    color: #4a5568;
    line-height: 1.3;
    text-align: center;
  }
  .header-stripe-band {
    height: 10px;
    background: repeating-linear-gradient(
      to bottom,
      #1f3e6e 0px, #1f3e6e 2px,
      white 2px, white 4px,
      #1f3e6e 4px, #1f3e6e 6px,
      white 6px, white 8px,
      #1f3e6e 8px, #1f3e6e 10px
    );
  }
  .footer {
    background: white;
    width: 100%;
    font-size: 7.5pt;
    color: #333;
  }
  .footer-stripe { height: 2px; background: #cc2222; }
  .footer-content {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 6px 24px 8px;
  }
  .footer-left .note-text { font-weight: bold; font-size: 7pt; margin-bottom: 1px; }
  .footer-left .partial-text { font-weight: bold; text-transform: uppercase; font-size: 6.5pt; }
  .footer-right { text-align: right; }
  .footer-right .address-text { font-weight: 500; font-size: 7pt; margin-bottom: 1px; }
  .footer-right .phone-text { font-weight: 600; font-size: 7.5pt; }
  #header-shot, #footer-shot { background: white; }
</style>
</head>
<body>
  <div id="header-shot">
    <header class="header">
      <div class="header-logo-row">
        <img src="${logoSrc}" alt="Sobhana Diagnostic Centre" class="header-logo" />
        ${qrDataUrl ? `
        <div class="header-qr">
          <img src="${qrDataUrl}" alt="QR" class="header-qr-img" />
          <div class="header-qr-text">Scan to<br>download</div>
        </div>
        ` : ''}
      </div>
      <div class="header-stripe-band"></div>
    </header>
  </div>
  <div id="footer-shot">
    <footer class="footer">
      <div class="footer-stripe"></div>
      <div class="footer-content">
        <div class="footer-left">
          <div class="note-text">Note : This report is subject to the terms and conditions overleaf.</div>
          <div class="partial-text">Partial reproduction of this report is not permitted.</div>
        </div>
        <div class="footer-right">
          <div class="address-text">Balanagar : # 3-67, Sobhana Complex, Balanagar, Hyderabad-500042.</div>
          <div class="phone-text">Ph : 040-2377 2929, 4016 3301</div>
        </div>
      </div>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Renders the overlay HTML once and screenshots the header & footer regions
 * to PNG buffers. Cached for the lifetime of the process.
 */
async function getOverlayAssets(baseUrl: string, qrDataUrl: string | null): Promise<OverlayAssets> {
  if (cachedOverlay) return cachedOverlay;
  if (overlayInflight) return overlayInflight;

  overlayInflight = (async () => {
    // Lazy import to avoid pulling Puppeteer into modules that don't need it.
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 794, height: 1200, deviceScaleFactor: 2 });
      await page.setContent(buildOverlayHtml(baseUrl, qrDataUrl), { waitUntil: 'networkidle0' });

      const headerHandle = await page.$('#header-shot');
      const footerHandle = await page.$('#footer-shot');
      if (!headerHandle || !footerHandle) {
        throw new Error('Overlay HTML rendered without header/footer regions');
      }

      const headerPng = (await headerHandle.screenshot({
        type: 'png',
        omitBackground: false,
      })) as Buffer;
      const footerPng = (await footerHandle.screenshot({
        type: 'png',
        omitBackground: false,
      })) as Buffer;

      cachedOverlay = { headerPng, footerPng };
      return cachedOverlay;
    } finally {
      await browser.close();
    }
  })();

  try {
    return await overlayInflight;
  } finally {
    overlayInflight = null;
  }
}

export interface GenerateMergedPdfOptions {
  mode: 'physical' | 'digital';
  baseUrl: string;
  qrDataUrl: string;
}

/**
 * The single writer for the patient-facing PDF.
 *
 * Flow:
 *   1. Render base report HTML → PDF via existing pipeline.
 *   2. If snapshot.externalUploads is empty, return that buffer unchanged.
 *   3. Otherwise: load base PDF into pdf-lib, fetch each upload from R2,
 *      copy its pages, overlay Sobhana header & footer on every appended page.
 */
export async function generateMergedReportPdf(
  snapshot: ReportSnapshot,
  options: GenerateMergedPdfOptions
): Promise<Buffer> {
  const { mode, baseUrl, qrDataUrl } = options;

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
    return basePdf;
  }

  const merged = await PDFDocument.load(basePdf);
  const overlay = await getOverlayAssets(baseUrl, qrDataUrl);
  const headerImage = await merged.embedPng(overlay.headerPng);
  const footerImage = await merged.embedPng(overlay.footerPng);

  for (const upload of uploads) {
    try {
      await appendUploadWithOverlay(merged, upload, headerImage, footerImage);
    } catch (err: any) {
      console.error(
        `[mergedReportPdfService] Skipping upload ${upload.uploadId} after error:`,
        err?.message,
      );
      // Continue with other uploads rather than failing the whole report.
    }
  }

  const out = await merged.save();
  return Buffer.from(out);
}

async function appendUploadWithOverlay(
  merged: PDFDocument,
  upload: ExternalUploadSnapshot,
  headerImage: Awaited<ReturnType<PDFDocument['embedPng']>>,
  footerImage: Awaited<ReturnType<PDFDocument['embedPng']>>,
): Promise<void> {
  const buf = await getObject(upload.r2Key);
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });

  const indices = src.getPageIndices();
  const copied = await merged.copyPages(src, indices);

  for (const page of copied) {
    merged.addPage(page);
    const { width, height } = page.getSize();

    // Use A4 references when the page is unusually small/large to keep the strip
    // proportional. Strip width always matches the page width.
    const headerH = (HEADER_OVERLAY_PT * width) / A4_WIDTH_PT;
    const footerH = (FOOTER_OVERLAY_PT * width) / A4_WIDTH_PT;

    page.drawImage(headerImage, {
      x: 0,
      y: height - headerH,
      width: width,
      height: headerH,
    });
    page.drawImage(footerImage, {
      x: 0,
      y: 0,
      width: width,
      height: footerH,
    });

    // Suppress unused var warning when A4_HEIGHT_PT isn't read; kept for future tuning.
    void A4_HEIGHT_PT;
  }
}
