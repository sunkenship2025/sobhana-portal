/**
 * Excel export for payouts.
 *
 * Two workbooks:
 *   - buildPayoutListWorkbook(rows)        — the filtered list view
 *   - buildSinglePayoutWorkbook(detail)    — one payout's summary + line items
 *
 * Format conventions:
 *   - Indian rupee number format (#,##,##0.00)
 *   - Dates as dd-mmm-yyyy
 *   - Bold + frozen header row
 *   - Currency stored as a number (rupees, not paise) so Excel sums work
 */
import ExcelJS from 'exceljs';
import { PayoutSummary, PayoutDetail } from './payoutService';

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

export async function buildPayoutListWorkbook(rows: PayoutSummary[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sobhana Diagnostics';
  wb.created = new Date();

  const ws = wb.addWorksheet('Payouts', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Doctor', key: 'doctorName', width: 28 },
    { header: 'Type', key: 'doctorType', width: 18 },
    { header: 'Period', key: 'period', width: 22 },
    { header: 'Period Start', key: 'periodStart', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Period End', key: 'periodEnd', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Amount (₹)', key: 'amount', width: 14, style: { numFmt: RUPEE_FMT } },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Derived On', key: 'derivedAt', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Paid On', key: 'paidAt', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Method', key: 'paymentMethod', width: 10 },
    { header: 'Branch', key: 'branchName', width: 16 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  for (const r of rows) {
    ws.addRow({
      doctorName: r.doctorName,
      doctorType: formatDoctorType(r.doctorType),
      period: formatPeriod(r.periodStartDate, r.periodEndDate),
      periodStart: new Date(r.periodStartDate),
      periodEnd: new Date(r.periodEndDate),
      amount: paiseToRupees(r.derivedAmountInPaise),
      status: r.paidAt ? 'Paid' : 'Pending',
      derivedAt: new Date(r.derivedAt),
      paidAt: r.paidAt ? new Date(r.paidAt) : null,
      paymentMethod: r.paymentMethod ?? '',
      branchName: r.branchName,
    });
  }

  // Totals row
  if (rows.length > 0) {
    const total = rows.reduce((sum, r) => sum + r.derivedAmountInPaise, 0);
    const lastRow = ws.addRow({
      doctorName: '',
      doctorType: '',
      period: '',
      periodStart: '',
      periodEnd: '',
      amount: paiseToRupees(total),
      status: `${rows.length} rows`,
    });
    lastRow.font = { bold: true };
    lastRow.getCell('amount').numFmt = RUPEE_FMT;
  }

  // Right-align currency column data
  ws.getColumn('amount').alignment = { horizontal: 'right' };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function buildSinglePayoutWorkbook(payout: PayoutDetail): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sobhana Diagnostics';
  wb.created = new Date();

  // Sheet 1: Summary
  const summary = wb.addWorksheet('Summary');
  summary.getColumn(1).width = 22;
  summary.getColumn(2).width = 36;

  const meta: [string, string | number | Date | null][] = [
    ['Doctor', payout.doctorName],
    ['Type', formatDoctorType(payout.doctorType)],
    ['Period', formatPeriod(payout.periodStartDate, payout.periodEndDate)],
    ['Total Amount (₹)', paiseToRupees(payout.derivedAmountInPaise)],
    ['Status', payout.paidAt ? 'Paid' : 'Pending'],
    ['Derived On', new Date(payout.derivedAt)],
    ['Paid On', payout.paidAt ? new Date(payout.paidAt) : null],
    ['Payment Method', payout.paymentMethod ?? ''],
    ['Reference ID', payout.paymentReferenceId ?? ''],
    ['Notes', payout.notes ?? ''],
    ['Branch', payout.branchName],
    ['Payout ID', payout.id],
  ];
  meta.forEach(([label, value], i) => {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (label.includes('₹')) row.getCell(2).numFmt = RUPEE_FMT;
    if (label.includes('On') && value instanceof Date) row.getCell(2).numFmt = DATE_FMT;
    void i;
  });

  // Sheet 2: Line Items
  const items = wb.addWorksheet('Line Items', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  items.columns = [
    { header: 'Date', key: 'date', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Bill #', key: 'billNumber', width: 16 },
    { header: 'Patient', key: 'patientName', width: 28 },
    { header: 'Service / Product', key: 'testOrFee', width: 32 },
    { header: 'Amount (₹)', key: 'amount', width: 14, style: { numFmt: RUPEE_FMT } },
    { header: 'Commission %/₹', key: 'commission', width: 16 },
    { header: 'Earned (₹)', key: 'earned', width: 14, style: { numFmt: RUPEE_FMT } },
  ];
  items.getRow(1).font = { bold: true };

  for (const li of payout.lineItems) {
    items.addRow({
      date: new Date(li.date),
      billNumber: li.billNumber,
      patientName: li.patientName,
      testOrFee: li.testOrFee,
      amount: paiseToRupees(li.amountInPaise),
      commission:
        li.commissionLabel ??
        (li.commissionType === 'PERCENTAGE'
          ? `${li.commissionPercentage ?? 0}%`
          : li.commissionAmountInPaise != null
            ? `₹${paiseToRupees(li.commissionAmountInPaise)}`
            : '-'),
      earned: paiseToRupees(li.derivedCommissionInPaise),
    });
  }

  if (payout.lineItems.length > 0) {
    const totalEarned = payout.lineItems.reduce(
      (s, li) => s + li.derivedCommissionInPaise,
      0
    );
    const totalAmount = payout.lineItems.reduce(
      (s, li) => s + li.amountInPaise,
      0
    );
    const totalRow = items.addRow({
      date: '',
      billNumber: '',
      patientName: '',
      testOrFee: `${payout.lineItems.length} items`,
      amount: paiseToRupees(totalAmount),
      commission: '',
      earned: paiseToRupees(totalEarned),
    });
    totalRow.font = { bold: true };
    totalRow.getCell('amount').numFmt = RUPEE_FMT;
    totalRow.getCell('earned').numFmt = RUPEE_FMT;
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
