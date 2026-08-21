/**
 * Bill PDF Service
 *
 * Generates a PDF of the bill receipt that looks exactly like the printed
 * BillReceipt.tsx component. Uses Puppeteer (via pdfGenerationService) to
 * render server-side HTML → PDF.
 *
 * The logo is loaded from the local filesystem and embedded as a base64 data
 * URI so Puppeteer's domcontentloaded strategy can display it without making
 * outbound HTTP requests.
 *
 * Layout mirrors BillReceipt.tsx exactly:
 *   1. Header   — logo, branch name, address, phone, "Requisition cum Receipt"
 *   2. Patient  — 3-column grid (Bill No/Patient Name/Referred By | Age/Sex/Phone | Payment/Date/Time)
 *   3. Items    — S.No / Investigation / Price table
 *   4. Footer   — Authorized Signatory (left) + totals (right)
 *   5. Revisit  — (clinic only) 7-day revisit note
 *   6. Trust    — "computer generated invoice"
 */

import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { buildBillFinancialResponse } from './billFinancialService';
import { buildDiagnosticBillItems } from './billItemService';
import { generatePdfFromHtml } from './pdfGenerationService';
import {
  billPdfCacheKeyFor,
  getCachedBillPdf,
  setCachedBillPdf,
} from './billPdfCache';
import { getPatientAgeDisplay } from '../utils/validation';
import { shouldShowReportQr, reportGatewayQrDataUrl } from './reportQrService';
import { createBillAccessToken } from './billAccessService';

// ============================================================================
// LOGO — loaded once, embedded as base64 data URI
// ============================================================================

let _logoDataUri: string | null = null;

export function getLogoDataUri(): string {
  if (_logoDataUri) return _logoDataUri;

  // Path: <project-root>/public/images/sobhana-clinic-logo.png
  // __dirname is dist/services/ in production, src/services/ in dev (ts-node)
  const possiblePaths = [
    path.join(__dirname, '../../public/images/sobhana-clinic-logo.png'),
    path.join(__dirname, '../../../public/images/sobhana-clinic-logo.png'),
    path.join(process.cwd(), 'public/images/sobhana-clinic-logo.png'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p);
      _logoDataUri = `data:image/png;base64,${data.toString('base64')}`;
      return _logoDataUri;
    }
  }

  // Fallback: empty — logo won't render but PDF still generates
  _logoDataUri = '';
  return _logoDataUri;
}

// ============================================================================
// HELPERS
// ============================================================================

function fmt(n: number): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getBranchAddress(branchName: string): string {
  const lower = branchName.toLowerCase();
  if (lower.includes('kidcare') || lower.includes('gutta')) {
    return '10-84, opp. I.D.P.L. Colony, Balanagar, Hyderabad, Telangana 500037';
  }
  if (lower.includes('balanagar')) {
    return 'Shop No.3-67, Shobhana Complex, opposite to Hal Gate-1, Balanagar, Hyderabad, Telangana 500042';
  }
  // Default (Chintal)
  return '#4-8-261/3 & 14/NR, Beside Ridge Towers, IDPL, Surya Nagar, Chintal, Hyd - 500037.';
}

function getBranchPhone(branchName: string): string {
  const lower = branchName.toLowerCase();
  if (lower.includes('balanagar')) {
    return '040 23772929, 040 40163301.';
  }
  // Default
  return '040-23089999, 9490539006.';
}

