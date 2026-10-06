/**
 * Money page Breakdown: net collected and what came off it, grouped four ways —
 * by day, branch, department or referring doctor. Every grouping adds back up
 * to the page's net collected. Sort any column, export what
 * you see, click a row to drill in (a day or branch filters the page; a
 * referrer opens their payout statement for the same dates).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { SectionCard, SegmentedFilter, TOKENS, formatRupees } from './_shared/ownerUi';

interface MoneyRow {
  key: string;
  label: string;
  grossInPaise: number;
  discountInPaise: number;
  cancelledInPaise: number;
  commissionInPaise: number;
  netInPaise: number;
  collectedInPaise: number;
  visits: number;
  priorNetInPaise: number | null;
  priorCollectedInPaise: number | null;
}
export interface BreakdownData {
  days: MoneyRow[];
  branches: MoneyRow[];
  categories: { category: string; billedInPaise: number; tests: number; priorBilledInPaise: number; priorTests: number; collectedInPaise?: number; priorCollectedInPaise?: number }[];
  referrers: { referralDoctorId: string; name: string; visits: number; billed: number; commission: number; priorVisits: number; priorBilled: number; collected?: number; priorCollected?: number }[];
}

type By = 'day' | 'branch' | 'category' | 'referrer';
type Cell = number | null;
type Kind = 'money' | 'count' | 'pct' | 'change';
interface Column {
  label: string;
  kind: Kind;
  total?: boolean; // show a total for this column
}
/** Every grouping normalises to this: a name, the cells, and where a click goes. */
interface Row {
  key: string;
  name: string;
  csvName: string;
  values: Cell[];
  drill?: () => void;
}

const change = (now: number, before: number | null): Cell =>
  before && before > 0 ? Math.round(((now - before) / before) * 100) : null;
