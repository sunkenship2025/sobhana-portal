/**
 * E3-10: PDF Generation Service
 * 
 * Uses Puppeteer to generate PDF from HTML template.
 * PDF is generated on-demand, not stored permanently.
 * 
 * In Docker (Render), uses system Chromium via PUPPETEER_EXECUTABLE_PATH.
 * Locally, uses Puppeteer's bundled Chrome.
 */

import puppeteer, { Browser, PDFOptions } from 'puppeteer';

// Singleton browser instance for performance
let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

const DEFAULT_PDF_CONCURRENCY = 2;
const PDF_MAX_CONCURRENT = Math.min(
  2,
  Math.max(
    1,
    Number.parseInt(
      process.env.PDF_MAX_CONCURRENT || `${DEFAULT_PDF_CONCURRENCY}`,
      10,
    ) || DEFAULT_PDF_CONCURRENCY,
  ),
);

// Max queued (waiting) jobs. Past this we reject fast with 503 rather than
// piling up indefinitely — without a cap, a Chrome hang or burst would OOM.
const PDF_MAX_QUEUE = Math.max(
  4,
  Number.parseInt(process.env.PDF_MAX_QUEUE || '50', 10) || 50,
);

// Hard timeout per render. If Puppeteer hangs (it occasionally does on Render
// with large images), the slot is released and the next job runs instead of
// blocking the queue forever.
const PDF_JOB_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.PDF_JOB_TIMEOUT_MS || '60000', 10) || 60_000,
);

export class PdfServiceOverloadedError extends Error {
  statusCode = 503;
  error = 'PDF_SERVICE_OVERLOADED';
  constructor() {
    super('PDF service queue is full — try again shortly');
  }
}

export class PdfJobTimeoutError extends Error {
  statusCode = 504;
  error = 'PDF_JOB_TIMEOUT';
  constructor() {
    super('PDF generation timed out');
  }
}

let activePdfJobs = 0;
const pendingPdfJobs: Array<() => void> = [];

async function acquirePdfSlot(): Promise<void> {
  if (activePdfJobs < PDF_MAX_CONCURRENT) {
    activePdfJobs += 1;
    return;
  }

  if (pendingPdfJobs.length >= PDF_MAX_QUEUE) {
    throw new PdfServiceOverloadedError();
  }

  await new Promise<void>((resolve) => {
    pendingPdfJobs.push(() => {
      activePdfJobs += 1;
      resolve();
    });
  });
}

function releasePdfSlot(): void {
  activePdfJobs = Math.max(0, activePdfJobs - 1);
  const nextJob = pendingPdfJobs.shift();
  if (nextJob) {
    nextJob();
  }
}

async function withPdfSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquirePdfSlot();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PdfJobTimeoutError()), PDF_JOB_TIMEOUT_MS);
    });
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    releasePdfSlot();
  }
}

/**
 * Gets or creates the browser instance.
 * Uses PUPPETEER_EXECUTABLE_PATH if set (Docker with system Chromium),
 * otherwise falls back to Puppeteer's bundled Chrome (local dev).
 */
async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }

  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  const launchOptions: any = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      // '--single-process' removed: causes crashes on macOS and Linux
    ],
  };

  // Docker sets PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const launchPromise = puppeteer.launch(launchOptions).then((browser) => {
    browserInstance = browser;
    browser.on('disconnected', () => {
      if (browserInstance === browser) {
        browserInstance = null;
      }
    });
    return browser;
  });

  browserLaunchPromise = launchPromise;

  try {
    return await launchPromise;
  } finally {
    if (browserLaunchPromise === launchPromise) {
      browserLaunchPromise = null;
    }
  }
}

/**
 * PDF options for physical printing on pre-printed letterhead.
 * Margins match the real paper stock measurements.
 */
const PHYSICAL_PDF_OPTIONS: PDFOptions = {
  format: 'A4',
  printBackground: false, // No background tint on physical paper — keeps prints crisp white
  preferCSSPageSize: false,
  margin: {
    top: '32mm',    // Header space on pre-printed letterhead
    bottom: '22mm', // Footer space on pre-printed letterhead (real band is 2.2cm)
    left: '15mm',
    right: '15mm',
  },
  displayHeaderFooter: false, // Header/footer handled inside HTML or on the paper stock
};

/**
 * Digital footer is drawn by Puppeteer on every page so it can never be
 * pushed off-page by content overflow. Inline styles only — Puppeteer's
 * footer template is rendered in an isolated context and ignores document CSS.
 * Default font-size in that context is ~0; explicit pt values are required.
 */
