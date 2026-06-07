/**
 * Owner Doctors & payouts page — GET /api/owner/doctors
 *
 * Answers: who is profitable, what do I owe, where is referral money flowing.
 *
 * Layout:
 *   - 4 KPI: net referral / commission paid / liability / outsourced
 *   - Doctor leaderboard (table) — sorted by net descending
 *   - Payout aging (40%) + External flow in/out (60%)
 *   - Recent payout activity (full width)
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
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
} from './_shared/ownerUi';

interface DoctorsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: {
    netReferralRevenueInPaise: number;
    commissionPaidInPaise: number;
    liabilityOpenInPaise: number;
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
    owedInPaise: number;
    flagHighRate: boolean;
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
  const visible = showAll ? rows : rows.slice(0, 25);
  return (
    <SectionCard
      label="Doctor leaderboard"
      description="Sorted by net descending · high-rate doctors (>25%) tinted"
      rightSlot={
        rows.length > 25 ? (
          <button
            onClick={() => setShowAll((v) => !v)}
            style={{
              color: TOKENS.info,
              fontSize: 12,
              background: 'transparent',
              border: 0,
            }}
          >
            {showAll ? 'show top 25' : `show all (${rows.length})`}
          </button>
        ) : null
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
                <th className="pb-2 text-right">Owed</th>
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
                        <Link
                          to={`/people/doctors/${r.doctorId}`}
                          style={{ color: TOKENS.info, textDecoration: 'none' }}
                        >
                          {r.doctorName}
                        </Link>
                        <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                          {r.doctorNumber} ·{' '}
                          {r.doctorType === 'REFERRAL' ? 'referral' : 'clinic'}
                          {!r.isActive && ' · inactive'}
                        </div>
                      </span>
                    </div>
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {r.visits}
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
                  <td
                    className="py-2 text-right"
                    style={{
                      color: r.owedInPaise > 0 ? TOKENS.caution : TOKENS.textTertiary,
                    }}
                  >
                    {r.owedInPaise > 0 ? formatRupees(r.owedInPaise, { short: true }) : '—'}
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
        Net inflow {net >= 0 ? '+' : '−'}
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
                      {r.status}
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

export default function OwnerDoctorsPage() {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';

  const setBranchValue = (newBranch: string) => {
    setSearchParams(prev => {
      prev.set('branch', newBranch);
      return prev;
    });
  };

  const query = useQuery<DoctorsResponse>({
    queryKey: ['owner-doctors', period, branchValue],
    queryFn: () =>
      apiRequest<DoctorsResponse>(
        `${API_BASE}/owner/doctors?period=${period}&branch=${encodeURIComponent(branchValue)}`,
      ),
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
                label="Net referral revenue"
                value={formatRupees(data.kpis.netReferralRevenueInPaise, { short: true })}
                sub="gross − accrued commission"
              />
              <KpiCard
                label="Commission paid"
                value={formatRupees(data.kpis.commissionPaidInPaise, { short: true })}
                sub="paid in window"
              />
              <KpiCard
                label="Liability open"
                value={formatRupees(data.kpis.liabilityOpenInPaise, { short: true })}
                sub="awaiting payment"
              />
              <KpiCard
                label="Outsourced spend"
                value={formatRupees(data.kpis.outsourcedSpendInPaise, { short: true })}
                sub="referred to other centers"
              />
            </div>

            <LeaderboardCard rows={data.leaderboard} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-2">
                <PayoutAgingCard rows={data.payoutAging} />
              </div>
              <div className="lg:col-span-3">
                <ExternalFlowCard flow={data.externalFlow} />
              </div>
            </div>

            <RecentPayoutsCard rows={data.recentPayouts} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
