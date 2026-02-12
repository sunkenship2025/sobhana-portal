/**
 * E3-10: Report Access Routes
 * 
 * Public routes for viewing and downloading diagnostic reports.
 * These routes are accessed via unique tokens (no authentication required).
 * 
 * Routes:
 * - GET /r/:token - View report in browser (HTML)
 * - GET /r/:token/pdf - Download report as PDF
 * - GET /r/:token/pdf/physical - Download PDF optimized for pre-printed letterhead
 */

import { Router, Request, Response } from 'express';
import { validateToken, recordAccess } from '../services/reportAccessService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generateReportPdf } from '../services/pdfGenerationService';

const router = Router();

/**
 * GET /r/:token
 * View report in browser (HTML)
 */
router.get('/:token', async (req: Request, res: Response) => {
  const { token } = req.params;
  
  try {
    // Validate token
    const reportVersionId = await validateToken(token);
    
    if (!reportVersionId) {
      return res.status(404).send(renderErrorPage('Report Not Found', 
        'This report link is invalid or has expired. Please contact Sobhana Diagnostics for assistance.'));
    }

    // Get snapshot
    const snapshot = await getReportSnapshot(reportVersionId);
    
    if (!snapshot) {
      return res.status(404).send(renderErrorPage('Report Not Available',
        'The report data is not available. Please contact Sobhana Diagnostics.'));
    }

    // Record access
    await recordAccess(
      token,
      'VIEW',
      req.ip,
      req.headers['user-agent'],
    );

    // Get base URL for resources
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Render HTML
    const html = renderReportHtml(snapshot, {
      mode: 'screen',
      baseUrl,
      reportToken: token,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(html);

  } catch (error) {
    console.error('Error rendering report:', error);
    return res.status(500).send(renderErrorPage('Error',
      'An error occurred while loading the report. Please try again.'));
  }
});

/**
 * GET /r/:token/pdf
 * Download report as PDF (digital version)
 */
router.get('/:token/pdf', async (req: Request, res: Response) => {
  const { token } = req.params;
  
  try {
    // Validate token
    const reportVersionId = await validateToken(token);
    
    if (!reportVersionId) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Record download
    await recordAccess(
      token,
      'DOWNLOAD',
      req.ip,
      req.headers['user-agent'],
    );

    // Get base URL for resources
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Generate PDF
    const pdfBuffer = await generateReportPdf(reportVersionId, {
      mode: 'digital',
      baseUrl,
    });

    // Get patient name for filename
    const snapshot = await getReportSnapshot(reportVersionId);
    const patientName = snapshot?.patient?.name?.replace(/[^a-zA-Z0-9]/g, '_') || 'report';
    const billNumber = snapshot?.visit?.billNumber || 'unknown';
    const filename = `${patientName}_${billNumber}_report.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating PDF:', error);
    return res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

/**
 * GET /r/:token/pdf/physical
 * Download PDF optimized for pre-printed letterhead
 */
router.get('/:token/pdf/physical', async (req: Request, res: Response) => {
  const { token } = req.params;
  
  try {
    // Validate token
    const reportVersionId = await validateToken(token);
    
    if (!reportVersionId) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Record print
    await recordAccess(
      token,
      'PRINT',
      req.ip,
      req.headers['user-agent'],
    );

    // Get base URL for resources
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Generate PDF with physical print settings
    const pdfBuffer = await generateReportPdf(reportVersionId, {
      mode: 'physical',
      baseUrl,
    });

    // Get patient name for filename
    const snapshot = await getReportSnapshot(reportVersionId);
    const patientName = snapshot?.patient?.name?.replace(/[^a-zA-Z0-9]/g, '_') || 'report';
    const billNumber = snapshot?.visit?.billNumber || 'unknown';
    const filename = `${patientName}_${billNumber}_print.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating physical PDF:', error);
    return res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

/**
 * GET /r/:token/preview
 * Preview report in iframe-friendly format (no action buttons)
 */
router.get('/:token/preview', async (req: Request, res: Response) => {
  const { token } = req.params;
  
  try {
    const reportVersionId = await validateToken(token);
    
    if (!reportVersionId) {
      return res.status(404).send('Report not found');
    }

    const snapshot = await getReportSnapshot(reportVersionId);
    
    if (!snapshot) {
      return res.status(404).send('Report not available');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const html = renderReportHtml(snapshot, {
      mode: 'screen',
      baseUrl,
      hideActions: true, // No download/print buttons
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (error) {
    console.error('Error previewing report:', error);
    return res.status(500).send('Error loading report');
  }
});

/**
 * Helper: Render error page
 */
function renderErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Sobhana Diagnostics</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .error-container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      padding: 40px;
      text-align: center;
      max-width: 400px;
    }
    .error-icon {
      width: 60px;
      height: 60px;
      background: #fee2e2;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .error-icon svg {
      width: 30px;
      height: 30px;
      color: #dc2626;
    }
    h1 {
      color: #1f2937;
      font-size: 1.5rem;
      margin-bottom: 10px;
    }
    p {
      color: #6b7280;
      line-height: 1.6;
    }
    .contact {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
    }
    .contact a {
      color: #2563eb;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    </div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="contact">
      <p>Contact: <a href="tel:+919876543210">+91 98765 43210</a></p>
    </div>
  </div>
</body>
</html>`;
}

export default router;
