/**
 * Excel export for the owner Money day sheet (per-bill register).
 *
 * Same format conventions as productExportService / payoutExportService:
 *   - Indian rupee number format (#,##,##0.00)
 *   - Bold + frozen header row
 *   - Currency stored as a number (rupees, not paise) so Excel sums work
 */
import ExcelJS from 'exceljs';
import type { DaySheetResponse, DaySheetRow } from './ownerMoneyService';

const RUPEE_FMT = '#,##,##0.00';

const PAYMENT_LABEL: Record<DaySheetRow['paymentMethod'], string> = {
  CASH: 'Cash',
  ONLINE: 'Online',
  MIXED: 'Mixed',
  NONE: '—',
};

function istDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function istDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function patientDisplay(row: DaySheetRow): string {
  return row.patientTitle ? `${row.patientTitle} ${row.patientName}` : row.patientName;
}

export async function buildDaySheetWorkbook(data: DaySheetResponse): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sobhana Diagnostics';
  wb.created = new Date();

  const ws = wb.addWorksheet('Day Sheet', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'S.No', key: 'sno', width: 7 },
    { header: 'Date & time', key: 'time', width: 20 },
    { header: 'Bill No', key: 'billNumber', width: 16 },
    { header: 'Patient', key: 'patient', width: 26 },
    { header: 'Branch', key: 'branch', width: 10 },
    { header: 'Tests / service', key: 'tests', width: 44 },
    { header: 'Gross (₹)', key: 'gross', width: 13, style: { numFmt: RUPEE_FMT } },
    { header: 'Discount (₹)', key: 'discount', width: 13, style: { numFmt: RUPEE_FMT } },
    { header: 'Paid (₹)', key: 'paid', width: 13, style: { numFmt: RUPEE_FMT } },
    { header: 'Due (₹)', key: 'due', width: 13, style: { numFmt: RUPEE_FMT } },
    { header: 'Method', key: 'method', width: 10 },
    { header: 'Status', key: 'status', width: 12 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  data.rows.forEach((r, i) => {
    ws.addRow({
      sno: i + 1,
      time: istDateTime(r.billedAtIso),
      billNumber: r.billNumber,
      patient: patientDisplay(r),
      branch: r.branchCode,
      tests: r.tests,
      gross: Math.round(r.grossInPaise) / 100,
      discount: Math.round(r.discountInPaise) / 100,
      paid: Math.round(r.paidInPaise) / 100,
      due: Math.round(r.dueInPaise) / 100,
      method: PAYMENT_LABEL[r.paymentMethod],
      status: r.paymentStatus,
    });
  });

  // Totals row
  const totals = ws.addRow({
    tests: `Total — ${data.totals.count} bill${data.totals.count === 1 ? '' : 's'}`,
    gross: Math.round(data.totals.grossInPaise) / 100,
    discount: Math.round(data.totals.discountInPaise) / 100,
    paid: Math.round(data.totals.paidInPaise) / 100,
    due: Math.round(data.totals.dueInPaise) / 100,
  });
  totals.font = { bold: true };
  totals.getCell('tests').alignment = { horizontal: 'right' };

  // Trailing meta line so a shared sheet is self-describing
  const startLabel = istDate(data.period.startIso);
  // period.endIso is exclusive (start of the day after) — step back one day for display
  const endInclusive = new Date(new Date(data.period.endIso).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endLabel = istDate(endInclusive);
  const rangeLabel = startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
  const scope = data.branchScope.branchName ?? 'All branches';
  const meta = ws.addRow({});
  meta.getCell('tests').value = `${scope} · ${rangeLabel} · generated ${istDateTime(data.generatedAt)}`;
  meta.font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
