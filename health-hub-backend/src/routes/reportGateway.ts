/**
 * Report Gateway Route
 *
 * Public, token-gated landing that a patient reaches by scanning the QR code
 * printed on / sent with their bill. No authentication — the token IS the
 * access control (a bill access token, keyed to the visit).
 *
 *   GET /r/:token
 *     - report fully finalized (visit COMPLETED) → 302 to the report PDF
 *     - report partially released                → branded interstitial:
 *         "X of Y tests ready" + [View ready results] / [Wait for full report]
 *     - nothing finalized yet                     → branded "being processed" page
 *     - visit has no patient-facing report        → branded "no report" page
 *
 *   GET /r/:token?view=ready
 *     - forces the latest finalized (possibly partial) report — used by the
 *       interstitial's "View ready results" button.
 *
 * Rate limiting mirrors reportDownload.ts / billDownload.ts.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import {
  createRateLimiter,
  getClientIp,
} from '../middleware/rateLimit';
import { validateBillToken, recordBillAccess } from '../services/billAccessService';
import { createAccessToken } from '../services/reportAccessService';
import { shouldShowReportQr } from '../services/reportQrService';
import { trackLinkAccess } from '../services/linkAccessService';
import { DiagnosticWorkflowMode } from '@prisma/client';

const router = Router();

// ── Colour logo (base64 data URI, loaded once) ───────────────────────────────
// The patient-facing gateway uses the full-colour logo, not the monochrome
// print logo the bill PDF uses.
let _colorLogo: string | null = null;
function getColorLogoDataUri(): string {
  if (_colorLogo !== null) return _colorLogo;
  const candidates = [
    path.join(__dirname, '../../public/images/sobhana-logo-cropped.png'),
    path.join(__dirname, '../../../public/images/sobhana-logo-cropped.png'),
    path.join(process.cwd(), 'public/images/sobhana-logo-cropped.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _colorLogo = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
      return _colorLogo;
    }
  }
  _colorLogo = '';
  return _colorLogo;
}

// ── Rate limiters ──────────────────────────────────────────────────────────

const gatewayIpRateLimit = createRateLimiter({
  namespace: 'report-gateway-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

const gatewayTokenRateLimit = createRateLimiter({
  namespace: 'report-gateway-token',
  windowMs: 60_000,
  maxRequests: 15,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

// ── Branded HTML pages ───────────────────────────────────────────────────────

// Brand palette (from the logo): red word-mark + steel-blue sub-mark. The app
// itself is a neutral, near-black system, so brand colour is used sparingly.
const PAGE_STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #f5f5f4; color: #1c1917; min-height: 100vh; -webkit-font-smoothing: antialiased;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    background: #fff; border: 1px solid #e7e5e4; border-radius: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03); max-width: 424px; width: 100%; overflow: hidden;
  }
  .head { padding: 38px 32px 0; text-align: center; }
  .logo { height: 48px; object-fit: contain; margin: 0 auto; display: block; }
  .content { padding: 26px 34px 4px; text-align: center; }
  h1 { font-size: 21px; font-weight: 600; letter-spacing: -0.02em; color: #1c1917; margin-bottom: 10px; }
  p { font-size: 15px; line-height: 1.6; color: #57534e; }
  .stat { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; color: #1c5a94; margin: 18px 0 8px; }
  .bar { position: relative; height: 5px; width: 148px; margin: 6px auto 22px; background: #eeecea; border-radius: 999px; overflow: hidden; }
  .bar::after { content: ''; position: absolute; top: 0; left: -40%; width: 40%; height: 100%; background: #1c5a94; border-radius: 999px; animation: slide 1.4s cubic-bezier(0.4,0,0.2,1) infinite; }
  @keyframes slide { 0% { left: -40%; } 100% { left: 108%; } }
  .actions { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
  .btn {
    display: block; width: 100%; padding: 13px 16px; border-radius: 11px;
    font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; border: 1px solid transparent;
  }
  .btn-primary { background: #1c1917; color: #fff; }
  .btn-secondary { background: #fff; color: #44403c; border-color: #e7e5e4; }
  .link { display: inline-block; margin-top: 18px; font-size: 13.5px; font-weight: 500; color: #1c5a94; text-decoration: none; }
  .foot { margin-top: 28px; border-top: 1px solid #f0efed; padding: 15px 20px 17px; text-align: center; }
  .foot .name { font-size: 10.5px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; color: #78716c; }
  .foot .meta { font-size: 11px; color: #b5b0aa; margin-top: 4px; }
`;

function pageShell(bodyHtml: string, extraHead = ''): string {
  const logo = getColorLogoDataUri();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <title>Your Report • Sobhana Diagnostic Centre</title>
  <style>${PAGE_STYLE}</style>
  ${extraHead}
</head>
<body>
  <div class="card">
    <div class="head">
      ${logo ? `<img class="logo" src="${logo}" alt="Sobhana Diagnostic Centre" />` : ''}
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
    <div class="foot">
      <div class="name">Sobhana Diagnostic Centre</div>
      <div class="meta">Secure report link &middot; please don't share it</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * "Being processed" page. Instead of a full-page auto-refresh (which re-sends
 * the whole page, logo and all, on every abandoned tab), it polls a tiny JSON
 * status endpoint on a bounded schedule and only navigates when the state
 * actually advances — keeping server load negligible.
 *
 * @param advance  'ready'          → only advance when the FULL report is ready
 *                                     (the patient chose to wait for everything)
 *                 'partialOrReady' → advance as soon as anything is ready
 */
