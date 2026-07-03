/**
 * Owner Doctors & payouts page — GET /api/owner/doctors
 *
 * Answers: who is profitable, what commission is accruing, where referral
 * money is flowing.
 *
 * Layout:
 *   - 6 KPI: net kept / net referral / net clinic / total commission / commission rate / outsourced
 *   - Doctor leaderboard (table) — sorted by net descending
 *   - Payout aging (40%) + External flow in/out (60%)
 *   - Recent payout activity (full width)
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import {
  TOKENS,
  formatRupees,
  formatIstDateTime,
  formatIstDate,
  SectionCard,
  KpiCard,
  AgingBar,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  OwnerPageHeader,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
  DeltaPercent,
} from './_shared/ownerUi';

interface DoctorsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: {
    netReferralRevenueInPaise: number;
    netClinicRevenueInPaise: number;
    commissionTotalInPaise: number;
    commissionRatePct: number | null;
    outsourcedSpendInPaise: number;
  };
  leaderboard: Array<{
    doctorId: string;
    doctorNumber: string;
    doctorType: 'REFERRAL' | 'CLINIC';
    doctorName: string;
    isActive: boolean;
    visits: number;
    grossInPaise: number;
    commissionInPaise: number;
    ratePercent: number;
    netInPaise: number;
    flagHighRate: boolean;
    visitsDeltaPercent: number | null;
  }>;
  payoutAging: Array<{
    key: '0_7' | '8_15' | '16_30' | '30_plus';
    label: string;
    amountInPaise: number;
    rowCount: number;
  }>;
  externalFlow: {
    outgoing: { totalInPaise: number; testCount: number; centerCount: number; topCenterName: string | null };
    incoming: { totalInPaise: number; testCount: number; centerCount: number; topCenterName: string | null };
  };
  recentPayouts: Array<{
    id: string;
    doctorName: string;
    doctorType: 'REFERRAL' | 'CLINIC' | 'DIAGNOSTIC_CENTER';
    periodStart: string;
    periodEnd: string;
    amountInPaise: number;
    status: 'paid' | 'reviewed' | 'derived';
    reference: string | null;
  }>;
}

// ----- leaderboard ------------------------------------------------------

function LeaderboardCard({ rows }: { rows: DoctorsResponse['leaderboard'] }) {
  const [showAll, setShowAll] = useState(false);
  const [activeOnly, setActiveOnly] = useState(true);
  // Active doctors first (preserving net-desc order within each group),
  // then optionally hide inactive entirely.
  const sorted = [...rows].sort((a, b) => Number(b.isActive) - Number(a.isActive));
  const filtered = activeOnly ? sorted.filter((r) => r.isActive) : sorted;
  const inactiveCount = rows.length - rows.filter((r) => r.isActive).length;
  const visible = showAll ? filtered : filtered.slice(0, 25);
  return (
    <SectionCard
      label="Doctor leaderboard"
      description="Sorted by net descending · high-rate doctors (>25%) tinted"
      rightSlot={
        <div className="flex items-center gap-3">
          {inactiveCount > 0 && (
            <button
              onClick={() => setActiveOnly((v) => !v)}
              style={{
                color: activeOnly ? TOKENS.info : TOKENS.textTertiary,
                fontSize: 12,
                background: 'transparent',
                border: 0,
              }}
            >
              {activeOnly ? `active only (+${inactiveCount} hidden)` : 'show all'}
            </button>
          )}
          {filtered.length > 25 ? (
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                color: TOKENS.info,
                fontSize: 12,
                background: 'transparent',
                border: 0,
              }}
            >
              {showAll ? 'show top 25' : `show all (${filtered.length})`}
            </button>
          ) : null}
        </div>
      }
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          No doctor activity in this period.
        </div>
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
                <th className="pb-2">Doctor</th>
                <th className="pb-2 text-right">Visits</th>
                <th className="pb-2 text-right">Gross</th>
                <th className="pb-2 text-right">Commission</th>
                <th className="pb-2 text-right">Rate</th>
                <th className="pb-2 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.doctorId}
                  style={{
                    borderTop: `0.5px solid ${TOKENS.border}`,
                    background: r.flagHighRate ? '#FCEBEB30' : undefined,
                    opacity: r.isActive ? 1 : 0.6,
                  }}
                >
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <span
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          background:
                            r.doctorType === 'REFERRAL' ? '#E5F0FB' : '#E5F4ED',
                          color:
                            r.doctorType === 'REFERRAL' ? TOKENS.info : TOKENS.healthy,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 11,
                          fontWeight: 500,
                        }}
                      >
                        {r.doctorName
                          .split(' ')
                          .filter(Boolean)
                          .map((s) => s[0])
                          .slice(0, 2)
                          .join('')
                          .toUpperCase() || '—'}
                      </span>
                      <span>
                        <span style={{ color: TOKENS.textPrimary }}>
                          {r.doctorName}
                        </span>
                        <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                          {r.doctorNumber} ·{' '}
                          {r.doctorType === 'REFERRAL' ? 'referral' : 'clinic'}
                          {!r.isActive && ' · inactive'}
                        </div>
                      </span>
                    </div>
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    <span>{r.visits}</span>
                    <DeltaPercent value={r.visitsDeltaPercent} className="ml-1" />
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(r.grossInPaise, { short: true })}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(r.commissionInPaise, { short: true })}
                  </td>
                  <td
                    className="py-2 text-right"
                    style={{
                      color: r.flagHighRate ? TOKENS.critical : TOKENS.textPrimary,
                    }}
                  >
                    {r.ratePercent}%
                  </td>
                  <td
                    className="py-2 text-right font-medium"
                    style={{ color: TOKENS.textPrimary }}
                  >
                    {formatRupees(r.netInPaise, { short: true })}
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

// ----- payout aging + external flow ------------------------------------

function PayoutAgingCard({ rows }: { rows: DoctorsResponse['payoutAging'] }) {
  const total = rows.reduce((s, r) => s + r.amountInPaise, 0);
  const colors = [TOKENS.healthy, TOKENS.cautionLight, TOKENS.caution, TOKENS.critical];
  return (
    <SectionCard
      label="Payout aging"
      description="By days since derivedAt"
    >
      {total === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          No open payouts.
        </div>
      ) : (
        rows.map((b, i) => (
          <AgingBar key={b.key} bucket={b} total={total} color={colors[i]} />
        ))
      )}
    </SectionCard>
  );
}

function ExternalFlowCard({ flow }: { flow: DoctorsResponse['externalFlow'] }) {
  const net = flow.incoming.totalInPaise - flow.outgoing.totalInPaise;
  const netColor = net >= 0 ? TOKENS.healthy : TOKENS.critical;
  return (
    <SectionCard
      label="External diagnostic flow"
      description="Tests sent to & received from external centers"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div
          style={{
            padding: 12,
            background: '#FCEBEB30',
            borderRadius: 8,
            border: `0.5px solid ${TOKENS.border}`,
          }}
        >
          <div
            className="font-medium uppercase"
            style={{ color: TOKENS.critical, fontSize: 11, letterSpacing: '0.06em' }}
          >
            Outgoing (we refer to)
          </div>
          <div
            className="mt-1 font-medium"
            style={{ fontSize: 22, color: TOKENS.textPrimary }}
          >
            {formatRupees(flow.outgoing.totalInPaise, { short: true })}
          </div>
          <div style={{ fontSize: 12, color: TOKENS.textSecondary }}>
            {flow.outgoing.testCount} tests · {flow.outgoing.centerCount} centers
          </div>
          {flow.outgoing.topCenterName && (
            <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
              top: {flow.outgoing.topCenterName}
            </div>
          )}
        </div>

        <div
          style={{
            padding: 12,
            background: '#E5F4ED60',
            borderRadius: 8,
            border: `0.5px solid ${TOKENS.border}`,
          }}
        >
          <div
            className="font-medium uppercase"
            style={{ color: TOKENS.healthy, fontSize: 11, letterSpacing: '0.06em' }}
          >
            Incoming (referred to us)
          </div>
          <div
            className="mt-1 font-medium"
            style={{ fontSize: 22, color: TOKENS.textPrimary }}
          >
            {formatRupees(flow.incoming.totalInPaise, { short: true })}
          </div>
          <div style={{ fontSize: 12, color: TOKENS.textSecondary }}>
            {flow.incoming.testCount} tests · {flow.incoming.centerCount} centers
          </div>
          {flow.incoming.topCenterName && (
            <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
              top: {flow.incoming.topCenterName}
            </div>
          )}
        </div>
      </div>
      <div
        className="mt-3 border-t pt-2 text-right"
        style={{ borderColor: TOKENS.border, fontSize: 13, color: netColor }}
      >
        Net inflow {net >= 0 ? '+' : '-'}
        {formatRupees(Math.abs(net), { short: true })}
      </div>
    </SectionCard>
  );
}

// ----- recent payouts ---------------------------------------------------

function RecentPayoutsCard({ rows }: { rows: DoctorsResponse['recentPayouts'] }) {
  if (rows.length === 0) {
    return (
      <SectionCard label="Recent payout activity">
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          No payout activity yet.
        </div>
      </SectionCard>
    );
  }
  return (
    <SectionCard label="Recent payout activity">
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
              <th className="pb-2">Doctor</th>
              <th className="pb-2">Period</th>
              <th className="pb-2 text-right">Amount</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const statusColor =
                r.status === 'paid'
                  ? TOKENS.healthy
                  : r.status === 'reviewed'
                    ? TOKENS.info
                    : TOKENS.caution;
              return (
                <tr key={r.id} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                  <td className="py-2">
                    <span style={{ color: TOKENS.textPrimary }}>{r.doctorName}</span>
                    <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                      {r.doctorType === 'REFERRAL'
                        ? 'referral'
                        : r.doctorType === 'CLINIC'
                          ? 'clinic'
                          : 'external center'}
                    </div>
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                    {formatIstDate(r.periodStart)} → {formatIstDate(r.periodEnd)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(r.amountInPaise, { short: true })}
                  </td>
                  <td className="py-2">
                    <span
                      style={{
                        background: `${statusColor}1A`,
                        color: statusColor,
                        fontSize: 11,
                        padding: '2px 6px',
                        borderRadius: 3,
                        textTransform: 'capitalize',
                      }}
                    >
                      {r.status === 'derived' ? 'pending review' : r.status}
                    </span>
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                    {r.reference ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ----- main page --------------------------------------------------------

// Full date-filter set, matching the Money page.
const DOCTOR_PERIOD_OPTS: PeriodKey[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'mtd',
  'ytd',
  'custom',
];

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function OwnerDoctorsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';
  const rawPeriod = searchParams.get('period');
  const period: PeriodKey = DOCTOR_PERIOD_OPTS.includes(rawPeriod as PeriodKey)
    ? (rawPeriod as PeriodKey)
    : '30d';
  const customStart = searchParams.get('start') || '';
  const customEnd = searchParams.get('end') || '';
  const customReady = period === 'custom' && Boolean(customStart) && Boolean(customEnd);

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

  const doctorsParams =
    period === 'custom'
      ? `period=custom&start=${customStart}&end=${customEnd}&branch=${encodeURIComponent(branchValue)}`
      : `period=${period}&branch=${encodeURIComponent(branchValue)}`;

  const query = useQuery<DoctorsResponse>({
    queryKey: ['owner-doctors', period, branchValue, customStart, customEnd],
    queryFn: () => apiRequest<DoctorsResponse>(`${API_BASE}/owner/doctors?${doctorsParams}`),
    enabled: period !== 'custom' || customReady,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
  const data = query.data;

  return (
    <AppLayout context="owner" hideContextBanner>
      <div
        className="mx-auto"
        style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}
      >
        <OwnerPageHeader
          title="Doctors & payouts"
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
                options={DOCTOR_PERIOD_OPTS}
                customRange={{ start: customStart || todayKey(), end: customEnd || todayKey() }}
                onCustomRangeChange={setCustomRange}
              />
              <BranchFilter value={branchValue} onChange={setBranchValue} />
              <RefreshButton isFetching={query.isFetching} onClick={() => query.refetch()} />
            </>
          }
        />

        {query.isLoading && <FullPageSkeleton />}
        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {/* Headline: what the centre actually kept from doctor-driven
                  business after paying out commissions. */}
              <KpiCard
                label="Net we kept (after commissions)"
                value={formatRupees(
                  data.kpis.netReferralRevenueInPaise + data.kpis.netClinicRevenueInPaise,
                  { short: true },
                )}
                sub="referral + clinic, after paying doctors"
              />
              <KpiCard
                label="Net from referral doctors"
                value={formatRupees(data.kpis.netReferralRevenueInPaise, { short: true })}
                sub="gross − accrued commission"
              />
              {/* Clinic-doctor net; hidden by display-conditional when OP/IP is off for the tenant (not a toggle framework). */}
              <KpiCard
                label="Net from clinic doctors"
                value={formatRupees(data.kpis.netClinicRevenueInPaise, { short: true })}
                sub="consultation − accrued commission"
              />
              <KpiCard
                label="Total commission"
                value={formatRupees(data.kpis.commissionTotalInPaise, { short: true })}
                sub="what doctors earned · this period"
              />
              <KpiCard
                label="Commission rate"
                value={data.kpis.commissionRatePct === null ? '—' : `${data.kpis.commissionRatePct}%`}
                sub="of doctor-driven revenue"
              />
              <KpiCard
                label="Outsourced spend"
                value={formatRupees(data.kpis.outsourcedSpendInPaise, { short: true })}
                sub="referred to other centers"
              />
            </div>

            {/* Payout aging + external flow first, then the per-doctor detail. */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-2">
                <PayoutAgingCard rows={data.payoutAging} />
              </div>
              <div className="lg:col-span-3">
                <ExternalFlowCard flow={data.externalFlow} />
              </div>
            </div>

            <LeaderboardCard rows={data.leaderboard} />

            <RecentPayoutsCard rows={data.recentPayouts} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
