/**
 * Owner Money — day sheet (per-bill register).
 *
 * The dashboard fetches this shape from GET /api/owner/money/day-sheet and
 * renders it into a self-contained printable HTML document (opened in a new
 * window → window.print()). The Excel variant is produced server-side.
 */

export interface DaySheetRow {
  billNumber: string;
  billedAtIso: string;
  patientName: string;
  patientTitle: string | null;
  branchCode: string;
  domain: 'DIAGNOSTICS' | 'CLINIC';
  tests: string;
  testCount: number;
  grossInPaise: number;
  discountInPaise: number;
  paidInPaise: number;
  dueInPaise: number;
  paymentMethod: 'CASH' | 'ONLINE' | 'MIXED' | 'NONE';
  paymentStatus: string;
}

export interface DaySheetResponse {
  generatedAt: string;
  period: { key: string; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  rows: DaySheetRow[];
  totals: {
    count: number;
    grossInPaise: number;
    discountInPaise: number;
    paidInPaise: number;
    dueInPaise: number;
  };
}

const PAYMENT_LABEL: Record<DaySheetRow['paymentMethod'], string> = {
  CASH: 'Cash',
  ONLINE: 'Online',
  MIXED: 'Mixed',
  NONE: '—',
};

function rupees(paise: number): string {
  return `₹${(Math.round(paise) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function istDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function rangeLabel(data: DaySheetResponse): string {
  const start = istDate(data.period.startIso);
  // endIso is exclusive (start of the day after the last day) — step back one day
  const endInclusive = new Date(new Date(data.period.endIso).getTime() - 86400000).toISOString();
  const end = istDate(endInclusive);
  return start === end ? start : `${start} – ${end}`;
}

/** Build a self-contained printable HTML document for the day sheet. */
export function buildDaySheetHtml(data: DaySheetResponse): string {
  const scope = data.branchScope.branchName ?? 'All branches';
  const rowsHtml = data.rows
    .map((r, i) => {
      const patient = r.patientTitle ? `${r.patientTitle} ${r.patientName}` : r.patientName;
      const dueClass = r.dueInPaise > 0 ? ' class="due"' : '';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(istDateTime(r.billedAtIso))}</td>
        <td>${esc(r.billNumber)}</td>
        <td>${esc(patient)}</td>
        <td>${esc(r.branchCode)}</td>
        <td class="tests">${esc(r.tests)}</td>
        <td class="amt">${rupees(r.grossInPaise)}</td>
        <td class="amt">${r.discountInPaise ? rupees(r.discountInPaise) : '—'}</td>
        <td class="amt">${rupees(r.paidInPaise)}</td>
        <td class="amt"${dueClass}>${r.dueInPaise ? rupees(r.dueInPaise) : '—'}</td>
        <td>${PAYMENT_LABEL[r.paymentMethod]}</td>
      </tr>`;
    })
    .join('');

  const t = data.totals;
  const empty = data.rows.length === 0
    ? '<tr><td colspan="11" class="empty">No bills in this period.</td></tr>'
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Day sheet — ${esc(rangeLabel(data))}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { font-size: 12px; color: #666; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 0.5px solid #d0d0d0; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-weight: 600; }
  td.num, th.num { text-align: right; width: 30px; }
  td.amt, th.amt { text-align: right; white-space: nowrap; }
  td.tests { max-width: 260px; }
  td.due { color: #b91c1c; font-weight: 600; }
  tfoot td { font-weight: 700; background: #fafafa; }
  .empty { text-align: center; color: #888; padding: 18px; }
  @media print { body { margin: 10mm; } thead { display: table-header-group; } }
</style>
</head>
<body>
  <h1>Day sheet — ${esc(scope)}</h1>
  <div class="sub">${esc(rangeLabel(data))} · ${t.count} bill${t.count === 1 ? '' : 's'} · generated ${esc(istDateTime(data.generatedAt))}</div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th>
        <th>Date &amp; time</th>
        <th>Bill No</th>
        <th>Patient</th>
        <th>Branch</th>
        <th>Tests / service</th>
        <th class="amt">Gross</th>
        <th class="amt">Discount</th>
        <th class="amt">Paid</th>
        <th class="amt">Due</th>
        <th>Method</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}${empty}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="6" class="amt">Total</td>
        <td class="amt">${rupees(t.grossInPaise)}</td>
        <td class="amt">${rupees(t.discountInPaise)}</td>
        <td class="amt">${rupees(t.paidInPaise)}</td>
        <td class="amt">${rupees(t.dueInPaise)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>
  <script>window.onload = function () { window.print(); };</script>
</body>
</html>`;
}
