/**
 * Report Download Route
 * 
 * Single public endpoint that streams PDF reports directly.
 * Pipeline: Snapshot → HTML → Puppeteer → PDF buffer → Stream
 * 
 * No HTML viewer. No file storage. No intermediate website.
 * 
 * Routes:
 * - GET /reports/:token           → Digital PDF (full header/footer, for WhatsApp/patient)
 * - GET /reports/:token?mode=physical → Print PDF (no header/footer, for pre-printed letterhead)
 */

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { validateToken, recordAccess } from '../services/reportAccessService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generatePdfFromHtml } from '../services/pdfGenerationService';

const router = Router();

/**
 * GET /reports/:token
 * Stream PDF report directly — auto-downloads in browser and WhatsApp.
 * 
 * Query params:
 *   ?mode=physical  → PDF for pre-printed letterhead (no header/footer, wider margins)
 *   (default)       → Digital PDF (full header/footer, for WhatsApp/patient download)
 */
router.get('/:token', async (req: Request, res: Response) => {
  const { token } = req.params;
  const mode = req.query.mode === 'physical' ? 'physical' : 'digital';

  try {
    // 1. Validate token
    const reportVersionId = await validateToken(token);

    if (!reportVersionId) {
      return res.status(404).json({ 
        error: 'REPORT_NOT_FOUND',
        message: 'This report link is invalid or has expired.' 
      });
    }

    // 2. Load snapshot (ONLY rendering source — never reads live DB)
    const snapshot = await getReportSnapshot(reportVersionId);

    if (!snapshot) {
      return res.status(403).json({ 
        error: 'REPORT_NOT_AVAILABLE',
        message: 'This report has not been finalized yet.' 
      });
    }

    // 3. Generate QR code as inline base64 data URI (no external API)
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const reportUrl = `${baseUrl}/reports/${token}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, {
      width: 100,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });

    // 4. Render HTML from snapshot
    const profile = mode === 'physical' ? 'pdf-physical' : 'pdf-digital';
    const html = renderReportHtml(snapshot, {
      profile,
      baseUrl,
      qrDataUrl,
    });

    // 5. Generate PDF in-memory via Puppeteer (no file storage)
    const pdfBuffer = await generatePdfFromHtml(html, { mode });

    // 6. Log access (mandatory audit trail)
    await recordAccess(
      token,
      mode === 'physical' ? 'PRINT' : 'DOWNLOAD',
      req.ip,
      req.headers['user-agent'],
    );

    // 7. Stream PDF with auto-download headers
    const billNumber = snapshot.visit?.billNumber || 'unknown';
    const filename = mode === 'physical'
      ? `Report-${billNumber}-print.pdf`
      : `Report-${billNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating report PDF:', error);
    return res.status(500).json({ 
      error: 'GENERATION_FAILED',
      message: 'Failed to generate report PDF. Please try again.' 
    });
  }
});

/**
 * GET /reports/:token/view
 * Returns rendered HTML for in-browser viewing and browser print dialog.
 * Used by staff preview (Patient360) and the Print button.
 */
router.get('/:token/view', async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const reportVersionId = await validateToken(token);

    if (!reportVersionId) {
      return res.status(404).json({ 
        error: 'REPORT_NOT_FOUND',
        message: 'This report link is invalid or has expired.' 
      });
    }

    const snapshot = await getReportSnapshot(reportVersionId);

    if (!snapshot) {
      return res.status(403).json({ 
        error: 'REPORT_NOT_AVAILABLE',
        message: 'This report has not been finalized yet.' 
      });
    }

    // Generate QR code
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const reportUrl = `${baseUrl}/reports/${token}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, {
      width: 100,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });

    const html = renderReportHtml(snapshot, {
      profile: 'screen',
      baseUrl,
      qrDataUrl,
    });

    // If ?print=true, inject auto-print script (avoids cross-origin window.print issues)
    const autoPrint = req.query.print === 'true';
    const finalHtml = autoPrint
      ? html.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>')
      : html;

    // Log access
    await recordAccess(
      token,
      autoPrint ? 'PRINT' : 'VIEW',
      req.ip,
      req.headers['user-agent'],
    );

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(finalHtml);

  } catch (error) {
    console.error('Error generating report HTML view:', error);
    return res.status(500).json({ 
      error: 'GENERATION_FAILED',
      message: 'Failed to generate report view.' 
    });
  }
});

export default router;
