/**
 * Owner Money page — GET /api/owner/money
 *
 * Net collected (cash + online − refunds) is the basis, as on the dashboard;
 * every list that splits money adds back up to it.
 *
 * Top to bottom: what came in and what left it (KPIs, each outflow as a share
 * of collected) · money over the period — by hour for a single day — beside
 * how it came in · where it goes: commission and money given back ·
 * discounts · who collected it beside open dues · the breakdown table.
 *
 * A single day is compared with the same weekday a week earlier.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Printer, Download, AlertTriangle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { formatPatientName } from '@/lib/patientDisplay';
import { discountReasonGroup } from '@/lib/discountReasons';
import { DaySheetResponse } from './moneyDaySheet';
import { MoneyBreakdown, type BreakdownData } from './MoneyBreakdown';
import { KpiTile, ComparisonTrendChart, StatementLine, BarList, SplitBar, GroupLabel, TH, ROW, TOTAL_ROW, type BarRow } from './_shared/dashboardCharts';
import {
  TOKENS,
  formatRupees,
  formatIstDateTime,
  formatIstDate,
  SectionCard,
  EmptyState,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  OwnerPageHeader,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
  DomainFilter,
  DomainKey,
  domainFromParam,
  PERIOD_LABEL,
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
    couponInPaise?: number;
    commissionInPaise: number;
    collectionRatePct: number | null;
    grossDeltaPercent: number | null;
    netDeltaPercent: number | null;
    netCollectedInPaise?: number;
    collectedDeltaPercent?: number | null;
    cashInPaise?: number;
    onlineInPaise?: number;
    refundsInPaise?: number;
    cancelledInPaise?: number;
    commissionSplit?: { referralInPaise: number; partnerInPaise: number; clinicInPaise: number };
    prior?: { netCollected: number; net: number; cash: number; online: number; refunds: number; discount: number; commission?: number; cancelled?: number };
  };
  comparison?: { startIso: string; endIso: string; sameWeekday: boolean };
  byHour?: { hour: number; cash: number; online: number; refunds: number; prior: { cash: number; online: number; refunds: number } }[] | null;
  revenueTrend: {
    date: string;
    netInPaise: number;
    collectedInPaise?: number;
    cash?: number;
    online?: number;
    refunds?: number;
    discount?: number;
    prior?: { collected: number; net: number; cash: number; online: number; refunds: number; discount: number };
  }[];
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
    isCoupon?: boolean;
  }>;
  discountLogTotalCount: number;
  refunds: {
    totalInPaise: number;
    count: number;
    pctOfGross: number | null;
    pctOfCollected?: number | null;
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
    pctOfCollected?: number | null;
    recent: Array<{
      billNumber: string;
      patientName: string;
      patientTitle?: string | null;
      reversedInPaise: number;
      tests?: number;
      reason: string | null;
      cancelledAt: string;
    }>;
  };
  /** Absent on a backend older than this bundle (deploy skew). */
  breakdown?: BreakdownData;
}

const rupees = (p: number) => formatRupees(Math.round(p / 100) * 100);
const rupeesShort = (p: number) => formatRupees(p, { short: true });
const rupeesAxis = (p: number) => formatRupees(p, { short: true }).replace('.0', '');
const change = (now: number, before: number | undefined) =>
  before && before > 0 ? Math.round(((now - before) / before) * 100) : null;
const deltaOf = (now: number, before: number | undefined) => {
  const c = change(now, before);
  return c == null ? null : { text: `${Math.abs(c)}%`, up: c >= 0 };
};
/** Trailing 7-day mean at each day; the first six are seeded from `seed` (the days before). */
function avg7(values: number[], seed: number[] = []): (number | null)[] {
  const all = [...seed, ...values];
  return values.map((_, i) => {
    const end = seed.length + i + 1;
    return end < 7 ? null : all.slice(end - 7, end).reduce((s, v) => s + v, 0) / 7;
  });
}