function formatPatientName(title: string | null | undefined, name: string): string {
  const safeName = name ?? 'Unknown';
  const displayName = safeName.toUpperCase();
  const titleMap: Record<string, string> = {
    MR: 'Mr.',
    MRS: 'Mrs.',
    MS: 'Ms.',
    MASTER: 'Master',
    BABY: 'Baby',
  };
  const prefix = title ? (titleMap[title] ?? title) : '';
  return prefix ? `${prefix} ${displayName}` : displayName;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// DATA FETCHING
// (mirrors the query in routes/bills.ts verbatim)
// ============================================================================

export interface BillData {
  visit: {
    id: string;
    billNumber: string | null;
    visitRef: string;
    hasBill: boolean;
    domain: 'CLINIC' | 'DIAGNOSTICS';
    createdAt: Date;
    totalAmount: number;
    discountType?: string | null;
    discountPercentage?: number | null;
    discountAmountInPaise?: number;
    paidAmountInPaise?: number;
    netAmountInPaise?: number;
    dueAmountInPaise?: number;
    visitType?: string;
    tokenNumber?: number | null;
    isRevisit?: boolean;
    originalBillNumber?: string | null;
    originalVisitDate?: Date | null;
    paymentStatus?: string | null;
    transactions?: Array<{ paymentType?: string | null }>;
  };
  patient: {
    name: string;
    title?: string | null;
    ageDisplay: string;
    gender: string;
    phone: string;
  };
  branch: { name: string };
  doctor?: { name: string } | null;
  referralDoctor?: { name: string } | null;
  items: Array<{ id: string; name: string; price: number }>;
  /** True when this visit produces a patient-facing report (→ show the report QR). */
  showReportQr: boolean;
}

export async function fetchBillData(visitId: string, domain: 'CLINIC' | 'DIAGNOSTICS'): Promise<BillData | null> {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, domain },
    include: {
      patient: {
        include: { identifiers: true },
      },
      branch: true,
      bill: { include: { transactions: true } },
      testOrders: {
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        include: { test: true, product: true },
      },
      referrals: { where: { deletedAt: null }, include: { referralDoctor: true } },
      clinicVisit: { include: { clinicDoctor: true } },
    },
  });

  if (!visit) return null;

  const phone =
    visit.patient.identifiers.find((id) => id.type === 'PHONE')?.value || '';
  const hasReferralDoctor = visit.referrals.length > 0;

  // Fetch original visit if revisit
  let originalVisitSummary: { billNumber: string | null; createdAt: Date | null } | null = null;
  if (domain === 'CLINIC' && visit.clinicVisit?.originalVisitId) {
    const orig = await prisma.visit.findUnique({
      where: { id: visit.clinicVisit.originalVisitId },
      select: { createdAt: true, bill: { select: { billNumber: true } } },
    });
    originalVisitSummary = {
      billNumber: orig?.bill?.billNumber || null,
      createdAt: orig?.createdAt || null,
    };
  }

  const billFinancials = buildBillFinancialResponse(visit.bill);
  const ageDisplay = getPatientAgeDisplay(
    visit.patient.dateOfBirth,
    visit.patient.yearOfBirth,
    visit.patient.ageUnit,
  );

  // Build items
  let items: Array<{ id: string; name: string; price: number }> = [];
  if (domain === 'DIAGNOSTICS') {
    items = buildDiagnosticBillItems(
      visit.testOrders
        .filter((o) => !o.cancelledAt)
        .map((o) => ({
        id: o.id,
        productId: o.productId,
        product: o.product ? { id: o.product.id, name: o.product.name, code: o.product.code } : null,
        testName: o.testNameSnapshot || o.test.name,
        testCode: o.testCodeSnapshot || o.test.code,
        priceInPaise: o.priceInPaise,
        referralCommissionType: hasReferralDoctor ? o.referralCommissionType : undefined,
        referralCommissionPercentage: hasReferralDoctor ? o.referralCommissionPercentage : undefined,
        referralCommissionAmountInPaise: hasReferralDoctor ? o.referralCommissionAmountInPaise : undefined,
      })),
    );
  } else if (visit.clinicVisit) {
    const isRevisit = visit.clinicVisit.isRevisit ?? false;
    const visitType = visit.clinicVisit.visitType;
    const svcName = visitType === 'IP' ? 'IP Consultation' : 'OP Consultation';
    items = [
      {
        id: visit.id,
        name: isRevisit ? `${svcName} (Revisit)` : svcName,
        price: visit.clinicVisit.consultationFeeInPaise / 100,
      },
    ];
  }

  return {
    visit: {
      id: visit.id,
      billNumber: visit.bill?.billNumber || null,
      visitRef: visit.billNumber,
      hasBill: Boolean(visit.bill),
      paymentStatus: visit.bill?.paymentStatus || (visit as any).paymentStatus || null,
      transactions: visit.bill?.transactions || [],
      domain,
      createdAt: visit.createdAt,
      // See routes/bills.ts: subtract reversed (cancelled-order) charge so a
      // cancel+add doesn't double-count the cancelled test's price in Total.
      totalAmount:
        (visit.totalAmountInPaise - (visit.bill?.reversedChargeInPaise ?? 0)) / 100,
      ...billFinancials,
      visitType: visit.clinicVisit?.visitType,
      tokenNumber: visit.clinicVisit?.tokenNumber ?? null,
      isRevisit: visit.clinicVisit?.isRevisit ?? false,
      originalBillNumber: originalVisitSummary?.billNumber || null,
      originalVisitDate: originalVisitSummary?.createdAt || null,
    },
    patient: {
      name: visit.patient.name,
      title: visit.patient.title,
      ageDisplay,
      gender: visit.patient.gender,
      phone,
    },
    branch: { name: visit.branch.name },
    doctor: visit.clinicVisit?.clinicDoctor
      ? { name: visit.clinicVisit.clinicDoctor.name }
      : null,
    referralDoctor: visit.referrals[0]?.referralDoctor
      ? { name: visit.referrals[0].referralDoctor.name }
      : null,
    items,
    // Only diagnostics visits produce a report; clinic consultations never do.
    showReportQr: domain === 'DIAGNOSTICS' && shouldShowReportQr(visit.testOrders),
  };
}

