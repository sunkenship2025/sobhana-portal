/**
 * Excel export for the billable-products price list.
 *
 * Same format conventions as payoutExportService:
 *   - Indian rupee number format (#,##,##0.00)
 *   - Bold + frozen header row
 *   - Currency stored as a number (rupees, not paise) so Excel sums work
 */
import ExcelJS from 'exceljs';

const RUPEE_FMT = '#,##,##0.00';

export interface PriceListExportRow {
  code: string;
  name: string;
  isBundle: boolean;
  priceInPaise: number;
}

export async function buildPriceListWorkbook(
  rows: PriceListExportRow[],
  branchName?: string | null
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sobhana Diagnostics';
  wb.created = new Date();

  const ws = wb.addWorksheet('Price List', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'S.No', key: 'sno', width: 7 },
    { header: 'Code', key: 'code', width: 16 },
    { header: 'Test / Package', key: 'name', width: 44 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Price (₹)', key: 'price', width: 14, style: { numFmt: RUPEE_FMT } },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  rows.forEach((r, i) => {
    ws.addRow({
      sno: i + 1,
      code: r.code,
      name: r.name,
      type: r.isBundle ? 'Package' : 'Test',
      price: Math.round(r.priceInPaise) / 100,
    });
  });

  // Trailing meta line so a printed/shared sheet is self-describing
  const meta = ws.addRow({});
  const label = `${branchName ? `${branchName} — ` : ''}Price list as on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · ${rows.length} item${rows.length === 1 ? '' : 's'}`;
  meta.getCell('name').value = label;
  meta.font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
