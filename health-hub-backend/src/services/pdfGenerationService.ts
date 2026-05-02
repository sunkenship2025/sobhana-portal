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

let activePdfJobs = 0;
const pendingPdfJobs: Array<() => void> = [];

async function acquirePdfSlot(): Promise<void> {
  if (activePdfJobs < PDF_MAX_CONCURRENT) {
    activePdfJobs += 1;
    return;
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
  try {
    return await task();
  } finally {
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
  printBackground: true,
  preferCSSPageSize: false,
  margin: {
    top: '32mm',    // Header space on pre-printed letterhead
    bottom: '15.5mm', // Footer space on pre-printed letterhead
    left: '15mm',
    right: '15mm',
  },
  displayHeaderFooter: false, // Header/footer handled inside HTML or on the paper stock
};

/**
 * PDF options for digital-first PDFs.
 * Header and footer are rendered inside the HTML so preview and download match.
 */
const DIGITAL_PDF_OPTIONS: PDFOptions = {
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: false,
  margin: {
    top: '0',
    bottom: '0',
    left: '0',
    right: '0',
  },
  displayHeaderFooter: false,
};

export interface PdfGenerationOptions {
  /**
   * Mode: 'physical' for pre-printed letterhead, 'digital' for standalone PDF
   */
  mode: 'physical' | 'digital';
}

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

      const pdfOptions: PDFOptions = options.mode === 'physical'
        ? PHYSICAL_PDF_OPTIONS
        : DIGITAL_PDF_OPTIONS;

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
