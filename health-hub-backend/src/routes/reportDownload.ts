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
import { patientLinkBlockForReportVersion } from '../services/patientLinkService';
import { collectAtCentrePage, pageShell } from '../lib/publicPageShell';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generateMergedReportPdf } from '../services/mergedReportPdfService';
import { trackLinkAccess } from '../services/linkAccessService';
import { renderStored } from '../services/smartReport/present';
import { smartReportPdf } from '../services/smartReport/pdf';

const router = Router();

const publicReportLandingIpRateLimit = createRateLimiter({
  namespace: 'public-report-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

const publicReportLandingTokenRateLimit = createRateLimiter({
  namespace: 'public-report-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
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
  /** Set only for LINK_DISABLED — the branch whose phone the blocked page shows. */
  branchName?: string;
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

  // Staff switched this visit's online access off (the QR on a printed report
  // reaches this door too).
  const blocked = await patientLinkBlockForReportVersion(reportVersionId);
  if (blocked) {
    return {
      ok: false,
      status: 403,
      error: 'LINK_DISABLED',
      message: 'This report is not available online. Please collect it at the centre.',
      branchName: blocked.branchName,
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

  const pdfBuffer = await generateMergedReportPdf(loaded.snapshot, {
    mode,
    baseUrl,
    qrDataUrl,
    // Public token-gated path serves only finalized snapshots, so caching is
    // safe here. Staff/preview callers leave this off to avoid serving stale
    // bytes for a draft.
    cache: true,
  });

  return {
    ok: true,
    snapshot: loaded.snapshot,
    pdfBuffer,
  };
}

/**
 * GET /reports/:token
 * Public digital PDF view for WhatsApp / patient browsers.
 * Uses inline disposition so in-app browsers open the report reliably.
 */
router.get('/:token', publicReportLandingIpRateLimit, publicReportLandingTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const result = await buildPdfBuffer(req, token, 'digital');

    if (!result.ok) {
      res.setHeader('Cache-Control', 'no-store');
      if (result.error === 'LINK_DISABLED') {
        res.setHeader('Content-Type', 'text/html');
        return res.status(403).send(collectAtCentrePage(result.branchName || ''));
      }
      return res.status(result.status).end();
    }

    await recordAccess(
      token,
      'VIEW',
      req.ip,
      req.headers['user-agent'],
    );
    trackLinkAccess(req, {
      linkType: 'REPORT',
      linkToken: token,
      contextId: result.snapshot.visit?.id,
    }).catch(() => {});

    const billNumber = result.snapshot.visit?.billNumber || 'unknown';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Report-${billNumber}.pdf"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).end();
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

    const autoPrint = req.query.print === 'true';
    const html = renderReportHtml(loaded.snapshot, {
      // Physical print uses pre-printed ledger paper, so auto-print must
      // switch to the letterhead-safe layout without the embedded header/footer.
      profile: autoPrint ? 'pdf-physical' : 'screen',
      baseUrl,
      qrDataUrl,
      // Stamp the moment of this print. Rendered on-demand (no-store), so it's
      // always accurate; only set on the actual print, never the screen view.
      printedAt: autoPrint ? new Date() : undefined,
    });
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

/**
 * Smart Report — patient-facing. Reuses loadReportForToken, so validateToken,
 * the patient-link kill switch, the rate limiters and access logging all apply.
 * Rendered lazily: the PDF browser only starts when someone actually asks.
 */
/**
 * Two paths to the same page. Meta requires a template's dynamic URL variable to
 * be APPENDED TO THE END of the URL, so '/reports/{{1}}/smart' — token in the
 * middle — is rejected outright. '/reports/smart/{{1}}' puts the token last and is
 * accepted. The original path stays: it is already in the gateway page, the staff
 * preview and any link already sent to a patient.
 *
 * Unambiguous against the neighbouring routes: '/smart/ABC' cannot match
 * '/:token/smart' (its second segment would have to be the literal 'smart') and
 * cannot match '/:token' (that is a single segment).
 */
const smartReportPage = async (req: Request, res: Response) => {
  const loaded = await loadReportForToken(req.params.token);
  if (!loaded.ok) {
    res.setHeader('Cache-Control', 'no-store');
    if (loaded.error === 'LINK_DISABLED') {
      return res.status(403).send(collectAtCentrePage(loaded.branchName ?? 'the centre'));
    }
    return res.status(loaded.status).send(pageShell(`<h1>${loaded.message}</h1>`));
  }
  const html = await renderStored(loaded.snapshot.reportVersionId);
  if (!html) return res.status(404).send(pageShell('<h1>No Smart Report is available for this report.</h1>'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
};

router.get('/smart/:token', publicReportLandingIpRateLimit, publicReportLandingTokenRateLimit, smartReportPage);
router.get('/:token/smart', publicReportLandingIpRateLimit, publicReportLandingTokenRateLimit, smartReportPage);

router.get('/:token/smart.pdf', publicReportIpRateLimit, publicReportTokenRateLimit, async (req: Request, res: Response) => {
  const loaded = await loadReportForToken(req.params.token);
  if (!loaded.ok) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(loaded.status).json({ error: loaded.error, message: loaded.message });
  }
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const qrDataUrl = await QRCode.toDataURL(`${baseUrl}/reports/${req.params.token}/smart`, {
    width: 100, margin: 1, color: { dark: '#000000', light: '#ffffff' },
  });
  const html = await renderStored(loaded.snapshot.reportVersionId, qrDataUrl);
  if (!html) return res.status(404).json({ error: 'NO_SMART_REPORT' });

  const pdf = await smartReportPdf(loaded.snapshot.reportVersionId, html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="smart-health-report.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(pdf);
});

export default router;