// ----- KPIs ---------------------------------------------------------------

/** "vs last Tue" for a single day, else "vs prior period". */
function vsLabel(data: MoneyResponse): string {
  if (!data.comparison?.sameWeekday) return 'vs prior period';
  const day = new Date(data.comparison.startIso).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' });
  return `vs last ${day}`;
}

function MoneyKpis({ data }: { data: MoneyResponse }) {
  const k = data.kpis;
  const t = data.revenueTrend;
  const p = k.prior;
  const vs = vsLabel(data);
  type Day = NonNullable<MoneyResponse['revenueTrend'][number]['prior']>;
  // 7-day average of one series, seeded from the period before.
  const spark = (key: keyof Day) =>
    t.length < 2
      ? undefined
      : avg7(t.map((d) => (key === 'collected' ? d.collectedInPaise ?? d.netInPaise : key === 'net' ? d.netInPaise : d[key] ?? 0)), t.map((d) => d.prior?.[key] ?? 0));
  const collected = k.netCollectedInPaise ?? 0;
  const share = (v: number) => (collected > 0 ? ` · ${((v / collected) * 100).toFixed(1)}% of collected` : '');
  const givenBack = (k.refundsInPaise ?? 0) + (k.cancelledInPaise ?? 0);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="Net collected"
        hint="Cash + online − refunds"
        value={rupees(collected)}
        delta={deltaOf(collected, p?.netCollected)}
        vs={vs}
        spark={spark('collected')}
      />
      <KpiTile
        label="Net to you"
        hint="Net collected − commission"
        value={rupees(k.netInPaise)}
        delta={deltaOf(k.netInPaise, p?.net)}
        vs={vs}
        spark={spark('net')}
      />
      <KpiTile
        label="Commission"
        hint={`Earned by referring doctors and partners${share(k.commissionInPaise)}`}
        value={rupees(k.commissionInPaise)}
        delta={deltaOf(k.commissionInPaise, p?.commission)}
        deltaGoodWhenUp={false}
        vs={vs}
        footnote={share(k.commissionInPaise).slice(3)}
      />
      <KpiTile
        label="Discounts given"
        hint={`${k.discountBillCount} bills${k.couponInPaise ? ` · ${rupeesShort(k.couponInPaise)} by offer code` : ''}${share(k.discountInPaise)}`}
        value={rupees(k.discountInPaise)}
        delta={deltaOf(k.discountInPaise, p?.discount)}
        deltaGoodWhenUp={false}
        vs={vs}
        spark={spark('discount')}
      />
      <KpiTile
        label="Refunds + cancellations"
        hint={`Refunds paid out ${rupees(k.refundsInPaise ?? 0)} · charges cancelled ${rupees(k.cancelledInPaise ?? 0)}`}
        value={rupees(givenBack)}
        delta={p?.cancelled != null ? deltaOf(givenBack, p.refunds + p.cancelled) : null}
        deltaGoodWhenUp={false}
        vs={vs}
        spark={spark('refunds')}
      />
      <Link to="/money/bills?aging=open" className="block h-full" style={{ textDecoration: 'none' }}>
        <KpiTile
          label="Open dues"
          hint="Still to collect, on all bills"
          value={rupees(k.outstandingInPaise)}
          delta={null}
          footnote={`${k.outstandingAgedBillCount} bill${k.outstandingAgedBillCount === 1 ? '' : 's'} over 30 days ↗`}
        />
      </Link>
    </div>
  );
}

// ----- each day's money + how it came in ----------------------------------

const SERIES_BLUE = '#2a78d6';
const CASH = TOKENS.cash;
const ONLINE = TOKENS.online;
const REFUND = TOKENS.commissionBar;

