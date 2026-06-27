/**
 * Statement View Route (public)
 *
 * Token-gated, no-auth read access to a payout statement for the WhatsApp link
 * sent to referral doctors / clinics / diagnostic centers / outside labs.
 * The token IS the access control. Mirrors billDownload.ts / reportDownload.ts:
 * the link points straight at the BACKEND and a viewable document is served
 * inline (opens directly in WhatsApp's in-app browser). There is no statement
 * PDF renderer, so we serve a self-contained styled HTML page.
 *
 *   GET /statements/view/:token  → text/html (rendered statement)
 */

import { Router, Request, Response } from 'express';
import { createRateLimiter, getClientIp } from '../middleware/rateLimit';
import { validateStatementToken, recordStatementAccess } from '../services/statementAccessService';
import {
  getPayoutDetail,
  buildPayoutStatementDetail,
  type PayoutStatement,
  type StatementBand,
} from '../services/payoutService';

const router = Router();

const ipRateLimit = createRateLimiter({
  namespace: 'public-statement-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

const tokenRateLimit = createRateLimiter({
  namespace: 'public-statement-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}
function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}
function fmtDate(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

function docTitle(s: PayoutStatement): string {
  return s.isLab ? 'Outside Lab Statement' : 'Payout Statement';
}

function bandRows(band: StatementBand, isLab: boolean): string {
  return band.rows
    .map((r) => {
      const loss = (r.centerMarginInPaise ?? 0) < 0;
      if (isLab) {
        return `<tr>
          <td>${fmtDate(r.date)}</td>
          <td>${esc(r.patientName)}</td>
          <td>${esc(r.testOrFee)}</td>
          <td>${esc(r.basisLabel)}</td>
          <td class="r">${rupees(r.pAmtInPaise)}</td>
          <td class="r b">${rupees(r.finAmtInPaise)}</td>
          <td class="r ${loss ? 'loss' : ''}">${rupees(r.centerMarginInPaise ?? 0)}${loss ? ' ⚠' : ''}</td>
        </tr>`;
      }
      return `<tr>
        <td>${fmtDate(r.date)}</td>
        <td>${esc(r.billNumber)}</td>
        <td>${esc(r.patientTitle ? r.patientTitle + ' ' : '')}${esc(r.patientName)}</td>
        <td>${esc(r.testOrFee)} <span class="mut">(${esc(r.basisLabel)})</span></td>
        <td class="r">${rupees(r.tAmtInPaise)}</td>
        <td class="r">${rupees(r.discInPaise)}</td>
        <td class="r">${rupees(r.pAmtInPaise)}</td>
        <td class="r b">${rupees(r.finAmtInPaise)}</td>
      </tr>`;
    })
    .join('');
}

function renderStatementHtml(s: PayoutStatement): string {
  const isLab = s.isLab;
  const head = isLab
    ? `<th>Date</th><th>Patient</th><th>Test</th><th>Rate</th><th class="r">Price</th><th class="r">Payable</th><th class="r">Margin</th>`
    : `<th>Date</th><th>Bill #</th><th>Patient</th><th>Test / fee</th><th class="r">T Amt</th><th class="r">Disc</th><th class="r">P Amt</th><th class="r">Payable</th>`;

  const bands = s.bands
    .map(
      (band) => `
      <div class="band">
        <div class="band-h"><span>${esc(band.label)}</span><span>${rupees(band.subtotal.finAmtInPaise)}</span></div>
        <div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${bandRows(band, isLab)}</tbody></table></div>
      </div>`
    )
    .join('');

  const margin =
    isLab && s.lab
      ? `<div class="margin">Centre margin: patient price ${rupees(s.lab.billedToPatientInPaise)} − lab cost ${rupees(s.lab.vendorCostInPaise)} = <b>${rupees(s.lab.marginInPaise)}</b> (${s.lab.marginPct}%)</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(s.payeeName)} — ${esc(docTitle(s))}</title>
<style>
  :root{ --ink:#1F1F1E; --mut:#5F5E5A; --tert:#888780; --border:rgba(0,0,0,.12); --amber:#854F0B; --green:#0F6E56; --red:#A32D2D; }
  *{box-sizing:border-box}
  body{margin:0;background:#FAFAF8;color:var(--ink);font:14px/1.45 -apple-system,Segoe UI,Roboto,Inter,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:860px;margin:0 auto;padding:18px 14px 48px}
  .lh{text-align:center;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:16px}
  .lh img{height:48px}
  .title{font-weight:700;letter-spacing:.1em;margin-top:6px;font-size:12px}
  .card{background:#fff;border:.5px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px}
  .row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
  .name{font-size:16px;font-weight:600}
  .sub{font-size:12px;color:var(--tert);margin-top:2px}
  .amt{font-size:24px;font-weight:600;text-align:right}
  .amt.lab{color:var(--amber)}
  .statusline{border-top:.5px solid var(--border);margin-top:12px;padding-top:10px;font-size:13px}
  .st-paid{color:var(--green);font-weight:600}
  .st-pend{color:var(--amber);font-weight:600}
  .paid{font-size:12px;color:var(--tert);margin-top:4px}
  .band{background:#fff;border:.5px solid var(--border);border-radius:12px;margin-bottom:14px;overflow:hidden}
  .band-h{display:flex;justify-content:space-between;background:#f6f5f2;padding:8px 12px;font-size:12px;font-weight:600}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:12px;min-width:560px}
  th{text-align:left;color:var(--tert);font-weight:400;padding:6px 8px;border-bottom:.5px solid var(--border)}
  td{padding:6px 8px;border-top:.5px solid var(--border)}
  .r{text-align:right;font-variant-numeric:tabular-nums}
  .b{font-weight:600}
  .mut{color:var(--tert)}
  .loss{color:var(--red);font-weight:600}
  .gt{background:#1F1F1E;color:#fff;border-radius:12px;padding:12px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px}
  .gt .x{color:#bdbbb3}
  .gt .tot{margin-left:auto;font-size:15px}
  .margin{background:#fff;border:.5px solid var(--border);border-radius:12px;padding:12px;margin-top:14px;font-size:13px}
  .foot{text-align:center;margin-top:20px;font-size:11px;color:var(--tert)}
</style></head>
<body><div class="wrap">
  <div class="lh"><img src="/images/sobhana-clinic-logo.png" alt="Sobhana"/><div class="title">${esc(docTitle(s))}</div></div>
  <div class="card">
    <div class="row">
      <div><div class="name">${esc(s.payeeName)}</div><div class="sub">Period ${fmtDate(s.periodStartDate)} – ${fmtDate(s.periodEndDate)} · Branch ${esc(s.branchName) || '—'}</div></div>
      <div><div class="sub">${isLab ? 'Payable' : 'Total payout'}</div><div class="amt ${isLab ? 'lab' : ''}">${rupees(s.grandTotal.finAmtInPaise)}</div></div>
    </div>
  </div>
  ${bands}
  <div class="gt"><span class="b">GRAND TOTAL</span><span class="x">|</span><span>T Amt <b>${rupees(s.grandTotal.tAmtInPaise)}</b></span><span>Disc <b>${rupees(s.grandTotal.discInPaise)}</b></span><span>P Amt <b>${rupees(s.grandTotal.pAmtInPaise)}</b></span><span class="tot">Payable <b>${rupees(s.grandTotal.finAmtInPaise)}</b></span></div>
  ${margin}
  <div class="foot">Sobhana Diagnostics · This statement was shared with you securely.</div>
</div></body></html>`;
}

router.get(
  '/:token',
  ipRateLimit,
  tokenRateLimit,
  async (req: Request, res: Response) => {
    const { token } = req.params;
    try {
      const payoutId = await validateStatementToken(token);
      if (!payoutId) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).send('Statement not found');
      }
      const detail = await getPayoutDetail(payoutId);
      if (!detail) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).send('Statement not found');
      }
      const statement = buildPayoutStatementDetail(detail);
      await recordStatementAccess(token, req.ip);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(renderStatementHtml(statement));
    } catch (error) {
      console.error('Public statement view error:', error);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).send('Failed to load statement');
    }
  },
);

export default router;