// ============================================================================
// HTML RENDERER
// ============================================================================

export function renderBillHtml(
  data: BillData,
  opts?: { reportQrDataUrl?: string },
): string {
  const logoUri = getLogoDataUri();
  const isDiagnostic = data.visit.domain === 'DIAGNOSTICS';
  const reportQrDataUrl = data.showReportQr ? opts?.reportQrDataUrl : undefined;

  // ── Date & Time ──
  const dateObj = new Date(data.visit.createdAt);
  const dateStr = dateObj.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeStr = dateObj.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  // ── Patient display ──
  const patientNameFormatted = escapeHtml(
    formatPatientName(data.patient.title, data.patient.name),
  );
  const genderFull =
    data.patient.gender === 'M' ? 'MALE' : data.patient.gender === 'F' ? 'FEMALE' : 'OTHER';

  // ── Document number ──
  const hasBill = data.visit.hasBill !== false;
  const documentNumberLabel = hasBill ? 'Bill No' : 'Visit Ref';
  const documentNumberValue = escapeHtml(
    hasBill
      ? data.visit.billNumber || data.visit.visitRef || '—'
      : data.visit.visitRef || data.visit.billNumber || '—',
  );

  // ── Financial ──
  const subtotalAmount = data.visit.totalAmount ?? 0;
  const discountAmountInPaise = (data.visit.discountAmountInPaise ?? 0);
  const discountAmount = discountAmountInPaise / 100;
  const netAmount =
    data.visit.netAmountInPaise !== undefined
      ? data.visit.netAmountInPaise / 100
      : Math.max(0, subtotalAmount - discountAmount);
  const paidAmount =
    data.visit.paidAmountInPaise !== undefined
      ? data.visit.paidAmountInPaise / 100
      : data.visit.paymentStatus === 'PAID'
      ? netAmount
      : 0;
  const dueAmount =
    data.visit.dueAmountInPaise !== undefined
      ? data.visit.dueAmountInPaise / 100
      : Math.max(0, netAmount - paidAmount);

  // ── Payment (status + method) ──
  // Distinct methods actually used across the payment ledger (CASH / ONLINE / CHEQUE).
  const paymentMethodLabel = Array.from(
    new Set(
      (data.visit.transactions || [])
        .map((t) => (t.paymentType || '').toString().toUpperCase())
        .filter(Boolean),
    ),
  ).join(' + ');
  const paymentStatusWord = (() => {
    const raw = ((data.visit.paymentStatus as string) || '').toUpperCase();
    if (raw.includes('REFUND')) return 'REFUNDED';
    if (paidAmount > 0 && dueAmount > 0) return 'PARTIAL'; // partly paid, balance due
    if (raw.includes('PAID') || (paidAmount > 0 && dueAmount <= 0)) return 'PAID';
    return 'PENDING';
  })();
  // e.g. "PAID | CASH", "PARTIAL | CASH + ONLINE", or just "PENDING" when nothing paid.
  const paymentSummary = !hasBill
    ? 'Not billed'
    : paymentMethodLabel
      ? `${paymentStatusWord} | ${paymentMethodLabel}`
      : paymentStatusWord;

  const discountLabel =
    data.visit.discountType === 'PERCENTAGE' && data.visit.discountPercentage != null
      ? `Disc. Amount (${data.visit.discountPercentage}%)`
      : 'Disc. Amount';

  // ── Referred by / Doctor ──
  const referredBy = escapeHtml(data.referralDoctor?.name?.trim() || 'SELF');
  const doctorDisplay = data.doctor?.name
    ? escapeHtml(
        data.doctor.name.toLowerCase().startsWith('dr')
          ? data.doctor.name
          : `Dr. ${data.doctor.name}`,
      )
    : '—';

  // ── OP queue token badge (top-left) — doctor initials + per-doctor number ──
  let tokenHtml = '';
  if (!isDiagnostic && data.visit.tokenNumber != null && data.doctor?.name) {
    const parts = data.doctor.name
      .replace(/^\s*dr\.?\s*/i, '')
      .trim()
      .split(/\s+/);
    const initials =
      parts.length === 0 || !parts[0]
        ? 'DR'
        : parts.length === 1
          ? parts[0].slice(0, 2).toUpperCase()
          : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    const tokenLabel = `${initials}-${String(data.visit.tokenNumber).padStart(2, '0')}`;
    tokenHtml = `
      <div style="position:absolute; top:6px; left:10px; line-height:1; text-align:left;">
        <div style="font-size:9px; font-weight:700; letter-spacing:1.5px;">TOKEN NO</div>
        <div style="font-size:20px; font-weight:800;">${escapeHtml(tokenLabel)}</div>
      </div>`;
  }

  // ── Address ──
  const branchAddress = escapeHtml(getBranchAddress(data.branch.name));
  const branchPhone = escapeHtml(getBranchPhone(data.branch.name));
  const branchNameDisplay = escapeHtml(data.branch.name.toUpperCase());

  // ── Items rows ──
  const itemsHtml = data.items
    .map(
      (item, i) => `
      <div style="display:flex; padding:3px 16px; font-size:12px;">
        <div style="width:50px;">${i + 1}</div>
        <div style="flex:1;">${escapeHtml(item.name)}</div>
        <div style="width:100px; text-align:right; font-variant-numeric:tabular-nums;">${fmt(item.price)}</div>
      </div>`,
    )
    .join('');

  // ── Revisit note (clinic only) ──
  const revisitNote =
    !isDiagnostic && hasBill
      ? `<div style="border-top:1px solid black; padding:4px 16px;">
          <p style="font-size:10px; margin:0;">
            <strong>Note:</strong>
            <em>This receipt is valid for a free revisit within 7 days from the date of issue for the same complaint with the same consultant. Please carry this bill for the follow-up visit.</em>
          </p>
        </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bill ${documentNumberValue}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      line-height: 1.3;
      color: #000;
      background: #fff;
    }
    @page {
      margin: 8mm 8mm 8mm 8mm;
    }
    .bill-wrap {
      width: 100%;
      max-width: 90%;
      margin: 8px auto 0;
      border: 1px solid black;
      background: #fff;
      position: relative;
    }
    .report-qr {
      position: absolute;
      top: 6px;
      right: 12px;
      text-align: center;
      width: 62px;
    }
    .report-qr img { width: 58px; height: 58px; display: block; }
    .report-qr .qr-caption { font-size: 8px; line-height: 1.1; margin-top: 2px; }
    .section { border-bottom: 1px solid black; }
    .header { padding: 6px 16px 4px; text-align: center; }
    .header img { height: 40px; object-fit: contain; display: block; margin: 0 auto 4px; }
    .header .branch-name { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 2px; }
    .header .address { font-size: 10px; }
    .header .phone { font-size: 10px; }
    .header .receipt-title { font-size: 11px; font-weight: 600; margin-top: 2px; }
    .patient-grid { padding: 4px 16px; }
    .patient-grid table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .patient-grid td { padding: 0; vertical-align: top; white-space: nowrap; }
    .patient-grid .label { display: inline-block; width: 100px; }
    .patient-grid .patient-name { font-weight: 600; }
    .items-header {
      display: flex;
      padding: 4px 16px;
      font-size: 12px;
      font-weight: bold;
      border-bottom: 1px solid black;
    }
    .items-body { min-height: 30px; }
    .split-footer { display: flex; font-size: 12px; }
    .footer-left {
      width: 50%;
      border-right: 1px solid black;
      padding: 6px 16px;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }
    .footer-left .signatory { text-align: center; margin-top: 64px; }
    .footer-right {
      width: 50%;
      padding: 6px 16px;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }
    .total-row { display: flex; justify-content: space-between; }
    .trust-footer { border-top: 1px solid black; padding: 2px 16px; text-align: center; }
    .trust-footer p { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0; }
  </style>
</head>
<body>
  <div class="bill-wrap">
    ${tokenHtml}

    <!-- 1. HEADER -->
    <div class="section header">
      ${
        reportQrDataUrl
          ? `<div class="report-qr"><img src="${reportQrDataUrl}" alt="Scan for your report" /><div class="qr-caption">Scan for your report</div></div>`
          : ''
      }
      ${logoUri ? `<img src="${logoUri}" alt="Sobhana" />` : ''}
      <div class="branch-name">${branchNameDisplay}</div>
      <div class="address">${branchAddress}</div>
      <div class="phone">Phone : ${branchPhone}</div>
      <div class="receipt-title">Requisition cum Receipt</div>
    </div>

    <!-- 2. PATIENT DETAILS -->
    <div class="section patient-grid">
      <table>
        <tbody>
          <tr>
            <td style="padding-right:16px;">
              <div style="display:flex;">
                <span class="label">${documentNumberLabel}</span>
                <span>: ${documentNumberValue}</span>
              </div>
            </td>
            <td style="padding:0 16px; white-space:nowrap;">
              <span style="display:inline-block;width:50px;">Age</span>
              <span>: ${escapeHtml(data.patient.ageDisplay)}</span>
            </td>
            <td style="text-align:right; white-space:nowrap;">
              <span>Payment : ${paymentSummary}</span>
            </td>
          </tr>
          <tr>
            <td style="padding-right:16px;">
              <div style="display:flex;">
                <span class="label">Patient Name</span>
                <span class="patient-name">: ${patientNameFormatted}</span>
              </div>
            </td>
            <td style="padding:0 16px; white-space:nowrap;">
              <span style="display:inline-block;width:50px;">Sex</span>
              <span>: ${genderFull}</span>
            </td>
            <td style="text-align:right; white-space:nowrap;">
              <span>Date : ${dateStr}</span>
            </td>
          </tr>
          <tr>
            <td style="padding-right:16px;">
              <div style="display:flex;">
                <span class="label">${isDiagnostic ? 'Referred by' : 'Doctor'}</span>
                <span>: ${isDiagnostic ? referredBy : doctorDisplay}</span>
              </div>
            </td>
            <td style="padding:0 16px; white-space:nowrap;">
              <span style="display:inline-block;width:50px;">Phone</span>
              <span>: ${escapeHtml(data.patient.phone || 'N/A')}</span>
            </td>
            <td style="text-align:right; white-space:nowrap;">
              <span>Time : ${timeStr}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 3. ITEMS TABLE -->
    <div class="section">
      <div class="items-header">
        <div style="width:50px;">S.No</div>
        <div style="flex:1;">${isDiagnostic ? 'Investigation' : 'Service Description'}</div>
        <div style="width:100px; text-align:right;">Price</div>
      </div>
      <div class="items-body">
        ${itemsHtml}
      </div>
    </div>

    <!-- 4. SPLIT FOOTER -->
    <div class="split-footer">
      <div class="footer-left">
        <div class="signatory">Authorized Signatory</div>
      </div>
      <div class="footer-right">
        <div class="total-row"><span>Total Amount</span><span style="font-variant-numeric:tabular-nums;">: ${fmt(subtotalAmount)}</span></div>
        <div class="total-row"><span>Paid Amount</span><span style="font-variant-numeric:tabular-nums;">: ${fmt(paidAmount)}</span></div>
        ${
          discountAmount > 0
            ? `<div class="total-row"><span>${discountLabel}</span><span style="font-variant-numeric:tabular-nums;">: ${fmt(discountAmount)}</span></div>`
            : ''
        }
        ${
          dueAmount > 0
            ? `<div class="total-row" style="font-weight:bold;"><span>Due Amount</span><span style="font-variant-numeric:tabular-nums;">: ${fmt(dueAmount)}</span></div>`
            : ''
        }
      </div>
    </div>

    <!-- 5. REVISIT NOTE (clinic only) -->
    ${revisitNote}

    <!-- 6. TRUST FOOTER -->
    <div class="trust-footer">
      <p>* This is a computer generated invoice *</p>
    </div>

  </div>
</body>
</html>`;
}