const share = (part: number, whole: number): Cell => (whole ? Math.round((part / whole) * 100) : null);
const rupees = (p: number) => formatRupees(Math.round(p / 100) * 100);
const dayLabel = (key: string) =>
  new Date(`${key}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
  });

function fmt(kind: Kind, v: Cell): string {
  if (v == null) return '—';
  if (kind === 'money') return rupees(v);
  if (kind === 'count') return v.toLocaleString('en-IN');
  if (kind === 'pct') return `${v}%`;
  return `${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%`;
}

const MONEY_COLUMNS: Column[] = [
  { label: 'Visits', kind: 'count', total: true },
  { label: 'Net collected', kind: 'money', total: true },
  { label: 'Commission', kind: 'money', total: true },
  { label: 'Net to you', kind: 'money', total: true },
  { label: 'Discounts given', kind: 'money', total: true },
];
const moneyValues = (r: MoneyRow): Cell[] => [
  r.visits, r.collectedInPaise, r.commissionInPaise, r.netInPaise, r.discountInPaise,
];

export function MoneyBreakdown({
  data,
  periodLabel,
  onPickDay,
  onPickBranch,
  referrerHref,
}: {
  data: BreakdownData;
  periodLabel: string;
  onPickDay: (date: string) => void;
  onPickBranch: (branchId: string) => void;
  referrerHref: (doctorId: string) => string;
}) {
  const navigate = useNavigate();
  const [by, setBy] = useState<By>('day');
  const [sortCol, setSortCol] = useState<number | null>(null); // null = natural order
  const [desc, setDesc] = useState(true);

  const table = useMemo((): { columns: Column[]; rows: Row[]; first: string; hint: string } => {
    if (by === 'day') {
      return {
        first: 'Day',
        hint: 'Click a day to see just that day',
        columns: MONEY_COLUMNS,
        rows: data.days.map((r) => ({
          key: r.key, name: dayLabel(r.key), csvName: r.key, values: moneyValues(r), drill: () => onPickDay(r.key),
        })),
      };
    }
    if (by === 'branch') {
      return {
        first: 'Branch',
        hint: 'Click a branch to filter the page to it',
        columns: [...MONEY_COLUMNS, { label: 'vs before', kind: 'change' }],
        rows: data.branches.map((r) => ({
          key: r.key, name: r.label, csvName: r.label,
          values: [...moneyValues(r), change(r.collectedInPaise, r.priorCollectedInPaise)],
          drill: () => onPickBranch(r.key),
        })),
      };
    }
    if (by === 'category') {
      const now = (c: BreakdownData['categories'][number]) => c.collectedInPaise ?? c.billedInPaise;
      const before = (c: BreakdownData['categories'][number]) => c.priorCollectedInPaise ?? c.priorBilledInPaise;
      const total = data.categories.reduce((s, c) => s + now(c), 0);
      return {
        first: 'Department',
        hint: "Each bill's money is shared across its tests by price",
        columns: [
          { label: 'Tests', kind: 'count', total: true },
          { label: 'Net collected', kind: 'money', total: true },
          { label: 'Share', kind: 'pct' },
          { label: 'vs before', kind: 'change' },
        ],
        rows: [...data.categories]
          .sort((a, b) => now(b) - now(a))
          .map((c) => ({
            key: c.category, name: c.category, csvName: c.category,
            values: [c.tests, now(c), share(now(c), total), change(now(c), before(c))],
          })),
      };
    }
    return {
      first: 'Referring doctor',
      hint: 'Click a doctor to open their payout statement for these dates',
      columns: [
        { label: 'Visits', kind: 'count', total: true },
        { label: 'Net collected', kind: 'money', total: true },
        { label: 'vs before', kind: 'change' },
        { label: 'Commission', kind: 'money', total: true },
        { label: 'Commission share', kind: 'pct' },
      ],
      rows: [...data.referrers]
        .sort((a, b) => (b.collected ?? b.billed) - (a.collected ?? a.billed))
        .map((r) => {
          const name = r.name.replace(/\s{2,}.*$/, '');
          const now = r.collected ?? r.billed;
          return {
            key: r.referralDoctorId, name, csvName: name,
            values: [r.visits, now, change(now, r.priorCollected ?? r.priorBilled), r.commission, share(r.commission, now)],
            drill: () => navigate(referrerHref(r.referralDoctorId)),
          };
        }),
    };
  }, [by, data, onPickDay, onPickBranch, navigate, referrerHref]);

  const rows = useMemo(() => {
    if (sortCol == null) return table.rows;
    return [...table.rows].sort((a, b) => {
      const va = a.values[sortCol];
      const vb = b.values[sortCol];
      if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1; // blanks last
      return desc ? vb - va : va - vb;
    });
  }, [table, sortCol, desc]);

  const totals = table.columns.map((c, i) => (c.total ? table.rows.reduce((s, r) => s + (r.values[i] ?? 0), 0) : null));

  const pickSort = (i: number) => {
    if (sortCol === i) setDesc((d) => !d);
    else { setSortCol(i); setDesc(true); }
  };
  const exportCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const raw = (kind: Kind, v: Cell) => (v == null ? '' : kind === 'money' ? (v / 100).toFixed(2) : String(v));
    const unit = (k: Kind) => (k === 'money' ? ' (₹)' : k === 'count' ? '' : ' (%)');
    const lines = [
      [table.first, ...table.columns.map((c) => c.label + unit(c.kind))],
      ...rows.map((r) => [r.csvName, ...r.values.map((v, i) => raw(table.columns[i].kind, v))]),
      ['Total', ...totals.map((v, i) => raw(table.columns[i].kind, v))],
    ];
    const blob = new Blob(['\uFEFF' + lines.map((l) => l.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `breakdown-by-${by}-${periodLabel.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <SectionCard
      label={`Breakdown · ${periodLabel}`}
      description={table.hint}
      rightSlot={
        <div className="flex items-center gap-2">
          <SegmentedFilter
            value={by}
            onChange={(v) => { setBy(v); setSortCol(null); }}
            title="Group the period's figures by"
            options={[['day', 'Day'], ['branch', 'Branch'], ['category', 'Department'], ['referrer', 'Referrer']] as const}
          />
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5"
            style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.textSecondary }}
            title="Download this table as CSV"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        </div>
      }
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>Nothing in this window.</div>
      ) : (
        <div className="overflow-x-auto" style={{ maxHeight: 520, overflowY: 'auto' }}>
          <table className="w-full" style={{ fontSize: 12 }}>
            <thead className="sticky top-0" style={{ background: TOKENS.surface }}>
              <tr style={{ color: TOKENS.textTertiary }}>
                <th className="py-2 text-left" style={{ fontWeight: 400 }}>
                  {table.first}
                </th>
                {table.columns.map((c, i) => (
                  <th key={c.label} className="py-2 text-right" aria-sort={sortCol === i ? (desc ? 'descending' : 'ascending') : undefined}>
                    <button
                      onClick={() => pickSort(i)}
                      style={{
                        color: sortCol === i ? TOKENS.textPrimary : TOKENS.textTertiary,
                        fontWeight: sortCol === i ? 500 : 400,
                        background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                      }}
                    >
                      {c.label}{sortCol === i ? (desc ? ' ↓' : ' ↑') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.key}
                  onClick={r.drill}
                  className={r.drill ? 'hover:bg-slate-50' : undefined}
                  style={{ borderTop: `0.5px solid ${TOKENS.border}`, cursor: r.drill ? 'pointer' : 'default' }}
                >
                  <td className="py-2" style={{ color: r.drill ? TOKENS.info : TOKENS.textPrimary }}>
                    {r.drill ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); r.drill!(); }}
                        style={{ color: 'inherit', background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}
                      >
                        {r.name}
                      </button>
                    ) : r.name}
                  </td>
                  {r.values.map((v, i) => {
                    const kind = table.columns[i].kind;
                    const color = kind === 'change' && v != null ? (v >= 0 ? TOKENS.healthy : TOKENS.critical) : TOKENS.textPrimary;
                    return (
                      <td key={table.columns[i].label} className="py-2 text-right" style={{ color, fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(kind, v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0" style={{ background: TOKENS.surface }}>
              <tr style={{ boxShadow: `inset 0 1px 0 ${TOKENS.borderStrong}` }}>
                <td className="py-2 font-medium">Total</td>
                {table.columns.map((c, i) => (
                  <td key={c.label} className="py-2 text-right font-medium" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {totals[i] == null ? '' : fmt(c.kind, totals[i])}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
