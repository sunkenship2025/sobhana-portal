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
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { formatPatientName } from '@/lib/patientDisplay';
import {
  TOKENS,
  formatRupees,
  formatIstDateTime,
  formatIstDate,
  SectionCard,
  StatRow,
  KpiCard,
  AgingBar,
  MiniBar,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  OwnerPageHeader,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
  NumericLink,
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
    discountInPaise: number;
    discountBillCount: number;
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
    transactionCount: number;
    flagSoloCash: boolean;
  }>;
   discountLog: Array<{
     billId: string;
     billNumber: string;
     patientName: string;
     patientTitle?: string | null;
     branchCode: string;
    discountInPaise: number;
    discountPercent: number;
    reason: string | null;
    flag: boolean;
  }>;
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
}

// ----- 30d trend (simple polyline) --------------------------------------

function RevenueTrendSection({ trend }: { trend: MoneyResponse['revenueTrend'] }) {
  if (trend.length === 0) {
    return null;
  }
  const max = Math.max(1, ...trend.map((p) => p.netInPaise));
  const sorted = [...trend.map((p) => p.netInPaise)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const ranked = trend
    .map((p, i) => ({ idx: i, dev: Math.abs(p.netInPaise - median) }))
    .sort((a, b) => b.dev - a.dev);
  const outlierIdx = new Set(ranked.slice(0, 2).map((r) => r.idx));

  return (
    <SectionCard
      label="Revenue trend"
      description="Daily net revenue across the period · two largest outliers marked"
    >
      <div className="relative" style={{ height: 160 }}>
        <svg
          viewBox={`0 0 ${trend.length * 14} 160`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
        >
          <polyline
            fill="none"
            stroke={TOKENS.info}
            strokeWidth="1.5"
            points={trend
              .map((p, i) => {
                const x = i * 14 + 7;
                const y = 160 - (p.netInPaise / max) * 140 - 8;
                return `${x},${y}`;
              })
              .join(' ')}
          />
          {trend.map((p, i) => {
            const x = i * 14 + 7;
            const y = 160 - (p.netInPaise / max) * 140 - 8;
            const isOutlier = outlierIdx.has(i);
            return (
              <circle
                key={p.date}
                cx={x}
                cy={y}
                r={isOutlier ? 3 : 1.5}
                fill={isOutlier ? TOKENS.critical : TOKENS.info}
              />
            );
          })}
        </svg>
      </div>
      <div
        className="mt-2 flex justify-between"
        style={{ color: TOKENS.textTertiary, fontSize: 11 }}
      >
        <span>{trend[0] && formatIstDate(`${trend[0].date}T00:00:00.000Z`)}</span>
        <span>{trend[trend.length - 1] && formatIstDate(`${trend[trend.length - 1].date}T00:00:00.000Z`)}</span>
      </div>
    </SectionCard>
  );
}

// ----- aging + oldest ---------------------------------------------------

function AgingCard({ aging, total }: { aging: MoneyResponse['aging']; total: number }) {
  const colors = [TOKENS.healthy, TOKENS.cautionLight, TOKENS.caution, TOKENS.critical];
  return (
    <SectionCard label="Receivables aging" description="By days since billed">
      {total === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No outstanding bills.</div>
      ) : (
        aging.map((b, i) => <AgingBar key={b.key} bucket={b} total={total} color={colors[i]} />)
      )}
    </SectionCard>
  );
}

function OldestUnpaidCard({ rows }: { rows: MoneyResponse['oldestUnpaid'] }) {
  return (
    <SectionCard
      label="Oldest unpaid"
      description="Top 5 oldest open bills"
      rightSlot={
        rows.length > 0 ? (
          <Link
            to="/money/bills?aging=open"
            style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
          >
            send all reminders ↗
          </Link>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>Everything is paid.</div>
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
            {rows.map((r) => (
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
                  {formatRupees(r.owedInPaise)}
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
        visible.map((b) => (
          <div
            key={b.branchId}
            className="py-2"
            style={{
              borderTop: `0.5px solid ${TOKENS.border}`,
              background: b.flagHeavyCash ? '#FFF8E1' : undefined,
              padding: 8,
            }}
          >
            <div className="mb-1 flex items-baseline justify-between" style={{ fontSize: 13 }}>
              <span style={{ color: TOKENS.textPrimary }}>
                {b.branchName}{' '}
                <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>({b.branchCode})</span>
              </span>
              <span style={{ color: TOKENS.textPrimary }}>
                {formatRupees(b.totalInPaise, { short: true })}
              </span>
            </div>
            <div
              className="flex w-full overflow-hidden"
              style={{ height: 12, borderRadius: 3 }}
            >
              <div
                style={{
                  width: `${b.cashSharePct}%`,
                  background: TOKENS.cash,
                }}
              />
              <div
                style={{
                  width: `${100 - b.cashSharePct}%`,
                  background: TOKENS.online,
                }}
              />
            </div>
            <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
              cash {b.cashSharePct}% · online {100 - b.cashSharePct}%
            </div>
          </div>
        ))
      )}
    </SectionCard>
  );
}

function CashByUserCard({ rows }: { rows: MoneyResponse['cashByUser'] }) {
  return (
    <SectionCard
      label="Collected by user"
      description="Solo-cash users (>80% cash) tinted amber"
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No transactions in window.</div>
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
              <th className="pb-2">User</th>
              <th className="pb-2 text-right">Cash</th>
              <th className="pb-2 text-right">Online</th>
              <th className="pb-2 text-right">Txns</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((u) => (
              <tr
                key={u.userId}
                style={{
                  borderTop: `0.5px solid ${TOKENS.border}`,
                }}
              >
                <td className="py-2">
                  <span style={{ color: TOKENS.textPrimary }}>{u.userName}</span>
                  <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>{u.branchName}</div>
                </td>
                <td
                  className="py-2 text-right"
                  style={{
                    color: TOKENS.textPrimary,
                    background: u.flagSoloCash ? '#FFF8E1' : undefined,
                  }}
                >
                  {formatRupees(u.cashInPaise, { short: true })}
                </td>
                <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                  {formatRupees(u.onlineInPaise, { short: true })}
                </td>
                <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                  {u.transactionCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

// ----- discounts + refunds ---------------------------------------------

function DiscountLogCard({ rows }: { rows: MoneyResponse['discountLog'] }) {
  return (
    <SectionCard
      label="Discount log"
      description="Discounts > 30% or > ₹1,000 tinted red"
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No discounts in window.</div>
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
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((d) => (
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
                    {formatRupees(d.discountInPaise)}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function RefundsCard({ refunds }: { refunds: MoneyResponse['refunds'] }) {
  return (
    <SectionCard label="Refunds">
      <div className="font-medium" style={{ fontSize: 22, color: TOKENS.textPrimary }}>
        {formatRupees(refunds.totalInPaise)}
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
                <span style={{ color: TOKENS.textPrimary }}>                {formatPatientName(r.patientName, r.patientTitle)}</span>
                <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                  {' '}
                  · {r.billNumber}
                </span>
              </span>
              <span style={{ color: TOKENS.textPrimary }}>
                {formatRupees(r.refundedInPaise)}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ----- main page --------------------------------------------------------

export default function OwnerMoneyPage() {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [branchValue, setBranchValue] = useState<string>('all');

  const query = useQuery<MoneyResponse>({
    queryKey: ['owner-money', period, branchValue],
    queryFn: () =>
      apiRequest<MoneyResponse>(
        `${API_BASE}/owner/money?period=${period}&branch=${encodeURIComponent(branchValue)}`,
      ),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const data = query.data;
  const totalAging = data?.aging.reduce((s, b) => s + b.amountInPaise, 0) ?? 0;

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
              <PeriodFilter value={period} onChange={setPeriod} />
              <BranchFilter value={branchValue} onChange={setBranchValue} />
              <RefreshButton isFetching={query.isFetching} onClick={() => query.refetch()} />
            </>
          }
        />

        {query.isLoading && <FullPageSkeleton />}
        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="Gross billed"
                value={formatRupees(data.kpis.grossInPaise, { short: true })}
                delta={{ percent: data.kpis.grossDeltaPercent, baseline: 'vs prior period' }}
              />
              <KpiCard
                label="Net to you"
                value={formatRupees(data.kpis.netInPaise, { short: true })}
                delta={{ percent: data.kpis.netDeltaPercent, baseline: 'vs prior period' }}
              />
              <KpiCard
                label="Outstanding"
                value={formatRupees(data.kpis.outstandingInPaise, { short: true })}
                sub={
                  data.kpis.outstandingAgedInPaise > 0
                    ? `${formatRupees(data.kpis.outstandingAgedInPaise, { short: true })} > 30 days old`
                    : 'all current'
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
                <AgingCard aging={data.aging} total={totalAging} />
              </div>
              <div className="lg:col-span-3">
                <OldestUnpaidCard rows={data.oldestUnpaid} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CashByBranchCard rows={data.cashByBranch} />
              <CashByUserCard rows={data.cashByUser} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <DiscountLogCard rows={data.discountLog} />
              </div>
              <div className="lg:col-span-2">
                <RefundsCard refunds={data.refunds} />
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
