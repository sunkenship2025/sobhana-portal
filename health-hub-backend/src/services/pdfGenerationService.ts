/**
 * E3-10: PDF Generation Service
 * 
 * Uses Puppeteer to generate PDF from HTML template.
 * PDF is generated on-demand, not stored permanently.
 */

import puppeteer, { Browser, PDFOptions } from 'puppeteer';
import { renderReportHtml } from './reportRendererService';
import { getReportSnapshot } from './reportSnapshotService';
import path from 'path';

// Singleton browser instance for performance
let browserInstance: Browser | null = null;

/**
 * Gets or creates the browser instance.
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browserInstance;
}

/**
 * PDF Options matching print CSS specifications.
 * Margins match pre-printed letterhead requirements.
 */
const PDF_OPTIONS: PDFOptions = {
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: false,
  margin: {
    top: '32mm',    // Header space on pre-printed letterhead
    bottom: '15.5mm', // Footer space on pre-printed letterhead
    left: '15mm',
    right: '15mm',
  },
  displayHeaderFooter: false, // Header/footer handled in template or pre-printed
};

/**
 * PDF options for digital-first PDF (includes header/footer in content).
 */
const PDF_OPTIONS_DIGITAL: PDFOptions = {
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: false,
  margin: {
    top: '10mm',
    bottom: '10mm',
    left: '10mm',
    right: '10mm',
  },
  displayHeaderFooter: false,
};

export interface PdfGenerationOptions {
  /** 
   * Mode: 'physical' for pre-printed letterhead, 'digital' for standalone PDF 
   */
  mode: 'physical' | 'digital';
  
  /**
   * Optional: Base URL for resolving relative paths (CSS, images)
   */
  baseUrl?: string;
}

/**
 * Generates PDF from a report version ID.
 * Returns the PDF as a Buffer.
 */
export async function generateReportPdf(
  reportVersionId: string,
  options: PdfGenerationOptions = { mode: 'digital' }
): Promise<Buffer> {
  // 1. Get snapshot data
  const snapshot = await getReportSnapshot(reportVersionId);
  
  if (!snapshot) {
    throw new Error(`Snapshot not found for report ${reportVersionId}`);
  }

  // 2. Render HTML
  const renderMode = options.mode === 'physical' ? 'print' : 'screen';
  const html = renderReportHtml(snapshot, { 
    mode: renderMode,
    baseUrl: options.baseUrl,
    includePdfStyles: true,
  });

  // 3. Generate PDF
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set content with base URL for resource resolution
    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Select PDF options based on mode
    const pdfOptions = options.mode === 'physical' 
      ? PDF_OPTIONS 
      : PDF_OPTIONS_DIGITAL;

    // Generate PDF
    const pdfBuffer = await page.pdf(pdfOptions);

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

/**
 * Generates PDF directly from HTML string.
 * Useful for testing or custom templates.
 */
export async function generatePdfFromHtml(
  html: string,
  options: PdfGenerationOptions = { mode: 'digital' }
): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const pdfOptions = options.mode === 'physical' 
      ? PDF_OPTIONS 
      : PDF_OPTIONS_DIGITAL;

    const pdfBuffer = await page.pdf(pdfOptions);
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
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
}

/**
 * Health check for PDF service.
 */
export async function checkPdfServiceHealth(): Promise<boolean> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setContent('<html><body>Health Check</body></html>');
    const pdf = await page.pdf({ format: 'A4' });
    await page.close();
    return pdf.length > 0;
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
    console.log('PDF service warmed up');
  } catch (error) {
    console.error('Failed to warmup PDF service:', error);
  }
}