function waitingPage(token: string, advance: 'ready' | 'partialOrReady'): string {
  const script = `<script>
(function(){
  var t=${JSON.stringify(token)}, adv=${JSON.stringify(advance)};
  var INTERVAL=60000, MAX=15, n=0;
  function go(){ window.location.href='/r/'+t; }
  function poll(){
    n++;
    fetch('/r/'+t+'/status',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){
      if(j && (j.state==='ready' || (adv==='partialOrReady' && j.state==='partial'))){ go(); return; }
      if(n<MAX){ setTimeout(poll, INTERVAL); }
    }).catch(function(){ if(n<MAX){ setTimeout(poll, INTERVAL); } });
  }
  setTimeout(poll, INTERVAL);
})();
</script>`;
  return pageShell(
    `<h1>Your report is being prepared</h1>
     <div class="bar" aria-hidden="true"></div>
     <p>Your tests are still being processed and your report is on its way. This page updates on its own the moment it's ready.</p>
     <a class="link" href="/r/${token}">Check now</a>`,
    script,
  );
}

function partialPage(token: string, readyCount: number, totalCount: number): string {
  const statLine =
    readyCount > 0 && readyCount < totalCount
      ? `<div class="stat">${readyCount} of ${totalCount} tests ready</div>`
      : `<div class="stat">Some tests ready</div>`;
  return pageShell(
    `<h1>Your report is partly ready</h1>
     ${statLine}
     <p>Some of your tests are complete. The rest are still being processed and will appear here once they're done.</p>
     <div class="actions">
       <a class="btn btn-primary" href="/r/${token}?view=ready">View ready results now</a>
       <a class="btn btn-secondary" href="/r/${token}?mode=wait">Wait for the full report</a>
     </div>`,
  );
}

function noReportPage(): string {
  return pageShell(
    `<h1>No report for this bill</h1>
     <p>The tests on this bill don't have a digital report to view. They may be scans or films you collected in person. If you were expecting a report, please contact the centre.</p>`,
  );
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /r/:token/status
 * Tiny JSON the waiting page polls. Deliberately cheap: one indexed read, no
 * logo/HTML, no access-log write — so an open tab polling every minute is
 * negligible load. States: waiting | partial | ready | none | invalid.
 */
router.get(
  '/:token/status',
  gatewayIpRateLimit,
  gatewayTokenRateLimit,
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const visitId = await validateBillToken(req.params.token);
      if (!visitId) return res.json({ state: 'invalid' });

      const visit = await prisma.visit.findUnique({
        where: { id: visitId },
        select: {
          status: true,
          testOrders: {
            select: { workflowMode: true, cancelledAt: true, noReportAt: true },
          },
          report: {
            select: {
              versions: { where: { status: 'FINALIZED' }, select: { id: true }, take: 1 },
            },
          },
        },
      });

      if (!visit) return res.json({ state: 'invalid' });
      if (!shouldShowReportQr(visit.testOrders)) return res.json({ state: 'none' });

      const hasFinalized = (visit.report?.versions?.length ?? 0) > 0;
      if (visit.status === 'COMPLETED' && hasFinalized) return res.json({ state: 'ready' });
      if (hasFinalized) return res.json({ state: 'partial' });
      return res.json({ state: 'waiting' });
    } catch (error) {
      // On error, tell the poller to keep waiting rather than surfacing a fault.
      return res.json({ state: 'waiting' });
    }
  },
);

