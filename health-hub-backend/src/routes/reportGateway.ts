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
import prisma from '../lib/prisma';
import { pageShell, collectAtCentrePage } from '../lib/publicPageShell';
import {
  createRateLimiter,
  getClientIp,
} from '../middleware/rateLimit';
import { validateBillToken, recordBillAccess } from '../services/billAccessService';
import { createAccessToken } from '../services/reportAccessService';
import { shouldShowReportQr } from '../services/reportQrService';
import { trackLinkAccess } from '../services/linkAccessService';
import { patientLinkBlock } from '../services/patientLinkService';
import { DiagnosticWorkflowMode } from '@prisma/client';

const router = Router();

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
      if(j && (j.state==='ready' || j.state==='disabled' || (adv==='partialOrReady' && j.state==='partial'))){ go(); return; }
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
      if (await patientLinkBlock(visitId)) return res.json({ state: 'disabled' });

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

      // Staff switched this visit's online access off — say where to collect it
      // instead, and never reveal the reason.
      const blocked = await patientLinkBlock(visitId);
      if (blocked) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).send(collectAtCentrePage(blocked.branchName));
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

        // A Smart Report exists -> offer both documents rather than jumping
        // straight to the PDF. Zero Meta dependency: the choice lives here.
        const smart = await prisma.smartReport.findUnique({
          where: { reportVersionId: latestFinalizedId },
          select: { status: true },
        });
        if (smart?.status === 'READY') {
          return res.send(smartChoicePage(reportToken));
        }
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

/** Two doors: the plain-language Smart Report, or the full signed lab report. */
function smartChoicePage(token: string): string {
  return pageShell(`
    <h1>Your report is ready</h1>
    <p>We have prepared two documents for you.</p>
    <a class="btn" href="/reports/${token}/smart">Your Smart Health Report</a>
    <a class="btn secondary" href="/reports/${token}">Full laboratory report (PDF)</a>
    <p class="muted">The Smart Health Report explains your results in plain language.
      Your signed laboratory report remains the official document.</p>
  `);
}

export default router;
