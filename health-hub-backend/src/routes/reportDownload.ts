/**
 * Report Download Route
 *
 * Public report access is split into:
 * - GET /reports/:token       → Direct PDF download for patient / WhatsApp browsers
 * - GET /reports/:token/pdf   → Explicit PDF download alias
 * - GET /reports/:token/view  → Rendered HTML view for staff preview / print
 */

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import {
  createRateLimiter,
  getClientIp,
  publicReportIpRateLimit,
  publicReportTokenRateLimit,
} from '../middleware/rateLimit';
import { validateToken, recordAccess } from '../services/reportAccessService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generatePdfFromHtml } from '../services/pdfGenerationService';

const router = Router();

const publicReportLandingIpRateLimit = createRateLimiter({
  namespace: 'public-report-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).send(
      renderStatusPage(
        'Too many requests',
        `This report link is receiving too many requests. Please wait ${retryAfterSeconds} seconds and try again.`
      )
    );
  },
});

const publicReportLandingTokenRateLimit = createRateLimiter({
  namespace: 'public-report-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).send(
      renderStatusPage(
        'Too many requests',
        `Please wait ${retryAfterSeconds} seconds before reopening this report.`
      )
    );
  },
});

type ReportLoadSuccess = {
  ok: true;
  snapshot: any;
};

type ReportLoadFailure = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

type ReportLoadResult = ReportLoadSuccess | ReportLoadFailure;

async function loadReportForToken(token: string): Promise<ReportLoadResult> {
  const reportVersionId = await validateToken(token);

  if (!reportVersionId) {
    return {
      ok: false,
      status: 404,
      error: 'REPORT_NOT_FOUND',
      message: 'This report link is invalid or has expired.',
    };
  }

  const snapshot = await getReportSnapshot(reportVersionId);

  if (!snapshot) {
    return {
      ok: false,
      status: 403,
      error: 'REPORT_NOT_AVAILABLE',
      message: 'This report has not been finalized yet.',
    };
  }

  return {
    ok: true,
    snapshot,
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg-a: #fff6e8;
        --bg-b: #eefbf8;
        --card: rgba(255, 255, 255, 0.92);
        --text: #172033;
        --muted: #5f6b7a;
        --accent: #0f766e;
        --border: rgba(23, 32, 51, 0.1);
        --shadow: 0 28px 80px rgba(23, 32, 51, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.15), transparent 34%),
          radial-gradient(circle at bottom right, rgba(245, 158, 11, 0.18), transparent 30%),
          linear-gradient(135deg, var(--bg-a), var(--bg-b));
      }

      .card {
        width: min(100%, 480px);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 32px 28px;
        background: var(--card);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
        text-align: center;
      }

      .dot {
        width: 16px;
        height: 16px;
        margin: 0 auto 18px;
        border-radius: 999px;
        background: linear-gradient(135deg, #0f766e, #f59e0b);
      }

      h1 {
        margin: 0;
        font-size: clamp(1.7rem, 4vw, 2.2rem);
        line-height: 1.1;
      }

      p {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="dot"></div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

async function buildPdfBuffer(
  req: Request,
  token: string,
  mode: 'physical' | 'digital',
): Promise<ReportLoadFailure | { ok: true; snapshot: any; pdfBuffer: Buffer }> {
  const loaded = await loadReportForToken(token);

  if (!loaded.ok) {
    return loaded;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const reportUrl = `${baseUrl}/reports/${token}`;
  const qrDataUrl = await QRCode.toDataURL(reportUrl, {
    width: 100,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });

  const profile = mode === 'physical' ? 'pdf-physical' : 'pdf-digital';
  const html = renderReportHtml(loaded.snapshot, {
    profile,
    baseUrl,
    qrDataUrl,
  });

  const pdfBuffer = await generatePdfFromHtml(html, { mode });

  return {
    ok: true,
    snapshot: loaded.snapshot,
    pdfBuffer,
  };
}

/**
 * GET /reports/:token
 * Direct digital PDF download for WhatsApp / patient browsers.
 */
router.get('/:token', publicReportLandingIpRateLimit, publicReportLandingTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const result = await buildPdfBuffer(req, token, 'digital');

    if (!result.ok) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(result.status).send(renderStatusPage('Report not available', result.message));
    }

    await recordAccess(
      token,
      'DOWNLOAD',
      req.ip,
      req.headers['user-agent'],
    );

    const billNumber = result.snapshot.visit?.billNumber || 'unknown';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Report-${billNumber}.pdf"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).send(
      renderStatusPage('Report unavailable', 'Failed to generate your report. Please try again.'),
    );
  }
});

/**
 * GET /reports/:token/pdf
 * Explicit PDF download endpoint used by staff-facing download links.
 *
 * Query params:
 *   ?mode=physical  → PDF for pre-printed letterhead (no header/footer, wider margins)
 *   (default)       → Digital PDF (full header/footer, for patient download)
 */
router.get('/:token/pdf', publicReportIpRateLimit, publicReportTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;
  const mode = req.query.mode === 'physical' ? 'physical' : 'digital';

  try {
    const result = await buildPdfBuffer(req, token, mode);

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        message: result.message,
      });
    }

    await recordAccess(
      token,
      mode === 'physical' ? 'PRINT' : 'DOWNLOAD',
      req.ip,
      req.headers['user-agent'],
    );

    const billNumber = result.snapshot.visit?.billNumber || 'unknown';
    const filename = mode === 'physical'
      ? `Report-${billNumber}-print.pdf`
      : `Report-${billNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    return res.status(500).json({
      error: 'GENERATION_FAILED',
      message: 'Failed to generate report PDF. Please try again.',
    });
  }
});

/**
 * GET /reports/:token/view
 * Returns rendered HTML for in-browser viewing and browser print dialog.
 * Used by staff preview (Patient360) and the Print button.
 */
router.get('/:token/view', publicReportIpRateLimit, publicReportTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const loaded = await loadReportForToken(token);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const reportUrl = `${baseUrl}/reports/${token}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, {
      width: 100,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });

    const html = renderReportHtml(loaded.snapshot, {
      profile: 'screen',
      baseUrl,
      qrDataUrl,
    });

    const autoPrint = req.query.print === 'true';
    const finalHtml = autoPrint
      ? html.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>')
      : html;

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
      message: 'Failed to generate report view.',
    });
  }
});

export default router;
