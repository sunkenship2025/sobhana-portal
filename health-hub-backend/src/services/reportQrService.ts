/**
 * Report QR Service
 *
 * A bill can carry a QR code that a patient scans to reach their lab report.
 * The QR encodes a stable, token-gated gateway URL (`/r/:token`) that resolves
 * — at scan time — to the finalized report, a partial-report interstitial, or a
 * "reports are being processed" waiting page (see routes/reportGateway.ts).
 *
 * The QR is only shown when the visit will actually produce a patient-facing
 * report. It is suppressed for:
 *   - pure bill-only visits (e.g. a radiology physical scan with no report), and
 *   - visits whose only reportable test was cancelled or closed films-only
 *     (`noReportAt`) — leaving nothing to include in a report.
 *
 * This mirrors getReportInclusionOrders in routes/diagnosticVisits.ts: a QR is
 * shown iff there is ≥1 report-inclusion order (REPORTABLE or EXTERNAL_UPLOAD,
 * excluding cancelled and no-report orders).
 */

import QRCode from 'qrcode';
import { DiagnosticWorkflowMode } from '@prisma/client';
import { createBillAccessToken } from './billAccessService';

type OrderLike = {
  workflowMode?: DiagnosticWorkflowMode | null;
  cancelledAt?: Date | string | null;
  noReportAt?: Date | string | null;
};

/**
 * True when the visit's orders include at least one that contributes to the
 * patient-facing report. Mirrors getReportInclusionOrders (diagnosticVisits.ts).
 */
export function shouldShowReportQr(orders: OrderLike[]): boolean {
  return orders.some(
    (order) =>
      !order.cancelledAt &&
      !order.noReportAt &&
      ((order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE ||
        order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD),
  );
}

export interface ReportQr {
  show: boolean;
  /** The gateway URL the QR encodes (present only when show === true). */
  url?: string;
  /** A base64 PNG data URI of the QR image (present only when show === true). */
  dataUrl?: string;
}

/** The canonical gateway URL a report QR encodes for a given token. */
export function reportGatewayUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/r/${token}`;
}

/** A base64 PNG data URI of the QR image for a gateway URL. */
export function reportGatewayQrDataUrl(baseUrl: string, token: string): Promise<string> {
  return QRCode.toDataURL(reportGatewayUrl(baseUrl, token), {
    width: 160,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * Builds the report-gateway QR for a visit.
 *
 * Pass `existingToken` when a bill access token is already in hand (e.g. the
 * public /bills/view/:token PDF path) to avoid minting a second token; the same
 * token resolves the bill PDF and the report gateway. Otherwise a fresh
 * non-expiring bill access token is minted for the visit.
 *
 * Returns `{ show: false }` when the visit produces no patient-facing report,
 * in which case no QR should be drawn on the bill.
 */
export async function buildReportGatewayQr(params: {
  visitId: string;
  orders: OrderLike[];
  baseUrl: string;
  existingToken?: string;
}): Promise<ReportQr> {
  const { visitId, orders, baseUrl, existingToken } = params;

  if (!shouldShowReportQr(orders)) {
    return { show: false };
  }

  const token = existingToken || (await createBillAccessToken(visitId));
  const url = reportGatewayUrl(baseUrl, token);
  const dataUrl = await reportGatewayQrDataUrl(baseUrl, token);

  return { show: true, url, dataUrl };
}
