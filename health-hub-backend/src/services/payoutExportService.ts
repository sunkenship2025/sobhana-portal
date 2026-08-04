/**
 * Excel export for payouts.
 *
 * Two workbooks:
 *   - buildPayoutAggregateWorkbook(rows)   — the pay-run, one row per doctor
 *   - buildSinglePayoutWorkbook(detail)    — one doctor's statement (per bill)
 *
 * Format conventions:
 *   - Indian rupee number format (#,##,##0.00)
 *   - Dates as dd-mmm-yyyy
 *   - Bold + frozen header row
 *   - Currency stored as a number (rupees, not paise) so Excel sums work
 */
import ExcelJS from 'exceljs';
import { PayoutDetail } from './payoutService';

export interface PayoutAggregateRow {
  doctorName: string;
  doctorType: string;
  amountInPaise: number;
}

const RUPEE_FMT = '#,##,##0.00';
const DATE_FMT = 'dd-mmm-yyyy';

function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

function formatDoctorType(t: string): string {
  if (t === 'REFERRAL') return 'Referral';
  if (t === 'CLINIC') return 'Clinic';
  if (t === 'DIAGNOSTIC_CENTER') return 'Diagnostic Center';
  return t;
}

function formatPeriod(start: Date | string, end: Date | string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameMonth =
    s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth();
  const month = s.toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (sameMonth) return month;
  return `${s.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })} – ${e.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}

/**
 * Pay-run workbook: ONE row per doctor for the whole period (matches the
 * grouped worklist — no per-day duplicate rows, no dormant paid/status columns).
 */
export async function buildPayoutAggregateWorkbook(
  rows: PayoutAggregateRow[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sobhana Diagnostics';
  wb.created = new Date();

  const ws = wb.addWorksheet('Pay-Run', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Payee', key: 'doctorName', width: 32 },
    { header: 'Type', key: 'doctorType', width: 20 },
    { header: 'Amount (₹)', key: 'amount', width: 16, style: { numFmt: RUPEE_FMT } },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  for (const r of rows) {
    ws.addRow({
      doctorName: r.doctorName,
      doctorType: formatDoctorType(r.doctorType),
      amount: paiseToRupees(r.amountInPaise),
    });
  }

  // Totals row
  if (rows.length > 0) {
    const total = rows.reduce((sum, r) => sum + r.amountInPaise, 0);
    const lastRow = ws.addRow({
      doctorName: `${rows.length} payees`,
      doctorType: '',
      amount: paiseToRupees(total),
    });
    lastRow.font = { bold: true };
    lastRow.getCell('amount').numFmt = RUPEE_FMT;
  }

  ws.getColumn('amount').alignment = { horizontal: 'right' };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * Collapse a payout's line items into one row per bill (a bill with several
 * tests becomes a single row whose Investigation lists them). Amount is the
 * post-discount price; Ref is the referral commission.
 */
function groupLineItemsByBill(payout: PayoutDetail) {
  const map = new Map<
    string,
    {
      date: Date;
      billNumber: string;
      patient: string;
      tests: string[];
      amountInPaise: number;
      refInPaise: number;
    }
  >();
  for (const li of payout.lineItems) {
    const key = `${li.billNumber}|${li.patientName}`;
    let g = map.get(key);
    if (!g) {
      g = {
        date: new Date(li.date),
        billNumber: li.billNumber,
        patient: `${li.patientTitle ? li.patientTitle + ' ' : ''}${li.patientName}`,
        tests: [],
        amountInPaise: 0,
        refInPaise: 0,
      };
      map.set(key, g);
    }
    g.tests.push(li.testOrFee);
    g.amountInPaise += li.amountInPaise;
    g.refInPaise += li.derivedCommissionInPaise;
    if (new Date(li.date) < g.date) g.date = new Date(li.date);
  }
  return Array.from(map.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function buildSinglePayoutWorkbook(payout: PayoutDetail): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sobhana Diagnostics';
  wb.created = new Date();

  const isLab = payout.doctorType === 'LAB';
  const refHeader = isLab ? 'Payable (₹)' : 'Ref (₹)';

  // Single statement sheet: one row per bill, matching the printed statement.
  //   Date | Bill # | Patient | Investigation | Amount (post-discount) | Ref
  const ws = wb.addWorksheet('Statement', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  // Header block (payee + period), then the table header on row 3.
  ws.mergeCells('A1:F1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `${payout.doctorName} — ${formatDoctorType(payout.doctorType)}`;
  titleCell.font = { bold: true, size: 13 };

  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = `Period: ${formatPeriod(
    payout.periodStartDate,
    payout.periodEndDate
  )}   ·   Branch: ${payout.branchName}`;
  ws.getCell('A2').font = { color: { argb: 'FF666666' } };

  ws.columns = [
    { key: 'date', width: 14, style: { numFmt: DATE_FMT } },
    { key: 'billNumber', width: 16 },
    { key: 'patient', width: 28 },
    { key: 'investigation', width: 40 },
    { key: 'amount', width: 14, style: { numFmt: RUPEE_FMT } },
    { key: 'ref', width: 14, style: { numFmt: RUPEE_FMT } },
  ];

  const headerRow = ws.getRow(3);
  headerRow.values = ['Date', 'Bill #', 'Patient', 'Investigation', 'Amount (₹)', refHeader];
  headerRow.font = { bold: true };

  const bills = groupLineItemsByBill(payout);
  for (const b of bills) {
    ws.addRow({
      date: b.date,
      billNumber: b.billNumber,
      patient: b.patient,
      investigation: b.tests.join(', '),
      amount: paiseToRupees(b.amountInPaise),
      ref: paiseToRupees(b.refInPaise),
    });
  }

  if (bills.length > 0) {
    const totalAmount = bills.reduce((s, b) => s + b.amountInPaise, 0);
    const totalRef = bills.reduce((s, b) => s + b.refInPaise, 0);
    const totalRow = ws.addRow({
      date: '',
      billNumber: '',
      patient: '',
      investigation: `TOTAL — ${bills.length} bills`,
      amount: paiseToRupees(totalAmount),
      ref: paiseToRupees(totalRef),
    });
    totalRow.font = { bold: true };
    totalRow.getCell('amount').numFmt = RUPEE_FMT;
    totalRow.getCell('ref').numFmt = RUPEE_FMT;
  }

  ws.getColumn('amount').alignment = { horizontal: 'right' };
  ws.getColumn('ref').alignment = { horizontal: 'right' };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