function DailyMoneyCard({
  trend,
  periodLabel,
  onPickDay,
}: {
  trend: MoneyResponse['revenueTrend'];
  periodLabel: string;
  onPickDay: (date: string) => void;
}) {
  const collected = (d: MoneyResponse['revenueTrend'][number]) => d.collectedInPaise ?? d.netInPaise;
  const long = trend.length >= 14;
  const hasParts = trend.some((d) => d.cash != null);
  const days = trend.map((d) => ({ date: d.date, value: collected(d), prior: d.prior?.collected ?? null }));
  const average = long ? avg7(trend.map(collected), trend.map((d) => d.prior?.collected ?? 0)) : days.map((d) => d.value);
  const priorAverage = long ? avg7(trend.map((d) => d.prior?.collected ?? 0)) : days.map((d) => d.prior);
  const swatch = (color: string, label: string, line?: 'solid' | 'dashed') => (
    <span className="inline-flex items-center gap-1.5">
      {line ? (
        <span style={{ width: 14, display: 'inline-block', borderTop: `2px ${line} ${color}` }} />
      ) : (
        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      )}
      {label}
    </span>
  );
  return (
    <SectionCard
      label={`Net collected per day · ${periodLabel}`}
      description="Click a day to see just that day"
      className="h-full"
    >
      <div className="mb-1 flex flex-wrap gap-4" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
        {hasParts && swatch(ONLINE, 'Online')}
        {hasParts && swatch(CASH, 'Cash')}
        {hasParts && swatch(REFUND, 'Refunds')}
        {swatch(TOKENS.info, long ? '7-day average' : 'Net collected', 'solid')}
        {swatch(TOKENS.textTertiary, long ? 'Prior period, 7-day average' : 'Prior period', 'dashed')}
      </div>
      <ComparisonTrendChart
        days={days}
        average={average}
        priorAverage={priorAverage}
        format={rupeesAxis}
        onPickDay={onPickDay}
        height={300}
        valueLabel="Net collected"
        parts={
          hasParts
            ? [
                { label: 'Online', color: ONLINE, values: trend.map((d) => d.online ?? 0) },
                { label: 'Cash', color: CASH, values: trend.map((d) => d.cash ?? 0) },
                { label: 'Refunds', color: REFUND, values: trend.map((d) => -(d.refunds ?? 0)) },
              ]
            : undefined
        }
      />
    </SectionCard>
  );
}

const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

/** A single day: money by hour, against the same hours a week earlier. */
function HourlyMoneyCard({ data, periodLabel }: { data: MoneyResponse; periodLabel: string }) {
  const hours = data.byHour ?? [];
  const net = (h: { cash: number; online: number; refunds: number }) => h.cash + h.online - h.refunds;
  const busy = hours.filter((h) => net(h) !== 0 || net(h.prior) !== 0).map((h) => h.hour);
  const from = Math.min(7, ...busy);
  const to = Math.max(21, ...busy);
  const shown = hours.filter((h) => h.hour >= from && h.hour <= to);
  const last = vsLabel(data).replace(/^vs /, '');
  const swatch = (color: string, label: string, dashed?: boolean) => (
    <span className="inline-flex items-center gap-1.5">
      {dashed ? (
        <span style={{ width: 14, display: 'inline-block', borderTop: `2px dashed ${color}` }} />
      ) : (
        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      )}
      {label}
    </span>
  );
  return (
    <SectionCard label={`Money by hour · ${periodLabel}`} description={`When it came in, against the same hours ${last}`} className="h-full">
      <div className="mb-1 flex flex-wrap gap-4" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
        {swatch(ONLINE, 'Online')}
        {swatch(CASH, 'Cash')}
        {swatch(REFUND, 'Refunds')}
        {swatch(TOKENS.textTertiary, `Same hour ${last}`, true)}
      </div>
      <ComparisonTrendChart
        days={shown.map((h) => ({ date: String(h.hour), value: net(h), prior: net(h.prior) }))}
        average={shown.map(() => null)}
        priorAverage={shown.map((h) => net(h.prior))}
        format={rupeesAxis}
        height={300}
        valueLabel="Net collected"
        axisLabel={(k) => hourLabel(Number(k))}
        titleLabel={(k) => `${hourLabel(Number(k))} – ${hourLabel(Number(k) + 1)}`}
        parts={[
          { label: 'Online', color: ONLINE, values: shown.map((h) => h.online) },
          { label: 'Cash', color: CASH, values: shown.map((h) => h.cash) },
          { label: 'Refunds', color: REFUND, values: shown.map((h) => -h.refunds) },
        ]}
      />
    </SectionCard>
  );
}

