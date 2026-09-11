/**
 * Day sheet → self-contained printable HTML.
 *
 * Server-side because the token link (/day-sheet/:token) has to render it for
 * someone who is not signed in, exactly as /reports/:token and /bills/view/:token
 * do. It previously lived in the frontend; keeping a copy there would have left
 * two renderers of the same money document to drift apart — this repo already
 * carries that scar with report-frame.css / report-screen.css.
 *
 * The authenticated print button now asks this same endpoint for HTML, so what
 * the owner prints and what the WhatsApp link shows are byte-identical.
 */
import type { DaySheetResponse } from './ownerMoneyService';

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

const DOMAIN_LABEL: Record<DaySheetResponse['domain'], string> = {
  ALL: 'Day sheet',
  DIAGNOSTICS: 'Diagnostic day sheet',
  CLINIC: 'OP day sheet',
};

/** Build a self-contained printable HTML document for the day sheet. */
/**
 * @param autoPrint  true for the print popup (default). false when the sheet is
 *   shown inline — an iframe that prints itself on load would ambush anyone
 *   arriving from the nightly WhatsApp link.
 */
export function buildDaySheetHtml(data: DaySheetResponse, autoPrint = true): string {
  const scope = data.branchScope.branchName ?? 'All branches';
  const heading = DOMAIN_LABEL[data.domain];
  const rowsHtml = data.rows
    .map((r, i) => {
      const patient = r.patientTitle ? `${r.patientTitle} ${r.patientName}` : r.patientName;
      const dueClass = r.dueInPaise > 0 ? ' class="amt due"' : ' class="amt"';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(istDateTime(r.billedAtIso))}</td>
        <td>${esc(r.billNumber)}</td>
        <td>${esc(patient)}</td>
        <td>${esc(r.referredBy ?? '—')}</td>
        <td>${esc(r.branchCode)}</td>
        <td class="tests">${esc(r.tests)}</td>
        <td class="amt">${rupees(r.grossInPaise)}</td>
        <td class="amt">${r.discountInPaise ? rupees(r.discountInPaise) : '—'}</td>
        <td class="amt">${r.cashInPaise ? rupees(r.cashInPaise) : '—'}</td>
        <td class="amt">${r.onlineInPaise ? rupees(r.onlineInPaise) : '—'}</td>
        <td class="amt">${rupees(r.paidInPaise)}</td>
        <td class="amt">${r.refundedInPaise ? rupees(r.refundedInPaise) : '—'}</td>
        <td${dueClass}>${r.dueInPaise ? rupees(r.dueInPaise) : '—'}</td>
      </tr>`;
    })
    .join('');

  const t = data.totals;
  const empty = data.rows.length === 0
    ? '<tr><td colspan="13" class="empty">No bills in this period.</td></tr>'
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(heading)} — ${esc(rangeLabel(data))}</title>
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
  <h1>${esc(heading)} — ${esc(scope)}</h1>
  <div class="sub">${esc(rangeLabel(data))} · ${t.count} bill${t.count === 1 ? '' : 's'} · generated ${esc(istDateTime(data.generatedAt))}</div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th>
        <th>Date &amp; time</th>
        <th>Bill No</th>
        <th>Patient</th>
        <th>Referred by</th>
        <th>Branch</th>
        <th>Tests / service</th>
        <th class="amt">Gross</th>
        <th class="amt">Discount</th>
        <th class="amt">Cash</th>
        <th class="amt">Online</th>
        <th class="amt">Paid</th>
        <th class="amt">Refund</th>
        <th class="amt">Due</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}${empty}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="7" class="amt">Total</td>
        <td class="amt">${rupees(t.grossInPaise)}</td>
        <td class="amt">${rupees(t.discountInPaise)}</td>
        <td class="amt">${rupees(t.cashInPaise)}</td>
        <td class="amt">${rupees(t.onlineInPaise)}</td>
        <td class="amt">${rupees(t.paidInPaise)}</td>
        <td class="amt">${rupees(t.refundedInPaise)}</td>
        <td class="amt">${rupees(t.dueInPaise)}</td>
      </tr>
    </tfoot>
  </table>
  ${autoPrint ? '<script>window.onload = function () { window.print(); };</script>' : ''}
</body>
</html>`;
}