router.get(
  '/:token',
  gatewayIpRateLimit,
  gatewayTokenRateLimit,
  async (req: Request, res: Response) => {
    const { token } = req.params;
    const wantsReady = req.query.view === 'ready';
    const wantsWait = req.query.mode === 'wait';

    try {
      const visitId = await validateBillToken(token);
      if (!visitId) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).send(pageShell('<h1>Link not found</h1><p>This link is invalid or has expired.</p>'));
      }

      const visit = await prisma.visit.findUnique({
        where: { id: visitId },
        select: {
          status: true,
          testOrders: {
            select: {
              id: true,
              workflowMode: true,
              cancelledAt: true,
              noReportAt: true,
            },
          },
          report: {
            select: {
              versions: {
                where: { status: 'FINALIZED' },
                orderBy: { versionNum: 'desc' },
                select: { id: true },
              },
            },
          },
        },
      });

      // Best-effort access log; never block the page on it.
      recordBillAccess(token, req.ip).catch(() => {});
      trackLinkAccess(req, { linkType: 'REPORT', linkToken: token, contextId: visitId }).catch(() => {});

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store');

      if (!visit) {
        return res.status(404).send(pageShell('<h1>Link not found</h1><p>This link is invalid or has expired.</p>'));
      }

      const inclusionOrders = visit.testOrders.filter(
        (o) =>
          !o.cancelledAt &&
          !o.noReportAt &&
          ((o.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
            DiagnosticWorkflowMode.REPORTABLE ||
            o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD),
      );

      // No patient-facing report on this visit (pure bill-only / all cancelled
      // or films-only). A QR shouldn't have been printed, but resolve gracefully.
      if (inclusionOrders.length === 0) {
        return res.send(noReportPage());
      }

      const finalizedVersions = visit.report?.versions ?? [];
      const latestFinalizedId = finalizedVersions[0]?.id ?? null;

      // Fully done → hand off to the finalized report PDF. A short-lived report
      // access token reuses the existing, well-tested public report path (incl.
      // access log). The auto-refreshing waiting page lands here once complete.
      if (visit.status === 'COMPLETED' && latestFinalizedId) {
        const reportToken = await createAccessToken(latestFinalizedId);
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, `/reports/${reportToken}`);
      }

      // Nothing finalized yet → "being processed" page. It advances as soon as
      // anything is ready (partial or full).
      if (!latestFinalizedId) {
        return res.send(waitingPage(token, 'partialOrReady'));
      }

      // Partial release below (some tests finalized, visit still open).

      // Patient chose "View ready results" → the latest partial report.
      if (wantsReady) {
        const reportToken = await createAccessToken(latestFinalizedId);
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, `/reports/${reportToken}`);
      }

      // Patient chose "Wait for the full report" → processing page that only
      // advances once the FULL report is ready.
      if (wantsWait) {
        return res.send(waitingPage(token, 'ready'));
      }

      const inclusionIds = inclusionOrders.map((o) => o.id);
      const finalizedVersionIds = finalizedVersions.map((v) => v.id);
      const readyResults = await prisma.testResult.findMany({
        where: {
          reportVersionId: { in: finalizedVersionIds },
          testOrderId: { in: inclusionIds },
        },
        select: { testOrderId: true },
        distinct: ['testOrderId'],
      });
      const readyCount = readyResults.length;

      return res.send(partialPage(token, readyCount, inclusionOrders.length));
    } catch (error) {
      console.error('Error resolving report gateway:', error);
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).send(pageShell('<h1>Something went wrong</h1><p>Please try scanning again in a moment.</p>'));
    }
  },
);

export default router;