const DIGITAL_FOOTER_TEMPLATE = `
<div style="font-family: Helvetica, Arial, sans-serif; width: 100%; color: #333; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;">
  <div style="height: 2px; background: #cc2222; width: 100%;"></div>
  <div style="display: flex; justify-content: space-between; padding: 4px 24px 0 24px; box-sizing: border-box;">
    <div style="max-width: 50%;">
      <div style="font-weight: bold; font-size: 7pt; margin-bottom: 1px;">This is an electronically authenticated report.</div>
      <div style="font-weight: bold; text-transform: uppercase; font-size: 6.5pt;">Partial reproduction of this report is not permitted.</div>
    </div>
    <div style="text-align: right; max-width: 50%;">
      <div style="font-weight: 500; font-size: 7pt; margin-bottom: 1px;">Balanagar : # 3-67, Sobhana Complex, Balanagar, Hyderabad-500042.</div>
      <div style="font-weight: 600; font-size: 7.5pt;">Ph : 040-2377 2929, 4016 3301</div>
    </div>
  </div>
</div>`;

/**
 * PDF options for digital-first PDFs.
 * Header is drawn inline; footer is drawn by Puppeteer at every page bottom
 * (margin.bottom reserves the space) so content overflow can't orphan it.
 */
const DIGITAL_PDF_OPTIONS: PDFOptions = {
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: false,
  margin: {
    top: '0',
    bottom: '12mm',
    left: '0',
    right: '0',
  },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: DIGITAL_FOOTER_TEMPLATE,
};

export interface PdfGenerationOptions {
  /**
   * Mode: 'physical' for pre-printed letterhead, 'digital' for standalone PDF, 'bill' for raw bill prints
   */
  mode: 'physical' | 'digital' | 'bill';
  /**
   * Digital-only: overrides the Puppeteer page-bottom footer template. Used to
   * inject the per-branch address/phone footer (see renderDigitalFooterHtml).
   * Ignored for 'physical' (footer is on the letterhead) and 'bill'.
   */
  footerTemplate?: string;
}

const BILL_PDF_OPTIONS: PDFOptions = {
  width: '794px', // A4 width at 96dpi (210mm)
  printBackground: true,
  preferCSSPageSize: true, // respects @page { margin }
  displayHeaderFooter: false,
};

/**
 * Generates PDF directly from HTML string.
 * Useful for testing or custom templates.
 */
export async function generatePdfFromHtml(
  html: string,
  options: PdfGenerationOptions = { mode: 'digital' }
): Promise<Buffer> {
  return withPdfSlot(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      const mediaType = options.mode === 'digital' ? 'screen' : 'print';
      await page.emulateMediaType(mediaType);

      // ASSUMES all assets are inlined (logo as base64 data URI, signatures as
      // data URIs, CSS as inline <style>). If anyone later adds an external
      // <img src="https://..."> or <link rel="stylesheet"> to the report HTML,
      // switch back to 'networkidle0' or this asset will render blank.
      await page.setContent(html, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const pdfOptions: PDFOptions =
        options.mode === 'physical'
          ? { ...PHYSICAL_PDF_OPTIONS }
          : options.mode === 'bill'
          ? { ...BILL_PDF_OPTIONS }
          : { ...DIGITAL_PDF_OPTIONS, footerTemplate: options.footerTemplate ?? DIGITAL_FOOTER_TEMPLATE };

      if (options.mode === 'bill') {
        const bodyHeight = await page.evaluate('document.documentElement.offsetHeight') as number;
        // We add about 16mm (approx 60px) to account for top/bottom margins of the page
        pdfOptions.height = `${bodyHeight + 60}px`;
      }

      const pdfBuffer = await page.pdf(pdfOptions);
      return Buffer.from(pdfBuffer);
    } finally {
      if (!page.isClosed()) {
        await page.close().catch(() => undefined);
      }
    }
  });
}

/**
 * Cleans up browser instance.
 * Call on server shutdown.
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
  browserLaunchPromise = null;
}

/**
 * Health check for PDF service.
 */
export async function checkPdfServiceHealth(): Promise<boolean> {
  try {
    return withPdfSlot(async () => {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setContent('<html><body>Health Check</body></html>');
        const pdf = await page.pdf({ format: 'A4' });
        return pdf.length > 0;
      } finally {
        if (!page.isClosed()) {
          await page.close().catch(() => undefined);
        }
      }
    });
  } catch (error) {
    console.error('PDF service health check failed:', error);
    return false;
  }
}

/**
 * Pre-warms the browser instance.
 * Call on server startup for faster first PDF generation.
 */
export async function warmupPdfService(): Promise<void> {
  try {
    await getBrowser();
    console.log(`PDF service warmed up (max concurrency: ${PDF_MAX_CONCURRENT})`);
  } catch (error) {
    console.error('Failed to warmup PDF service:', error);
  }
}

/**
 * Peek at the cached browser state without triggering a launch — used by the
 * /health probe so it doesn't accidentally cold-start Chrome on every poll.
 */
export function getPdfServiceStatus():
  | { state: 'connected'; maxConcurrent: number }
  | { state: 'not-warmed' }
  | { state: 'disconnected' } {
  if (!browserInstance) return { state: 'not-warmed' };
  if (browserInstance.isConnected()) {
    return { state: 'connected', maxConcurrent: PDF_MAX_CONCURRENT };
  }
  return { state: 'disconnected' };
}