// ============================================================================
// PDF GENERATION
// ============================================================================

/**
 * Generates a PDF buffer for a bill identified by visitId + domain.
 * Returns null if the visit/bill is not found.
 *
 * When `opts.baseUrl` is provided and the visit produces a patient-facing
 * report, a "Scan for your report" QR is embedded in the header. Pass
 * `opts.token` (e.g. the bill access token from /bills/view/:token) to reuse an
 * existing token instead of minting a new one — the same token resolves both
 * the bill PDF and the report gateway.
 */
export async function generateBillPdf(
  visitId: string,
  domain: 'CLINIC' | 'DIAGNOSTICS',
  opts?: { baseUrl?: string; token?: string },
): Promise<{ pdfBuffer: Buffer; billData: BillData } | null> {
  const billData = await fetchBillData(visitId, domain);
  if (!billData) return null;

  let reportQrDataUrl: string | undefined;
  if (billData.showReportQr && opts?.baseUrl) {
    const token = opts.token || (await createBillAccessToken(visitId));
    reportQrDataUrl = await reportGatewayQrDataUrl(opts.baseUrl, token);
  }

  const html = renderBillHtml(billData, { reportQrDataUrl });

  // Content-addressed cache: the key is a hash of the exact HTML, so any change
  // to the bill (data OR template) yields a new key and re-renders automatically
  // — no invalidation call to remember. A hit skips the Chromium render entirely
  // (the app's main memory driver), which is the point on repeat patient views.
  const cacheHash = billPdfCacheKeyFor(html);
  const cached = await getCachedBillPdf(cacheHash);
  if (cached) {
    return { pdfBuffer: cached, billData };
  }

  const pdfBuffer = await generatePdfFromHtml(html, { mode: 'bill' });
  void setCachedBillPdf(cacheHash, pdfBuffer);

  return { pdfBuffer, billData };
}