function HowItCameInCard({ data, periodLabel }: { data: MoneyResponse; periodLabel: string }) {
  const k = data.kpis;
  const branches = data.cashByBranch.filter((b) => b.totalInPaise !== 0);
  return (
    <SectionCard label={`How it came in · ${periodLabel}`} className="h-full">
      <StatementLine label="Cash" value={k.cashInPaise ?? 0} />
      <StatementLine label="Online" value={k.onlineInPaise ?? 0} />
      {(k.refundsInPaise ?? 0) > 0 && <StatementLine label="Refunds paid out" value={-(k.refundsInPaise ?? 0)} />}
      <StatementLine label="Net collected" value={k.netCollectedInPaise ?? 0} total />
      {branches.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
            <span>By branch · cash share</span>
            <span>more than 70% cash is tinted</span>
          </div>
          {branches.map((b) => (
            <CashByBranchRow key={b.branchId} b={b} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ----- aging + oldest ---------------------------------------------------

type AgingKey = MoneyResponse['aging'][number]['key'];

function OpenDuesCard({
  data,
  selectedKey,
  onSelect,
}: {
  data: MoneyResponse;
  selectedKey: AgingKey | null;
  onSelect: (key: AgingKey | null) => void;
}) {
  // Older is worse: the same bar, warming from neutral to red.
  const colors = [SERIES_BLUE, TOKENS.cautionLight, TOKENS.caution, TOKENS.critical];
  const { aging, kpis } = data;
  const total = aging.reduce((s, b) => s + b.amountInPaise, 0);
  const rows = selectedKey ? data.oldestUnpaid.filter((r) => agingKeyForDays(r.daysOverdue) === selectedKey) : data.oldestUnpaid;
  return (
    <SectionCard
      label="Open dues"
      description={`Still to collect on all bills${kpis.dueInPaise > 0 ? ` · ${rupees(kpis.dueInPaise)} of it billed in this period` : ''} · click an age to filter`}
      className="h-full"
      rightSlot={
        selectedKey ? (
          <button
            onClick={() => onSelect(null)}
            style={{ color: TOKENS.info, background: 'transparent', border: 0, fontSize: 12, padding: 0, cursor: 'pointer' }}
          >
            clear filter
          </button>
        ) : null
      }
    >
      {total === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>Everything is paid.</div>
      ) : (
        <>
          <BarList
            keepOrder
            rows={aging.map((b, i) => ({
              key: b.key,
              label: b.label,
              value: b.amountInPaise,
              note: `${b.billCount} bill${b.billCount === 1 ? '' : 's'}`,
              color: colors[i],
            }))}
            format={rupees}
            totalLabel="Open dues"
            onPick={(k) => onSelect(selectedKey === k ? null : (k as AgingKey))}
            selected={selectedKey}
          />
          <div className="mt-4 mb-1 font-medium" style={{ fontSize: 13 }}>Open longest</div>
          {rows.length === 0 ? (
            <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>None of the five oldest are in this age.</div>
          ) : (
            rows.map((r) => (
              <div key={r.billId} className="flex items-baseline justify-between gap-3 py-1.5" style={{ ...ROW, fontSize: 13 }}>
                <span className="min-w-0">
                  <Link to={`/clinic/patient-360/${r.patientId}`} style={{ color: TOKENS.info, textDecoration: 'none' }}>
                    {formatPatientName(r.patientName, r.patientTitle)}
                  </Link>
                  <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {r.billNumber}</span>
                </span>
                <span className="whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: r.daysOverdue > 30 ? TOKENS.critical : TOKENS.caution, fontSize: 12 }}>{r.daysOverdue} days</span>
                  {'  '}
                  {rupees(r.owedInPaise)}
                </span>
              </div>
            ))
          )}
        </>
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

// ----- cash by branch / user -------------------------------------------

/** One branch: what came in, split cash / online on the standard thin bar. */
function CashByBranchRow({ b }: { b: MoneyResponse['cashByBranch'][number] }) {
  return (
    <div className="py-2" style={{ ...ROW, background: b.flagHeavyCash ? '#FFF8E1' : undefined }}>
      <div className="flex items-baseline justify-between gap-3" style={{ fontSize: 13 }}>
        <span>
          {b.branchName.replace(/^Sobhana - /, '')}
          <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {b.branchCode}</span>
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{rupeesShort(b.totalInPaise)}</span>
      </div>
      <div className="mt-1">
        <SplitBar
          parts={[
            { label: 'Cash', value: b.cashInPaise, color: CASH },
            { label: 'Online', value: b.onlineInPaise, color: ONLINE },
          ]}
        />
      </div>
      <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        cash {b.cashSharePct}% · online {100 - b.cashSharePct}%
      </div>
    </div>
  );
}

function StaffCard({
  rows,
  total,
}: {
  rows: MoneyResponse['cashByUser'];
  total: number;
}) {
  const th = TH;
  const sum = (f: (u: MoneyResponse['cashByUser'][number]) => number) => rows.reduce((s, u) => s + f(u), 0);
  return (
    <SectionCard
      label="Who collected it"
      description="Net of refunds each person paid out · more than 80% cash is tinted"
      className="h-full"
    >
      {rows.length === 0 ? (
        <EmptyState label="No payments in this window" />
      ) : (
        <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th className="pb-2 text-left" style={th}>Staff</th>
              <th className="pb-2 text-right" style={th}>Cash</th>
              <th className="pb-2 text-right" style={th}>Online</th>
              <th className="pb-2 text-right" style={th}>Total</th>
              <th className="pb-2 text-right" style={th}>Share</th>
              <th className="pb-2 text-right" style={th}>Payments</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr
                key={u.userId}
                style={{ ...ROW, background: u.flagSoloCash ? '#FFF8E1' : undefined }}
              >
                <td className="py-2">
                  {u.userName}
                  <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {u.branchName.replace(/^Sobhana - /, '')}</span>
                </td>
                <td className="py-2 text-right">{rupeesShort(u.cashInPaise)}</td>
                <td className="py-2 text-right">{rupeesShort(u.onlineInPaise)}</td>
                <td className="py-2 text-right font-medium">{rupeesShort(u.totalCollectedInPaise)}</td>
                <td className="py-2 text-right" style={{ color: TOKENS.textSecondary }}>
                  {total > 0 ? `${Math.round((u.totalCollectedInPaise / total) * 100)}%` : ''}
                </td>
                <td className="py-2 text-right" style={{ color: TOKENS.textSecondary }}>{u.transactionCount.toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium" style={TOTAL_ROW}>
              <td className="pt-2">Net collected</td>
              <td className="pt-2 text-right">{rupeesShort(sum((u) => u.cashInPaise))}</td>
              <td className="pt-2 text-right">{rupeesShort(sum((u) => u.onlineInPaise))}</td>
              <td className="pt-2 text-right">{rupeesShort(sum((u) => u.totalCollectedInPaise))}</td>
              <td className="pt-2 text-right" style={{ color: TOKENS.textSecondary }}>100%</td>
              <td className="pt-2 text-right" style={{ color: TOKENS.textSecondary }}>{sum((u) => u.transactionCount).toLocaleString('en-IN')}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </SectionCard>
  );
}

/** Who earns the commission — the biggest thing between collected and kept. */
function CommissionCard({ data, periodLabel }: { data: MoneyResponse; periodLabel: string }) {
  const k = data.kpis;
  const referrers = [...(data.breakdown?.referrers ?? [])].filter((r) => r.commission > 0).sort((a, b) => b.commission - a.commission);
  const top = referrers.slice(0, 8);
  const rest = referrers.slice(8);
  const split = k.commissionSplit;
  const rows: BarRow[] = top.map((r) => ({ key: r.referralDoctorId, label: r.name.replace(/\s{2,}.*$/, ''), value: r.commission, note: `${r.visits} visits` }));
  if (rest.length) rows.push({ key: '__rest', label: `${rest.length} other doctors`, value: rest.reduce((s, r) => s + r.commission, 0) });
  // Doctors' rows add up to the referral part; partners and clinic doctors make up the rest.
  const doctorsTotal = referrers.reduce((s, r) => s + r.commission, 0);
  const unassigned = (split?.referralInPaise ?? doctorsTotal) - doctorsTotal;
  if (Math.abs(unassigned) >= 100) rows.push({ key: '__none', label: 'Tests with no doctor named', value: unassigned });
  if (split?.partnerInPaise) rows.push({ key: '__partner', label: 'Partners', value: split.partnerInPaise });
  if (split?.clinicInPaise) rows.push({ key: '__clinic', label: 'Clinic doctors', value: split.clinicInPaise });
  const collected = k.netCollectedInPaise ?? 0;
  return (
    <SectionCard
      label={`Commission · ${periodLabel}`}
      description={`${collected > 0 ? `${((k.commissionInPaise / collected) * 100).toFixed(1)}% of collected · ` : ''}by who earns it`}
      className="h-full"
      rightSlot={
        <Link to="/owner/payouts" style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}>
          Payouts ↗
        </Link>
      }
    >
      <BarList rows={rows} keepOrder format={rupeesShort} totalLabel="Commission" />
    </SectionCard>
  );
}

/** Refunds (money handed back) and cancellations (charges voided before payment). */
function GivenBackCard({ data }: { data: MoneyResponse }) {
  const { refunds, cancellations } = data;
  const head = (title: string, total: number, sub: string) => (
    <div className="flex items-baseline justify-between">
      <div>
        <div className="font-medium" style={{ fontSize: 13 }}>{title}</div>
        <div style={{ fontSize: 11, color: TOKENS.textTertiary }}>{sub}</div>
      </div>
      <div className="font-medium" style={{ fontSize: 18 }}>{rupees(total)}</div>
    </div>
  );
  const row = (key: string, who: string, bill: string, when: string, why: string | null, amount: number) => (
    <div key={key} className="flex items-baseline justify-between gap-3 py-2" style={{ fontSize: 13, ...ROW }}>
      <span className="min-w-0">
        {who}
        <span style={{ color: TOKENS.textTertiary }}> · {bill}</span>
        <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>{formatIstDate(when)} · {why ?? 'no reason given'}</div>
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{rupees(amount)}</span>
    </div>
  );
  return (
    <SectionCard label="Money given back" className="h-full">
      {head(
        'Refunds',
        refunds.totalInPaise,
        `${refunds.count} refund${refunds.count === 1 ? '' : 's'} paid out${refunds.pctOfCollected != null ? ` · ${refunds.pctOfCollected}% of collected` : ''}`,
      )}
      <div className="mt-2">
        {refunds.recent.slice(0, 3).map((r) =>
          row(r.billId, formatPatientName(r.patientName, r.patientTitle), r.billNumber, r.refundedAt, r.reason, r.refundedInPaise),
        )}
      </div>
      <div className="mt-4">
        {head(
          'Cancelled charges',
          cancellations.totalInPaise,
          `${cancellations.count} test${cancellations.count === 1 ? '' : 's'} taken off bills before payment`,
        )}
        <div className="mt-2">
          {cancellations.recent.slice(0, 3).map((c, i) =>
            row(
              `${c.billNumber}-${i}`,
              formatPatientName(c.patientName, c.patientTitle),
              c.tests && c.tests > 1 ? `${c.billNumber} · ${c.tests} tests` : c.billNumber,
              c.cancelledAt,
              c.reason,
              c.reversedInPaise,
            ),
          )}
        </div>
      </div>
    </SectionCard>
  );
}

/** Group discount rows into at most `top` named lines plus "Other". */
function groupDiscounts(rows: MoneyResponse['discountLog'], keyOf: (d: MoneyResponse['discountLog'][number]) => string, top = 6): BarRow[] {
  const m = new Map<string, { value: number; bills: number }>();
  for (const d of rows) {
    const k = keyOf(d);
    const g = m.get(k) ?? { value: 0, bills: 0 };
    g.value += d.discountInPaise;
    g.bills += 1;
    m.set(k, g);
  }
  const sorted = [...m].sort((a, b) => b[1].value - a[1].value);
  const out: BarRow[] = sorted.slice(0, top).map(([k, g]) => ({ key: k, label: k, value: g.value, note: `${g.bills} bills` }));
  const rest = sorted.slice(top);
  if (rest.length) {
    out.push({
      key: '__other',
      label: `Other (${rest.length})`,
      value: rest.reduce((s, [, g]) => s + g.value, 0),
      note: `${rest.reduce((s, [, g]) => s + g.bills, 0)} bills`,
    });
  }
  return out;
}
// The reason list billing picks from; older typed reasons are read into it where clear.
const reasonOf = (d: MoneyResponse['discountLog'][number]) =>
  (d.isCoupon && !d.grantedBy) || /^coupon\b/i.test(d.reason ?? '') ? 'Offer code' : discountReasonGroup(d.reason);

function DiscountsCard({ rows, periodLabel }: { rows: MoneyResponse['discountLog']; periodLabel: string }) {
  const [showAll, setShowAll] = useState(false);
  const flagged = rows.filter((d) => d.flag).length;
  const visible = showAll ? rows : rows.slice(0, 10);
  const th = TH;
  return (
    <SectionCard
      label={`Discounts · ${periodLabel}`}
      description="Who gave them, why, and the biggest ones · over 30% or over ₹1,000 is tinted"
    >
      {rows.length === 0 ? (
        <EmptyState label="No discounts in this window" />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-1 font-medium" style={{ fontSize: 13 }}>Who gave them</div>
              <BarList rows={groupDiscounts(rows, (d) => d.grantedBy ?? (d.isCoupon ? 'Offer code' : 'Unknown'))} format={rupeesShort} totalLabel="All discounts" />
            </div>
            <div>
              <div className="mb-1 font-medium" style={{ fontSize: 13 }}>Why</div>
              <BarList rows={groupDiscounts(rows, reasonOf, 10)} format={rupeesShort} totalLabel="All discounts" />
            </div>
          </div>
          <div className="mt-6 flex items-baseline justify-between">
            <div className="font-medium" style={{ fontSize: 13 }}>
              Biggest discounts
              {flagged > 0 && (
                <span className="ml-2 inline-flex items-center gap-1" style={{ color: TOKENS.critical, fontSize: 12, fontWeight: 400 }}>
                  <AlertTriangle className="h-3.5 w-3.5" /> {flagged} over 30% or ₹1,000
                </span>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="mt-1 w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th className="py-1.5 text-left" style={th}>Bill</th>
                  <th className="py-1.5 text-left" style={th}>Patient</th>
                  <th className="py-1.5 text-right" style={th}>Off</th>
                  <th className="py-1.5 text-right" style={th}>Of bill</th>
                  <th className="py-1.5 pl-4 text-left" style={th}>Reason</th>
                  <th className="py-1.5 text-left" style={th}>Given by</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.billId} style={{ ...ROW, background: d.flag ? '#FCEBEB40' : undefined }}>
                    <td className="py-2 whitespace-nowrap">
                      {d.billNumber}
                      <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {d.branchCode}</span>
                    </td>
                    <td className="py-2">{formatPatientName(d.patientName, d.patientTitle)}</td>
                    <td className="py-2 text-right">{rupees(d.discountInPaise)}</td>
                    <td className="py-2 text-right" style={{ color: !d.isCoupon && d.discountPercent > 30 ? TOKENS.critical : TOKENS.textPrimary }}>
                      {d.discountPercent}%
                    </td>
                    <td className="py-2 pl-4" style={{ color: TOKENS.textSecondary }}>{d.reason ?? '—'}</td>
                    <td className="py-2" style={{ color: TOKENS.textSecondary }}>{d.grantedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 10 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mt-2"
              style={{ color: TOKENS.info, background: 'transparent', border: 0, padding: 0, fontSize: 12, cursor: 'pointer' }}
            >
              {showAll ? 'Show the biggest 10' : `Show all ${rows.length}`}
            </button>
          )}
        </>
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
  const domain = domainFromParam(rawDomain);

  const setDomain = (next: DomainKey) => {
    setSearchParams(prev => {
      if (next === 'diagnostics') prev.delete('domain');
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
      // The server renders it — same document the token link serves.
      const { token } = useAuthStore.getState();
      const res = await fetch(`${API_BASE}/owner/money/day-sheet?${daySheetParams}&format=html`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error('day sheet failed');
      const html = await res.text();
      win.document.open();
      win.document.write(html);
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
  const periodLabel = period === 'custom' ? `${customStart} – ${customEnd}` : PERIOD_LABEL[period];

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
              <DomainFilter value={domain} onChange={setDomain} />
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
            <MoneyKpis data={data} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-8">
                {data.byHour ? (
                  <HourlyMoneyCard data={data} periodLabel={periodLabel} />
                ) : (
                  <DailyMoneyCard trend={data.revenueTrend} periodLabel={periodLabel} onPickDay={(d) => setCustomRange({ start: d, end: d })} />
                )}
              </div>
              <div className="lg:col-span-4">
                <HowItCameInCard data={data} periodLabel={periodLabel} />
              </div>
            </div>

            <div>
              <GroupLabel>Where it goes</GroupLabel>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <div className="lg:col-span-7">
                  <CommissionCard data={data} periodLabel={periodLabel} />
                </div>
                <div className="lg:col-span-5">
                  <GivenBackCard data={data} />
                </div>
              </div>
            </div>

            <DiscountsCard rows={data.discountLog} periodLabel={periodLabel} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-7">
                <StaffCard rows={data.cashByUser} total={data.kpis.netCollectedInPaise ?? 0} />
              </div>
              <div className="lg:col-span-5">
                <OpenDuesCard data={data} selectedKey={agingFilter} onSelect={setAgingFilter} />
              </div>
            </div>

            {data.breakdown && (
              <MoneyBreakdown
                data={data.breakdown}
                periodLabel={periodLabel}
                initialBy={data.revenueTrend.length <= 1 ? 'branch' : 'day'}
                onPickDay={(d) => setCustomRange({ start: d, end: d })}
                onPickBranch={setBranchValue}
                referrerHref={(id) => {
                  // The window in IST calendar days; endIso is exclusive.
                  const day = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(0, 10);
                  const from = day(data.period.startIso);
                  const to = day(new Date(Date.parse(data.period.endIso) - 1).toISOString());
                  return `/owner/payouts/REFERRAL.${id}?from=${from}&to=${to}`;
                }}
              />
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
