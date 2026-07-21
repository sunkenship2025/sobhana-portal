/**
 * Owner Money page — GET /api/owner/money
 *
 * Answers: cash in / cash owed / cash out / where's the leakage / who handles it.
 *
 * Layout:
 *   - 4 KPI cards: gross / net / outstanding / discounts
 *   - 30d revenue trend (full width)
 *   - aging buckets (40%) + oldest unpaid bills (60%)
 *   - cash vs online by branch (50%) + collected by user (50%)
 *   - discount log (60%) + refunds summary (40%)
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Printer, Download } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { formatPatientName } from '@/lib/patientDisplay';
import { buildDaySheetHtml, DaySheetResponse } from './moneyDaySheet';
import {
  TOKENS,
  formatRupees,
  formatIstDateTime,
  formatIstDate,
  SectionCard,
  KpiCard,
  AgingBar,
  TrendChart,
  TruncationFooter,
  EmptyState,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  OwnerPageHeader,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
} from './_shared/ownerUi';

interface MoneyResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: {
    grossInPaise: number;
    netInPaise: number;
    outstandingInPaise: number;
    outstandingAgedInPaise: number;
    outstandingAgedBillCount: number;
    dueInPaise: number;
    discountInPaise: number;
    discountBillCount: number;
    commissionInPaise: number;
    collectionRatePct: number | null;
    grossDeltaPercent: number | null;
    netDeltaPercent: number | null;
  };
  revenueTrend: { date: string; netInPaise: number }[];
  aging: Array<{
    key: '0_7' | '8_15' | '16_30' | '30_plus';
    label: string;
    amountInPaise: number;
    billCount: number;
  }>;
   oldestUnpaid: Array<{
     billId: string;
     billNumber: string;
     patientId: string;
     patientName: string;
     patientTitle?: string | null;
     branchCode: string;
    daysOverdue: number;
    owedInPaise: number;
  }>;
  cashByBranch: Array<{
    branchId: string;
    branchName: string;
    branchCode: string;
    totalInPaise: number;
    cashInPaise: number;
    onlineInPaise: number;
    cashSharePct: number;
    flagHeavyCash: boolean;
  }>;
  cashByUser: Array<{
    userId: string;
    userName: string;
    branchName: string;
    cashInPaise: number;
    onlineInPaise: number;
    totalCollectedInPaise: number;
    transactionCount: number;
    flagSoloCash: boolean;
  }>;
  cashByUserTotalCount: number;
   discountLog: Array<{
     billId: string;
     billNumber: string;
     patientName: string;
     patientTitle?: string | null;
     branchCode: string;
    discountInPaise: number;
    discountPercent: number;
    reason: string | null;
    grantedBy: string | null;
    flag: boolean;
  }>;
  discountLogTotalCount: number;
  refunds: {
    totalInPaise: number;
    count: number;
    pctOfGross: number | null;
     recent: Array<{
       billId: string;
       billNumber: string;
       patientName: string;
       patientTitle?: string | null;
       refundedInPaise: number;
      reason: string | null;
      refundedAt: string;
    }>;
  };
  cancellations: {
    totalInPaise: number;
    count: number;
    pctOfGross: number | null;
    recent: Array<{
      billNumber: string;
      patientName: string;
      patientTitle?: string | null;
      reversedInPaise: number;
      reason: string | null;
      cancelledAt: string;
    }>;
  };
}

// ----- revenue trend ----------------------------------------------------

function RevenueTrendSection({ trend }: { trend: MoneyResponse['revenueTrend'] }) {
  if (trend.length === 0) {
    return null;
  }
  const data = trend.map((p) => ({ date: p.date, value: p.netInPaise }));
  return (
    <SectionCard label="Revenue trend" description="Daily net revenue across the period">
      <TrendChart
        data={data}
        height={160}
        valueFormat={(v) => formatRupees(v, { short: true })}
        markLastAsToday
        accent={TOKENS.net}
      />
    </SectionCard>
  );
}

// ----- aging + oldest ---------------------------------------------------

type AgingKey = MoneyResponse['aging'][number]['key'];

function AgingCard({
  aging,
  total,
  selectedKey,
  onSelect,
}: {
  aging: MoneyResponse['aging'];
  total: number;
  selectedKey: AgingKey | null;
  onSelect: (key: AgingKey | null) => void;
}) {
  const colors = [TOKENS.healthy, TOKENS.cautionLight, TOKENS.caution, TOKENS.critical];
  return (
    <SectionCard
      label="Receivables aging"
      description="By days since billed · click a bucket to filter"
      rightSlot={
        selectedKey ? (
          <button
            onClick={() => onSelect(null)}
            style={{
              color: TOKENS.info,
              background: 'transparent',
              border: 0,
              fontSize: 12,
              padding: 0,
              cursor: 'pointer',
            }}
          >
            clear filter
          </button>
        ) : null
      }
    >
      {total === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No outstanding bills.</div>
      ) : (
        aging.map((b, i) => {
          const isSelected = selectedKey === b.key;
          return (
            <div
              key={b.key}
              onClick={() => onSelect(isSelected ? null : b.key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(isSelected ? null : b.key);
                }
              }}
              style={{
                cursor: 'pointer',
                borderRadius: 4,
                background: isSelected ? '#EEF4FF' : undefined,
                opacity: selectedKey && !isSelected ? 0.5 : 1,
                paddingLeft: 4,
                paddingRight: 4,
              }}
            >
              <AgingBar bucket={b} total={total} color={colors[i]} />
            </div>
          );
        })
      )}
    </SectionCard>
  );
}

function agingKeyForDays(days: number): AgingKey {
  if (days <= 7) return '0_7';
  if (days <= 15) return '8_15';
  if (days <= 30) return '16_30';
  return '30_plus';
}

function OldestUnpaidCard({
  rows,
  filterKey,
  filterLabel,
  onClearFilter,
}: {
  rows: MoneyResponse['oldestUnpaid'];
  filterKey: AgingKey | null;
  filterLabel: string | null;
  onClearFilter: () => void;
}) {
  const visibleRows = filterKey
    ? rows.filter((r) => agingKeyForDays(r.daysOverdue) === filterKey)
    : rows;
  return (
    <SectionCard
      label="Oldest unpaid"
      description="Top 5 oldest open bills"
      rightSlot={
        filterKey ? (
          <button
            onClick={onClearFilter}
            style={{
              color: TOKENS.info,
              background: 'transparent',
              border: 0,
              fontSize: 12,
              padding: 0,
              cursor: 'pointer',
            }}
          >
            {filterLabel} ✕
          </button>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>Everything is paid.</div>
      ) : visibleRows.length === 0 ? (
        <EmptyState label="No bills in this aging bucket" hint="Clear the filter to see all" />
      ) : (
        <table className="w-full" style={{ fontSize: 12 }}>
          <thead>
            <tr
              style={{
                color: TOKENS.textTertiary,
                textAlign: 'left',
                fontWeight: 400,
              }}
            >
              <th className="pb-2">Patient</th>
              <th className="pb-2">Bill</th>
              <th className="pb-2 text-right">Days</th>
              <th className="pb-2 text-right">Owed</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.billId} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                <td className="py-2">
                  <Link
                    to={`/clinic/patient-360/${r.patientId}`}
                    style={{ color: TOKENS.info, textDecoration: 'none' }}
                  >
                    {formatPatientName(r.patientName, r.patientTitle)}
                  </Link>
                  <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>{r.branchCode}</div>
                </td>
                <td className="py-2" style={{ color: TOKENS.textPrimary }}>
                  {r.billNumber}
                </td>
                <td
                  className="py-2 text-right"
                  style={{
                    color: r.daysOverdue > 30 ? TOKENS.critical : TOKENS.caution,
                  }}
                >
                  {r.daysOverdue}d
                </td>
                <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                  {formatRupees(r.owedInPaise, { short: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

// ----- cash by branch / user -------------------------------------------

// One branch's cash/online split. Both halves are their own hit target; hovering
// one lights it, dims the other, and bolds the matching half of the caption
// below — the caption already carries the values, so it doubles as the readout
// and no floating tooltip is needed. Amounts are shortened (₹2.7L), so hover
// swaps in the exact figures.
function CashByBranchRow({ b }: { b: MoneyResponse['cashByBranch'][number] }) {
  const [side, setSide] = useState<'cash' | 'online' | null>(null);
  const onlineSharePct = 100 - b.cashSharePct;
  const amount = (v: number) => (side ? formatRupees(v) : formatRupees(v, { short: true }));
  return (
    <div
      className="py-2"
      style={{
        borderTop: `0.5px solid ${TOKENS.border}`,
        background: b.flagHeavyCash ? '#FFF8E1' : undefined,
        padding: 8,
      }}
      onMouseLeave={() => setSide(null)}
    >
      <div className="mb-1 flex items-baseline justify-between" style={{ fontSize: 13 }}>
        <span style={{ color: TOKENS.textPrimary }}>
          {b.branchName}{' '}
          <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>({b.branchCode})</span>
        </span>
        <span style={{ color: TOKENS.textPrimary }}>
          {amount(b.totalInPaise)}
        </span>
      </div>
      <div className="flex w-full overflow-hidden" style={{ height: 12, borderRadius: 3 }}>
        {(['cash', 'online'] as const).map((k) => (
          <div
            key={k}
            tabIndex={0}
            aria-label={`${b.branchName} ${k}: ${formatRupees(
              k === 'cash' ? b.cashInPaise : b.onlineInPaise
            )}, ${k === 'cash' ? b.cashSharePct : onlineSharePct} percent`}
            onMouseEnter={() => setSide(k)}
            onFocus={() => setSide(k)}
            onBlur={() => setSide(null)}
            style={{
              width: `${k === 'cash' ? b.cashSharePct : onlineSharePct}%`,
              background: k === 'cash' ? TOKENS.cash : TOKENS.online,
              opacity: side && side !== k ? 0.4 : 1,
              transition: 'opacity 120ms ease',
              outline: 'none',
              cursor: 'default',
            }}
          />
        ))}
      </div>
      <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
        <span
          style={{
            color: side === 'cash' ? TOKENS.textPrimary : undefined,
            fontWeight: side === 'cash' ? 600 : undefined,
          }}
        >
          cash {amount(b.cashInPaise)} ({b.cashSharePct}%)
        </span>
        {' · '}
        <span
          style={{
            color: side === 'online' ? TOKENS.textPrimary : undefined,
            fontWeight: side === 'online' ? 600 : undefined,
          }}
        >
          online {amount(b.onlineInPaise)} ({onlineSharePct}%)
        </span>
      </div>
    </div>
  );
}

function CashByBranchCard({ rows }: { rows: MoneyResponse['cashByBranch'] }) {
  const visible = rows.filter((r) => r.totalInPaise > 0);
  return (
    <SectionCard
      label="Cash vs online · by branch"
      description="Heavy-cash branches (>70%) tinted amber"
    >
      {visible.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No payments in window.</div>
      ) : (
        visible.map((b) => <CashByBranchRow key={b.branchId} b={b} />)
      )}
    </SectionCard>
  );
}

function CashByUserCard({
  rows,
  totalCount,
}: {
  rows: MoneyResponse['cashByUser'];
  totalCount: number;
}) {
  const visible = rows.slice(0, 10);
  return (
    <SectionCard
      label="Collected by user"
      description="Solo-cash users (>80% cash) tinted amber"
    >
      {rows.length === 0 ? (
        <EmptyState label="No transactions in window" />
      ) : (
        <>
          <table className="w-full" style={{ fontSize: 12 }}>
            <thead>
              <tr
                style={{
                  color: TOKENS.textTertiary,
                  textAlign: 'left',
                  fontWeight: 400,
                }}
              >
                <th className="pb-2">User</th>
                <th className="pb-2 text-right">Cash</th>
                <th className="pb-2 text-right">Online</th>
                <th className="pb-2 text-right">Total</th>
                <th className="pb-2 text-right">Txns</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <tr
                  key={u.userId}
                  style={{
                    borderTop: `0.5px solid ${TOKENS.border}`,
                    background: u.flagSoloCash ? '#FFF8E1' : undefined,
                  }}
                >
                  <td className="py-2">
                    <span style={{ color: TOKENS.textPrimary }}>{u.userName}</span>
                    <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>{u.branchName}</div>
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(u.cashInPaise, { short: true })}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(u.onlineInPaise, { short: true })}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(u.totalCollectedInPaise, { short: true })}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {u.transactionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <TruncationFooter shown={visible.length} total={totalCount} />
        </>
      )}
    </SectionCard>
  );
}

// ----- discounts + refunds ---------------------------------------------

function DiscountLogCard({
  rows,
  totalCount,
}: {
  rows: MoneyResponse['discountLog'];
  totalCount: number;
}) {
  const visible = rows.slice(0, 20);
  return (
    <SectionCard
      label="Discount log"
      description="Discounts > 30% or > ₹1,000 tinted red"
    >
      {rows.length === 0 ? (
        <EmptyState label="No discounts in window" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: 12 }}>
            <thead>
              <tr
                style={{
                  color: TOKENS.textTertiary,
                  textAlign: 'left',
                  fontWeight: 400,
                }}
              >
                <th className="pb-2">Bill</th>
                <th className="pb-2">Patient</th>
                <th className="pb-2 text-right">Off</th>
                <th className="pb-2 text-right">%</th>
                <th className="pb-2">Reason</th>
                <th className="pb-2">Granted by</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr
                  key={d.billId}
                  style={{
                    borderTop: `0.5px solid ${TOKENS.border}`,
                    background: d.flag ? '#FCEBEB30' : undefined,
                  }}
                >
                  <td className="py-2" style={{ color: TOKENS.textPrimary }}>
                    {d.billNumber}{' '}
                    <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>({d.branchCode})</span>
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textPrimary }}>
                    {formatPatientName(d.patientName, d.patientTitle)}
                  </td>
                <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                  {formatRupees(d.discountInPaise, { short: true })}
                </td>
                  <td
                    className="py-2 text-right"
                    style={{
                      color: d.discountPercent > 30 ? TOKENS.critical : TOKENS.textPrimary,
                    }}
                  >
                    {d.discountPercent}%
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                    {d.reason ?? '—'}
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                    {d.grantedBy ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <TruncationFooter shown={visible.length} total={totalCount} />
        </div>
      )}
    </SectionCard>
  );
}

function RefundsCard({ refunds }: { refunds: MoneyResponse['refunds'] }) {
  return (
    <SectionCard label="Refunds">
      <div className="font-medium" style={{ fontSize: 22, color: TOKENS.textPrimary }}>
        {formatRupees(refunds.totalInPaise, { short: true })}
      </div>
      <div style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        {refunds.count} refund{refunds.count === 1 ? '' : 's'}
        {refunds.pctOfGross !== null && ` · ${refunds.pctOfGross}% of gross`}
      </div>
      {refunds.recent.length > 0 && (
        <div
          className="mt-3 space-y-2 border-t pt-2"
          style={{ borderColor: TOKENS.border, fontSize: 12 }}
        >
          {refunds.recent.map((r) => (
            <div key={r.billId} className="flex items-baseline justify-between">
              <span>
                <span style={{ color: TOKENS.textPrimary }}>
                  {formatPatientName(r.patientName, r.patientTitle)}
                </span>
                <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                  {' '}
                  · {r.billNumber}
                </span>
                <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                  {formatIstDate(r.refundedAt)} · {r.reason ?? '—'}
                </div>
              </span>
              <span style={{ color: TOKENS.textPrimary }}>
                {formatRupees(r.refundedInPaise, { short: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function CancellationsCard({
  cancellations,
}: {
  cancellations: MoneyResponse['cancellations'];
}) {
  return (
    <SectionCard label="Cancellations">
      <div className="font-medium" style={{ fontSize: 22, color: TOKENS.textPrimary }}>
        {formatRupees(cancellations.totalInPaise, { short: true })}
      </div>
      <div style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        {cancellations.count} cancellation{cancellations.count === 1 ? '' : 's'}
        {cancellations.pctOfGross !== null && ` · ${cancellations.pctOfGross}% of gross`}
      </div>
      {cancellations.recent.length > 0 && (
        <div
          className="mt-3 space-y-2 border-t pt-2"
          style={{ borderColor: TOKENS.border, fontSize: 12 }}
        >
          {cancellations.recent.map((c, i) => (
            <div key={`${c.billNumber}-${i}`} className="flex items-baseline justify-between">
              <span>
                <span style={{ color: TOKENS.textPrimary }}>
                  {formatPatientName(c.patientName, c.patientTitle)}
                </span>
                <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                  {' '}
                  · {c.billNumber}
                </span>
                <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                  {formatIstDate(c.cancelledAt)} · {c.reason ?? '—'}
                </div>
              </span>
              <span style={{ color: TOKENS.textPrimary }}>
                {formatRupees(c.reversedInPaise, { short: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ----- main page --------------------------------------------------------

const MONEY_PERIOD_OPTS: PeriodKey[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'mtd',
  'ytd',
  'custom',
];

/** Local calendar day as YYYY-MM-DD (browser TZ == IST for our users). */
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function OwnerMoneyPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';
  const rawPeriod = searchParams.get('period');
  const period: PeriodKey = MONEY_PERIOD_OPTS.includes(rawPeriod as PeriodKey)
    ? (rawPeriod as PeriodKey)
    : '30d';
  const customStart = searchParams.get('start') || '';
  const customEnd = searchParams.get('end') || '';
  const customReady = period === 'custom' && Boolean(customStart) && Boolean(customEnd);
  // Register slicer: 'all' | 'diagnostics' | 'clinic'. Drives the whole page
  // (and the day sheet), like a PowerBI slicer. URL-backed so it's shareable.
  const rawDomain = searchParams.get('domain');
  const domain: 'all' | 'diagnostics' | 'clinic' =
    rawDomain === 'diagnostics' || rawDomain === 'clinic' ? rawDomain : 'all';

  const setDomain = (next: 'all' | 'diagnostics' | 'clinic') => {
    setSearchParams(prev => {
      if (next === 'all') prev.delete('domain');
      else prev.set('domain', next);
      return prev;
    });
  };

  const setBranchValue = (newBranch: string) => {
    setSearchParams(prev => {
      prev.set('branch', newBranch);
      return prev;
    });
  };

  const setPeriod = (next: PeriodKey) => {
    setSearchParams(prev => {
      prev.set('period', next);
      if (next === 'custom') {
        // Seed both ends to today so the picker opens on a valid range.
        if (!prev.get('start')) prev.set('start', todayKey());
        if (!prev.get('end')) prev.set('end', todayKey());
      } else {
        prev.delete('start');
        prev.delete('end');
      }
      return prev;
    });
  };

  const setCustomRange = (r: { start: string; end: string }) => {
    setSearchParams(prev => {
      prev.set('period', 'custom');
      if (r.start) prev.set('start', r.start);
      if (r.end) prev.set('end', r.end);
      return prev;
    });
  };

  // Shared query string for every money endpoint (dashboard + day sheet). The
  // register slicer is folded in here so it drives every card, chart and table.
  const domainParam = domain === 'all' ? '' : `&domain=${domain}`;
  const moneyParams =
    period === 'custom'
      ? `period=custom&start=${customStart}&end=${customEnd}&branch=${encodeURIComponent(branchValue)}${domainParam}`
      : `period=${period}&branch=${encodeURIComponent(branchValue)}${domainParam}`;

  const query = useQuery<MoneyResponse>({
    queryKey: ['owner-money', period, branchValue, customStart, customEnd, domain],
    queryFn: () => apiRequest<MoneyResponse>(`${API_BASE}/owner/money?${moneyParams}`),
    enabled: period !== 'custom' || customReady,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const [agingFilter, setAgingFilter] = useState<AgingKey | null>(null);
  const [daySheetBusy, setDaySheetBusy] = useState<null | 'print' | 'excel'>(null);
  // Day sheet reuses the page's params — the register slicer already lives in them.
  const daySheetParams = moneyParams;

  const printDaySheet = async () => {
    if (daySheetBusy) return;
    // Open the window synchronously (inside the click) so the popup blocker
    // allows it; fill it once the data arrives.
    const win = window.open('', '_blank');
    if (!win) {
      toast.error('Allow pop-ups to print the day sheet');
      return;
    }
    win.document.write('<p style="font-family:sans-serif;padding:24px;color:#666">Preparing day sheet…</p>');
    setDaySheetBusy('print');
    try {
      const data = await apiRequest<DaySheetResponse>(`${API_BASE}/owner/money/day-sheet?${daySheetParams}`);
      win.document.open();
      win.document.write(buildDaySheetHtml(data));
      win.document.close();
    } catch {
      win.close();
      toast.error('Failed to build the day sheet');
    } finally {
      setDaySheetBusy(null);
    }
  };

  const exportDaySheetExcel = async () => {
    if (daySheetBusy) return;
    setDaySheetBusy('excel');
    try {
      const { token } = useAuthStore.getState();
      const res = await fetch(`${API_BASE}/owner/money/day-sheet?${daySheetParams}&format=xlsx`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const tag = domain === 'diagnostics' ? 'diagnostic-' : domain === 'clinic' ? 'op-' : '';
      a.download = `${tag}day-sheet-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to export the day sheet');
    } finally {
      setDaySheetBusy(null);
    }
  };

  const data = query.data;
  const totalAging = data?.aging.reduce((s, b) => s + b.amountInPaise, 0) ?? 0;
  const agingLabelByKey = new Map((data?.aging ?? []).map((b) => [b.key, b.label]));

  return (
    <AppLayout context="owner" hideContextBanner>
      <div
        className="mx-auto"
        style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}
      >
        <OwnerPageHeader
          title="Money"
          subtitle={
            data
              ? `${formatIstDateTime(data.generatedAt)} · ${
                  data.branchScope.branchName ?? 'all branches'
                }`
              : 'Loading…'
          }
          rightSlot={
            <>
              <PeriodFilter
                value={period}
                onChange={setPeriod}
                options={MONEY_PERIOD_OPTS}
                customRange={{ start: customStart || todayKey(), end: customEnd || todayKey() }}
                onCustomRangeChange={setCustomRange}
              />
              <BranchFilter value={branchValue} onChange={setBranchValue} />
              <div
                className="inline-flex overflow-hidden rounded-md border"
                style={{ borderColor: TOKENS.border, fontSize: 12 }}
                title="Filter the whole page by register"
              >
                {([
                  ['all', 'All'],
                  ['diagnostics', 'Diagnostic'],
                  ['clinic', 'OP'],
                ] as const).map(([k, label], i) => (
                  <button
                    key={k}
                    onClick={() => setDomain(k)}
                    className="px-2.5 py-1.5"
                    style={{
                      background: k === domain ? TOKENS.info : 'white',
                      color: k === domain ? 'white' : TOKENS.textSecondary,
                      borderLeft: i === 0 ? 'none' : `0.5px solid ${TOKENS.border}`,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={printDaySheet}
                disabled={daySheetBusy !== null}
                className="inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5"
                style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.textSecondary }}
                title="Print day sheet for the selected period"
              >
                <Printer className="h-3.5 w-3.5" />
                {daySheetBusy === 'print' ? 'Preparing…' : 'Day sheet'}
              </button>
              <button
                onClick={exportDaySheetExcel}
                disabled={daySheetBusy !== null}
                className="inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5"
                style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.textSecondary }}
                title="Export day sheet to Excel"
              >
                <Download className="h-3.5 w-3.5" />
                {daySheetBusy === 'excel' ? 'Exporting…' : 'Excel'}
              </button>
              <RefreshButton isFetching={query.isFetching} onClick={() => query.refetch()} />
            </>
          }
        />

        {query.isLoading && <FullPageSkeleton />}
        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
              <KpiCard
                label="Gross billed"
                value={formatRupees(data.kpis.grossInPaise, { short: true })}
                delta={{ percent: data.kpis.grossDeltaPercent, baseline: 'vs prior period' }}
              />
              <KpiCard
                label="Net to you"
                value={formatRupees(data.kpis.netInPaise, { short: true })}
                delta={{ percent: data.kpis.netDeltaPercent, baseline: 'vs prior period' }}
                sub={`− ${formatRupees(data.kpis.discountInPaise, { short: true })} discounts · − ${formatRupees(
                  data.kpis.commissionInPaise,
                  { short: true },
                )} commission`}
              />
              <KpiCard
                label="Due (this period)"
                value={formatRupees(data.kpis.dueInPaise, { short: true })}
                sub={
                  Number.isFinite(data.kpis.collectionRatePct)
                    ? `collected ${data.kpis.collectionRatePct}% of this period's bills`
                    : 'uncollected on this period’s bills'
                }
              />
              <KpiCard
                label="Open receivables (all-time)"
                value={formatRupees(data.kpis.outstandingInPaise, { short: true })}
                sub={
                  data.kpis.outstandingAgedBillCount > 0
                    ? `${data.kpis.outstandingAgedBillCount} aged >30d`
                    : '0 aged >30d'
                }
              />
              <KpiCard
                label="Discounts given"
                value={formatRupees(data.kpis.discountInPaise, { short: true })}
                sub={`${data.kpis.discountBillCount} bill${data.kpis.discountBillCount === 1 ? '' : 's'}`}
              />
            </div>

            <RevenueTrendSection trend={data.revenueTrend} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-2">
                <AgingCard
                  aging={data.aging}
                  total={totalAging}
                  selectedKey={agingFilter}
                  onSelect={setAgingFilter}
                />
              </div>
              <div className="lg:col-span-3">
                <OldestUnpaidCard
                  rows={data.oldestUnpaid}
                  filterKey={agingFilter}
                  filterLabel={agingFilter ? agingLabelByKey.get(agingFilter) ?? null : null}
                  onClearFilter={() => setAgingFilter(null)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CashByBranchCard rows={data.cashByBranch} />
              <CashByUserCard rows={data.cashByUser} totalCount={data.cashByUserTotalCount} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <DiscountLogCard rows={data.discountLog} totalCount={data.discountLogTotalCount} />
              </div>
              <div className="lg:col-span-2 space-y-4">
                <RefundsCard refunds={data.refunds} />
                <CancellationsCard cancellations={data.cancellations} />
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
