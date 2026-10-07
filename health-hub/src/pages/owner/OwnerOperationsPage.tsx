/**
 * Owner Operations page — GET /api/owner/operations
 *
 * For the owner (is every branch running?) and the lab in-charge (what do I
 * chase?). Top to bottom:
 *   - one status card per branch, live: today's numbers, what's late, and
 *     when the lab last released a report
 *   - pending work, live: one list with tabs — waiting for results, awaiting
 *     sign-off, outside lab, critical values, patients to call
 *   - for the period: reports on time per day beside where the time goes;
 *     departments beside the team; clinic beside report delivery
 *
 * Each number appears once. No money: the lab in-charge opens this page too.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { formatPatientName } from '@/lib/patientDisplay';
import { ComparisonTrendChart, GroupLabel, Delta, SERIES, TH, ROW, TOTAL_ROW } from './_shared/dashboardCharts';
import {
  TOKENS,
  formatIstDateTime,
  formatIstTime,
  SectionCard,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  PERIOD_LABEL,
  OwnerPageHeader,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
} from './_shared/ownerUi';

interface BranchStatus {
  branchId: string;
  code: string;
  name: string;
  registeredToday: number;
  outToday: number;
  inProgress: number;
  late: number;
  clinicWaiting: number;
  notDeliveredToday: number;
  lastReleaseAt: string | null;
  lastReleaseBy: string | null;
  lastEntryAt: string | null;
  lastEntryBy: string | null;
}

type Stage = 'results' | 'signoff' | 'outside';

interface Speed {
  visits: number;
  released: number;
  medianMinutes: number | null;
  within24Pct: number | null;
  waitForResultMinutes: number | null;
  toSignOffMinutes: number | null;
  daySameDayPct: number | null;
  eveningVisits: number;
  eveningSameDayPct: number | null;
}

interface OperationsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  branches: BranchStatus[];
  pending: {
    visitId: string;
    patientName: string;
    patientTitle: string | null;
    branchCode: string;
    tests: string;
    stage: Stage;
    partlyOut: boolean;
    outsideTests: number;
    enteredBy: string | null;
    ageMinutes: number;
  }[];
  critical: {
    visitId: string;
    patientName: string;
    patientTitle: string | null;
    branchCode: string;
    test: string;
    value: string;
    flag: 'CRITICAL_HIGH' | 'CRITICAL_LOW';
    enteredBy: string | null;
    enteredAt: string;
    released: boolean;
  }[];
  toCall: {
    patientId: string | null;
    patientName: string;
    patientTitle: string | null;
    branchCode: string | null;
    phone: string;
    what: string;
    why: string;
    lastTriedIso: string;
  }[];
  overall: Speed;
  branchSpeed: (Speed & { code: string; name: string })[];
  byDay: { date: string; onTime: number; late: number; pending: number; medianMinutes: number | null }[];
  departments: { name: string; visits: number; released: number; medianMinutes: number | null; within24Pct: number | null; filmsOnly: number }[];
  delivery: { released: number; sent: number; delivered: number; opened: number; printed: number };
  team: { userId: string; name: string; role: string; branches?: string[]; registered: number; testsEntered: number; reportsReleased: number }[];
  clinicNow: { doctorId: string; doctorName: string; branchCode: string | null; waiting: number; withDoctor: number; seenToday: number; longestWaitMinutes: number | null }[];
  clinicDoctors: { doctorId: string; doctorName: string; consults: number; priorConsults: number; digitalRx: number; paperRx: number }[];
}

// ----- helpers ----------------------------------------------------------

/** 45m · 6h 18m · 2d 4h */
function fmtDuration(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}
const count = (v: number) => Math.round(v).toLocaleString('en-IN');
const shortBranch = (name: string) => name.replace(/^Sobhana\s*-\s*/i, '');
const ageColor = (mins: number) => (mins > 1440 ? TOKENS.critical : mins > 240 ? TOKENS.caution : TOKENS.textPrimary);
/** 919989655190 → +91 99896 55190 */
const fmtPhone = (raw: string) => {
  const d = raw.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : raw;
};
const sinceLabel = (iso: string, nowIso: string) => {
  const mins = (Date.parse(nowIso) - Date.parse(iso)) / 60000;
  return mins < 1 ? 'just now' : `${fmtDuration(mins >= 1440 ? Math.floor(mins / 1440) * 1440 : mins)} ago`;
};
const ON_TIME = SERIES[0];
const LATE = SERIES[1];
const NOT_YET = '#C9C7BF';
const WAIT = '#EDB95E';
const SIGN = SERIES[0];

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

// ----- branches -------------------------------------------------------------

function BranchCard({ b, now, selected, onPick }: { b: BranchStatus; now: string; selected: boolean; onPick: () => void }) {
  const status =
    b.late > 0
      ? { text: `${b.late} late`, color: TOKENS.critical, bg: '#FCEBEB' }
      : b.inProgress > 0
        ? { text: 'Running', color: TOKENS.info, bg: '#EEF4FF' }
        : { text: 'All clear', color: TOKENS.healthy, bg: '#E5F4ED' };
  const line = (label: string, value: number, bad?: boolean) => (
    <div className="flex items-baseline justify-between py-1" style={{ ...ROW, fontSize: 13 }}>
      <span style={{ color: TOKENS.textSecondary }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: bad && value > 0 ? TOKENS.critical : value ? TOKENS.textPrimary : TOKENS.textTertiary, fontWeight: bad && value > 0 ? 500 : 400 }}>
        {value}
      </span>
    </div>
  );
  return (
    <button
      onClick={onPick}
      aria-pressed={selected}
      className="h-full w-full text-left transition-colors hover:bg-slate-50"
      style={{
        background: TOKENS.surface,
        border: `${selected ? 1.5 : 0.5}px solid ${selected ? TOKENS.info : TOKENS.border}`,
        borderRadius: 12,
        padding: selected ? '13px 15px' : '14px 16px',
      }}
      title={selected ? 'Showing this branch · click for all branches' : 'Show only this branch'}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium" style={{ fontSize: 15 }}>{shortBranch(b.name)}</span>
        <span style={{ fontSize: 12, color: status.color, background: status.bg, borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap' }}>{status.text}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {[
          ['Came in today', b.registeredToday],
          ['Reports out', b.outToday],
          ['In progress', b.inProgress],
        ].map(([l, v]) => (
          <div key={l as string}>
            <div className="font-medium" style={{ fontSize: 22, letterSpacing: '-0.01em', lineHeight: 1.2 }}>{v}</div>
            <div style={{ fontSize: 11, color: TOKENS.textTertiary }}>{l}</div>
          </div>
        ))}
      </div>
      <div className="mt-2">
        {line('Reports late, over a day', b.late, true)}
        {line('Waiting for the doctor', b.clinicWaiting)}
        {line('WhatsApp failed today', b.notDeliveredToday, true)}
      </div>
      <div className="mt-2" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        {b.lastReleaseAt
          ? `Last report out ${sinceLabel(b.lastReleaseAt, now)}${b.lastReleaseBy ? ` · ${b.lastReleaseBy}` : ''}`
          : 'No report out in two days'}
      </div>
    </button>
  );
}

/**
 * Past four branches, cards wrap into rows nobody compares. A table keeps
 * every branch on one line each, worst first, with the same numbers.
 */
function BranchTable({ rows, now, selected, onPick }: { rows: BranchStatus[]; now: string; selected: string; onPick: (id: string) => void }) {
  const sorted = [...rows].sort((a, b) => b.late - a.late || b.inProgress - a.inProgress);
  const sum = (k: 'registeredToday' | 'outToday' | 'inProgress' | 'late' | 'clinicWaiting' | 'notDeliveredToday') => rows.reduce((s, r) => s + r[k], 0);
  const cell = (v: number, bad?: boolean) => (
    <td className="py-2 text-right" style={{ color: bad && v > 0 ? TOKENS.critical : v ? undefined : TOKENS.textTertiary, fontWeight: bad && v > 0 ? 500 : 400 }}>
      {v || '·'}
    </td>
  );
  return (
    <SectionCard>
      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', minWidth: 760 }}>
          <thead>
            <tr>
              <th className="pb-1 text-left" style={TH}>Branch</th>
              <th className="pb-1 text-right" style={TH}>Came in today</th>
              <th className="pb-1 text-right" style={TH}>Reports out</th>
              <th className="pb-1 text-right" style={TH}>In progress</th>
              <th className="pb-1 text-right" style={TH}>Late, over a day</th>
              <th className="pb-1 text-right" style={TH}>Waiting for doctor</th>
              <th className="pb-1 text-right" style={TH}>WhatsApp failed</th>
              <th className="pb-1 text-right" style={TH}>Last report out</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => (
              <tr
                key={b.branchId}
                onClick={() => onPick(b.branchId)}
                className="cursor-pointer hover:bg-slate-50"
                style={{ ...ROW, background: selected === b.branchId ? '#EEF4FF' : undefined }}
                title="Show only this branch"
              >
                <td className="py-2 font-medium">{shortBranch(b.name)}</td>
                {cell(b.registeredToday)}
                {cell(b.outToday)}
                {cell(b.inProgress)}
                {cell(b.late, true)}
                {cell(b.clinicWaiting)}
                {cell(b.notDeliveredToday, true)}
                <td className="py-2 text-right" style={{ color: TOKENS.textSecondary, whiteSpace: 'nowrap' }}>
                  {b.lastReleaseAt ? sinceLabel(b.lastReleaseAt, now) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium" style={TOTAL_ROW}>
              <td className="pt-2">All branches</td>
              {(['registeredToday', 'outToday', 'inProgress', 'late', 'clinicWaiting', 'notDeliveredToday'] as const).map((k) => (
                <td key={k} className="pt-2 text-right">{sum(k)}</td>
              ))}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </SectionCard>
  );
}

// ----- pending work -----------------------------------------------------------

type Tab = Stage | 'critical' | 'call';
const TABS: { key: Tab; label: string }[] = [
  { key: 'results', label: 'Waiting for results' },
  { key: 'signoff', label: 'Awaiting sign-off' },
  { key: 'outside', label: 'Outside lab' },
  { key: 'critical', label: 'Critical values' },
  { key: 'call', label: 'Call patient' },
];

function PendingCard({ data }: { data: OperationsResponse }) {
  const [tab, setTab] = useState<Tab>('results');
  const [all, setAll] = useState(false);
  const n = (t: Tab) => (t === 'critical' ? data.critical.length : t === 'call' ? data.toCall.length : data.pending.filter((p) => p.stage === t).length);
  const LIMIT = 10;
  const cut = <T,>(rows: T[]) => (all ? rows : rows.slice(0, LIMIT));
  const total = n(tab);
  const patientLink = (visitId: string, name: string, title: string | null) => (
    <Link to={`/diagnostics/results/${visitId}`} style={{ color: TOKENS.info, textDecoration: 'none' }}>
      {formatPatientName(name, title)}
    </Link>
  );

  let body: React.ReactNode;
  if (tab === 'critical') {
    body = (
      <table className="w-full" style={{ fontSize: 13 }}>
        <thead>
          <tr className="text-left">
            <th className="pb-1" style={TH}>Patient</th>
            <th className="pb-1" style={TH}>Test</th>
            <th className="pb-1 text-right" style={TH}>Value</th>
            <th className="pb-1" style={{ ...TH, paddingLeft: 16 }}>Entered</th>
            <th className="pb-1 text-right" style={TH}>Report</th>
          </tr>
        </thead>
        <tbody>
          {cut(data.critical).map((c, i) => (
            <tr key={`${c.visitId}-${c.test}-${i}`} style={ROW}>
              <td className="py-1.5 pr-3">
                {patientLink(c.visitId, c.patientName, c.patientTitle)}
                <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {c.branchCode}</span>
              </td>
              <td className="py-1.5 pr-3">{c.test}</td>
              <td className="py-1.5 text-right font-medium" style={{ color: TOKENS.critical, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {c.flag === 'CRITICAL_HIGH' ? '▲' : '▼'} {c.value}
              </td>
              <td className="py-1.5" style={{ color: TOKENS.textSecondary, paddingLeft: 16, whiteSpace: 'nowrap' }}>
                {formatIstDateTime(c.enteredAt)}
                {c.enteredBy ? ` · ${c.enteredBy}` : ''}
              </td>
              <td className="py-1.5 text-right" style={{ color: c.released ? TOKENS.healthy : TOKENS.caution, whiteSpace: 'nowrap' }}>
                {c.released ? 'Out' : 'Not out yet'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (tab === 'call') {
    body = (
      <table className="w-full" style={{ fontSize: 13 }}>
        <thead>
          <tr className="text-left">
            <th className="pb-1" style={TH}>Patient</th>
            <th className="pb-1" style={TH}>What didn't arrive</th>
            <th className="pb-1" style={TH}>Why</th>
            <th className="pb-1" style={TH}>Tried</th>
            <th className="pb-1" />
          </tr>
        </thead>
        <tbody>
          {cut(data.toCall).map((c, i) => (
            <tr key={c.patientId ?? `${c.phone}-${i}`} style={ROW}>
              <td className="py-1.5 pr-3">
                {c.patientId ? (
                  <Link to={`/clinic/patient-360/${c.patientId}`} style={{ color: TOKENS.info, textDecoration: 'none' }}>
                    {formatPatientName(c.patientName, c.patientTitle)}
                  </Link>
                ) : (
                  formatPatientName(c.patientName, c.patientTitle)
                )}
                {c.branchCode && <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {c.branchCode}</span>}
              </td>
              <td className="py-1.5 pr-3" style={{ whiteSpace: 'nowrap' }}>{c.what}</td>
              <td className="py-1.5 pr-3" style={{ color: TOKENS.textSecondary }}>{c.why}</td>
              <td className="py-1.5 pr-3" style={{ color: TOKENS.textTertiary, whiteSpace: 'nowrap' }}>{sinceLabel(c.lastTriedIso, data.generatedAt)}</td>
              <td className="py-1.5 text-right">
                <a
                  href={`tel:+${c.phone.replace(/\D/g, '')}`}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1"
                  style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.info, textDecoration: 'none', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
                >
                  <Phone className="h-3 w-3" />
                  {fmtPhone(c.phone)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    const rows = data.pending.filter((p) => p.stage === tab).sort((a, b) => b.ageMinutes - a.ageMinutes);
    const noteOf = (p: OperationsResponse['pending'][number]) =>
      [
        p.partlyOut ? 'Part of the report is out' : '',
        p.outsideTests ? `${p.outsideTests} test${p.outsideTests === 1 ? '' : 's'} not back` : '',
        p.stage === 'signoff' && p.enteredBy ? `Entered by ${p.enteredBy}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    const notes = rows.some((p) => noteOf(p));
    body = (
      <table className="w-full" style={{ fontSize: 13 }}>
        <thead>
          <tr className="text-left">
            <th className="pb-1" style={TH}>Patient · tests</th>
            <th className="pb-1" style={TH}>Branch</th>
            {notes && <th className="pb-1" style={TH}>Note</th>}
            <th className="pb-1 text-right" style={TH}>Waiting</th>
          </tr>
        </thead>
        <tbody>
          {cut(rows).map((p) => (
            <tr key={p.visitId} style={ROW}>
              <td className="py-1.5 pr-3" style={{ maxWidth: 420 }}>
                {patientLink(p.visitId, p.patientName, p.patientTitle)}
                <div className="truncate" style={{ color: TOKENS.textTertiary, fontSize: 11 }} title={p.tests}>{p.tests}</div>
              </td>
              <td className="py-1.5 pr-3" style={{ color: TOKENS.textSecondary }}>{p.branchCode}</td>
              {notes && <td className="py-1.5 pr-3" style={{ color: TOKENS.textSecondary }}>{noteOf(p) || '—'}</td>}
              <td className="py-1.5 text-right" style={{ color: ageColor(p.ageMinutes), whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontWeight: p.ageMinutes > 1440 ? 500 : 400 }}>
                {fmtDuration(p.ageMinutes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <SectionCard
      label="Pending work · live"
      description="Oldest first · waiting time counts from registration · amber after 4h, red after a day"
      rightSlot={
        <Link to="/diagnostics/pending" style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}>
          Open the pending screen ↗
        </Link>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
        {TABS.map((t) => {
          const on = tab === t.key;
          const c = n(t.key);
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              onClick={() => {
                setTab(t.key);
                setAll(false);
              }}
              className="rounded-full border px-3 py-1"
              style={{
                fontSize: 12,
                borderColor: on ? TOKENS.info : TOKENS.border,
                background: on ? '#EEF4FF' : 'white',
                color: on ? TOKENS.info : TOKENS.textSecondary,
              }}
            >
              {t.label} <span style={{ fontWeight: 500, color: on ? TOKENS.info : c ? TOKENS.textPrimary : TOKENS.textTertiary }}>{c}</span>
            </button>
          );
        })}
      </div>
      {total === 0 ? (
        <div style={{ color: TOKENS.healthy, fontSize: 13 }}>
          {tab === 'critical' ? 'No critical values in the last two days.' : tab === 'call' ? 'Every message in the last two days reached the patient.' : 'Nothing here.'}
        </div>
      ) : (
        <div className="overflow-x-auto">{body}</div>
      )}
      {total > LIMIT && (
        <button onClick={() => setAll((v) => !v)} className="mt-2" style={{ fontSize: 12, color: TOKENS.info }}>
          {all ? 'Show fewer' : `Show all ${total}`}
        </button>
      )}
    </SectionCard>
  );
}

// ----- turnaround -------------------------------------------------------------

function OnTimeCard({ data, periodLabel, onPickDay }: { data: OperationsResponse; periodLabel: string; onPickDay: (d: string) => void }) {
  const s = data.overall;
  const days = data.byDay;
  const stat = (label: string, value: string) => (
    <div>
      <div className="font-medium" style={{ fontSize: 20, letterSpacing: '-0.01em' }}>{value}</div>
      <div style={{ fontSize: 12, color: TOKENS.textTertiary }}>{label}</div>
    </div>
  );
  return (
    <SectionCard label={`Reports on time · ${periodLabel}`} description="Diagnostic visits registered in the period that needed a report" className="h-full">
      <div className="mb-3 flex flex-wrap gap-x-10 gap-y-2">
        {stat('Typical time to report', s.medianMinutes != null ? fmtDuration(s.medianMinutes) : '—')}
        {stat('Out within 24h', s.within24Pct != null ? `${s.within24Pct}%` : '—')}
        {stat('Reports out', `${count(s.released)} of ${count(s.visits)}`)}
      </div>
      {days.length > 1 && (
        <>
          <div className="mb-1 flex flex-wrap gap-4" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
            <Swatch color={ON_TIME} label="Out within 24h" />
            <Swatch color={LATE} label="Took longer" />
            <Swatch color={NOT_YET} label="Not out yet, under 24h" />
            <span style={{ color: TOKENS.textTertiary }}>· by the day they registered · click a day to open it</span>
          </div>
          <ComparisonTrendChart
            days={days.map((d) => ({ date: d.date, value: d.onTime + d.late + d.pending, prior: null }))}
            average={days.map(() => null)}
            priorAverage={days.map(() => null)}
            format={count}
            valueLabel="Visits"
            height={240}
            onPickDay={onPickDay}
            note={(i) => (days[i].medianMinutes != null ? `Typical ${fmtDuration(days[i].medianMinutes!)}` : null)}
            parts={[
              { label: 'Out within 24h', color: ON_TIME, values: days.map((d) => d.onTime) },
              { label: 'Took longer', color: LATE, values: days.map((d) => d.late) },
              { label: 'Not out yet', color: NOT_YET, values: days.map((d) => d.pending) },
            ]}
          />
        </>
      )}
    </SectionCard>
  );
}

/**
 * Every branch on the same measures, so a slow one stands out — one row per
 * branch however many there are, and the total underneath.
 */
function BranchesComparedCard({ data, periodLabel }: { data: OperationsResponse; periodLabel: string }) {
  const rows = data.branchSpeed;
  const all = [...rows, ...(rows.length > 1 ? [{ ...data.overall, code: '', name: 'All branches' }] : [])];
  const max = Math.max(1, ...all.map((r) => (r.waitForResultMinutes ?? 0) + (r.toSignOffMinutes ?? 0)));
  const bad = (v: number | null, under: number) => (v != null && v < under ? TOKENS.critical : undefined);
  const o = data.overall;
  return (
    <SectionCard
      label={`Branches compared · ${periodLabel}`}
      description="Diagnostic visits registered in the period that needed a report · time is the typical visit"
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No visits in this period.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', minWidth: 760 }}>
              <thead>
                <tr>
                  <th className="pb-1 text-left" style={TH}>Branch</th>
                  <th className="pb-1 text-right" style={TH}>Visits</th>
                  <th className="pb-1 text-right" style={TH}>Typical time</th>
                  <th className="pb-1 text-right" style={TH}>Out in 24h</th>
                  <th className="pb-1 text-left" style={{ ...TH, paddingLeft: 24, width: '32%' }}>
                    <span className="inline-flex flex-wrap gap-3">
                      <Swatch color={WAIT} label="Waiting for the first result" />
                      <Swatch color={SIGN} label="Result to report out" />
                    </span>
                  </th>
                  <th className="pb-1 text-right" style={TH} title="Registered before 5 pm: report out the same day">Same day, before 5 pm</th>
                  <th className="pb-1 text-right" style={TH} title="Registered from 5 pm: report out the same day">Same day, after 5 pm</th>
                </tr>
              </thead>
              <tbody>
                {all.map((r) => {
                  const total = r.name === 'All branches';
                  const w = r.waitForResultMinutes ?? 0;
                  const sg = r.toSignOffMinutes ?? 0;
                  return (
                    <tr key={r.name} className={total ? 'font-medium' : undefined} style={total ? TOTAL_ROW : ROW}>
                      <td className={total ? 'pt-2' : 'py-2'}>{shortBranch(r.name)}</td>
                      <td className="py-2 text-right">{count(r.visits)}</td>
                      <td className="py-2 text-right">{r.medianMinutes != null ? fmtDuration(r.medianMinutes) : '—'}</td>
                      <td className="py-2 text-right" style={{ color: bad(r.within24Pct, 85) }}>{r.within24Pct != null ? `${r.within24Pct}%` : '—'}</td>
                      <td className="py-2" style={{ paddingLeft: 24 }}>
                        {r.waitForResultMinutes != null ? (
                          <div className="flex items-center gap-2" title={`Waiting for the first result ${fmtDuration(w)} · result to report out ${fmtDuration(sg)}`}>
                            <div className="flex flex-1" style={{ height: 8, gap: 2 }}>
                              <div style={{ width: `${(w / max) * 100}%`, background: WAIT, borderRadius: 3 }} />
                              <div style={{ width: `${Math.max(0.6, (sg / max) * 100)}%`, background: SIGN, borderRadius: 3 }} />
                            </div>
                            <span style={{ fontSize: 12, color: TOKENS.textSecondary, whiteSpace: 'nowrap', minWidth: 92, textAlign: 'right' }}>
                              {fmtDuration(w)} + {fmtDuration(sg)}
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: TOKENS.textTertiary }}>—</span>
                        )}
                      </td>
                      <td className="py-2 text-right" style={{ color: bad(r.daySameDayPct, 80) }}>{r.daySameDayPct != null ? `${r.daySameDayPct}%` : '—'}</td>
                      <td className="py-2 text-right" style={{ color: bad(r.eveningSameDayPct, 50) }}>
                        {r.eveningSameDayPct != null ? `${r.eveningSameDayPct}%` : '—'}
                        <span style={{ color: TOKENS.textTertiary, fontWeight: 400, fontSize: 11 }}> · {r.eveningVisits}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {o.waitForResultMinutes != null && (
            <div className="mt-3" style={{ fontSize: 12, color: TOKENS.textSecondary }}>
              Most of the time is spent before anyone enters a result ({fmtDuration(o.waitForResultMinutes)} of {fmtDuration(o.waitForResultMinutes + (o.toSignOffMinutes ?? 0))}).
              {o.eveningSameDayPct != null && o.daySameDayPct != null && o.eveningSameDayPct < o.daySameDayPct - 15
                ? ` Visits after 5 pm mostly wait overnight: ${o.eveningSameDayPct}% got the report the same day.`
                : ''}
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ----- departments, team ------------------------------------------------------------

function DepartmentsCard({ rows, periodLabel }: { rows: OperationsResponse['departments']; periodLabel: string }) {
  return (
    <SectionCard label={`By department · ${periodLabel}`} description="Registration to that department's report" className="h-full">
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No visits in this period.</div>
      ) : (
        <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th className="pb-1 text-left" style={TH}>Department</th>
              <th className="pb-1 text-right" style={TH}>Patients</th>
              <th className="pb-1 text-right" style={TH}>Typical</th>
              <th className="pb-1 text-right" style={TH}>In 24h</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const open = d.visits - d.released - d.filmsOnly;
              const notes = [d.filmsOnly ? `${d.filmsOnly} film${d.filmsOnly === 1 ? '' : 's'} only` : '', open > 0 ? `${open} open` : ''].filter(Boolean).join(' · ');
              return (
                <tr key={d.name} style={ROW}>
                  <td className="py-1.5 pr-2">
                    {d.name}
                    {notes && <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>{notes}</div>}
                  </td>
                  <td className="py-1.5 text-right">{count(d.visits)}</td>
                  <td className="py-1.5 pl-2 text-right" style={{ whiteSpace: 'nowrap' }}>{d.medianMinutes != null ? fmtDuration(d.medianMinutes) : '—'}</td>
                  <td className="py-1.5 text-right" style={{ color: d.within24Pct != null && d.within24Pct < 80 ? TOKENS.critical : undefined }}>
                    {d.within24Pct != null ? `${d.within24Pct}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', lab_incharge: 'Lab in-charge', staff: 'Front desk' };

function TeamCard({ rows, periodLabel }: { rows: OperationsResponse['team']; periodLabel: string }) {
  const sum = (k: 'registered' | 'testsEntered' | 'reportsReleased') => rows.reduce((s, r) => s + r[k], 0);
  return (
    <SectionCard label={`Team · ${periodLabel}`} description="Visits registered, tests entered, reports released" className="h-full">
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No activity in this period.</div>
      ) : (
        <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th className="pb-1 text-left" style={TH}>Person</th>
              <th className="pb-1 text-right" style={TH}>Registered</th>
              <th className="pb-1 text-right" style={TH}>Entered</th>
              <th className="pb-1 text-right" style={TH}>Released</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} style={ROW}>
                <td className="py-1.5 pr-2">
                  {r.name}
                  <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                    {ROLE_LABEL[r.role] ?? r.role}
                    {r.branches?.length ? ` · ${r.branches.join(', ')}` : ''}
                  </div>
                </td>
                {(['registered', 'testsEntered', 'reportsReleased'] as const).map((k) => (
                  <td key={k} className="py-1.5 text-right" style={{ color: r[k] ? undefined : TOKENS.textTertiary }}>
                    {r[k] ? count(r[k]) : '·'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium" style={TOTAL_ROW}>
              <td className="pt-2">Everyone</td>
              <td className="pt-2 text-right">{count(sum('registered'))}</td>
              <td className="pt-2 text-right">{count(sum('testsEntered'))}</td>
              <td className="pt-2 text-right">{count(sum('reportsReleased'))}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </SectionCard>
  );
}

// ----- clinic, delivery ---------------------------------------------------------------

function ClinicCard({ data, periodLabel }: { data: OperationsResponse; periodLabel: string }) {
  const rows = data.clinicDoctors;
  const total = rows.reduce((s, r) => s + r.consults, 0);
  const prior = rows.reduce((s, r) => s + r.priorConsults, 0);
  return (
    <SectionCard
      label={`Clinic · ${periodLabel}`}
      className="h-full"
      rightSlot={
        <Link to="/clinic/queue" style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}>
          Queue ↗
        </Link>
      }
    >
      {data.clinicNow.length > 0 && (
        <div className="mb-3" style={{ fontSize: 13 }}>
          {data.clinicNow.map((c) => (
            <div key={c.doctorId} className="flex flex-wrap justify-between gap-x-3">
              <span>{c.doctorName} <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>· now</span></span>
              <span style={{ color: TOKENS.textSecondary }}>
                <span style={{ color: (c.longestWaitMinutes ?? 0) > 30 ? TOKENS.critical : undefined }}>
                  {c.waiting} waiting{c.longestWaitMinutes != null ? `, longest ${fmtDuration(c.longestWaitMinutes)}` : ''}
                </span>
                {c.withDoctor ? ` · ${c.withDoctor} with the doctor` : ''} · {c.seenToday} seen
              </span>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No consults in this period.</div>
      ) : (
        <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th className="pb-1 text-left" style={TH}>Doctor</th>
              <th className="pb-1 text-right" style={TH}>Consults</th>
              <th className="pb-1 text-right" style={{ ...TH, whiteSpace: 'nowrap' }}>vs before</th>
              <th className="pb-1 text-right" style={{ ...TH, whiteSpace: 'nowrap' }} title="Prescriptions written in the app · on paper">Rx app · paper</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.doctorId} style={ROW}>
                <td className="py-1.5 pr-2">{r.doctorName}</td>
                <td className="py-1.5 text-right">{count(r.consults)}</td>
                <td className="py-1.5 text-right"><Delta now={r.consults} before={r.priorConsults} /></td>
                <td className="py-1.5 text-right" style={{ color: TOKENS.textSecondary }}>{r.digitalRx} · {r.paperRx}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium" style={TOTAL_ROW}>
              <td className="pt-2">All doctors</td>
              <td className="pt-2 text-right">{count(total)}</td>
              <td className="pt-2 text-right"><Delta now={total} before={prior} /></td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </SectionCard>
  );
}

function DeliveryCard({ d, periodLabel }: { d: OperationsResponse['delivery']; periodLabel: string }) {
  const step = (label: string, n: number, color: string, hint?: string) => (
    <div className="py-1.5" style={ROW} title={hint}>
      <div className="flex items-baseline justify-between gap-3" style={{ fontSize: 13 }}>
        <span>{label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {count(n)}
          <span style={{ color: TOKENS.textTertiary }}> · {d.released ? Math.round((n / d.released) * 100) : 0}%</span>
        </span>
      </div>
      <div className="mt-1" style={{ height: 6, borderRadius: 3, background: '#F1F0EC' }}>
        <div style={{ width: `${d.released ? (n / d.released) * 100 : 0}%`, height: '100%', borderRadius: 3, background: color }} />
      </div>
    </div>
  );
  return (
    <SectionCard label={`How reports reach patients · ${periodLabel}`} description={`Of the ${count(d.released)} reports out`} className="h-full">
      {d.released === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No reports out yet.</div>
      ) : (
        <>
          {step('Sent on WhatsApp', d.sent, ON_TIME)}
          {step('Reached the phone', d.delivered, ON_TIME, 'Delivered or read')}
          {step('Opened online', d.opened, ON_TIME, 'Patient opened the report link or the app')}
          {step('Printed at the counter', d.printed, NOT_YET)}
        </>
      )}
    </SectionCard>
  );
}

// ----- main page ----------------------------------------------------------

const OPS_PERIOD_OPTS: PeriodKey[] = ['today', 'yesterday', '7d', '30d', 'mtd', 'custom'];

function todayKey(): string {
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
}

export default function OwnerOperationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';
  const rawPeriod = searchParams.get('period');
  const period: PeriodKey = OPS_PERIOD_OPTS.includes(rawPeriod as PeriodKey) ? (rawPeriod as PeriodKey) : '7d';
  const customStart = searchParams.get('start') || '';
  const customEnd = searchParams.get('end') || '';
  const customReady = period === 'custom' && Boolean(customStart) && Boolean(customEnd);

  const update = (fn: (p: URLSearchParams) => void) =>
    setSearchParams((prev) => {
      fn(prev);
      return prev;
    });
  const setBranchValue = (b: string) => update((p) => p.set('branch', b));
  const setPeriod = (next: PeriodKey) =>
    update((p) => {
      p.set('period', next);
      if (next === 'custom') {
        if (!p.get('start')) p.set('start', todayKey());
        if (!p.get('end')) p.set('end', todayKey());
      } else {
        p.delete('start');
        p.delete('end');
      }
    });
  const setCustomRange = (r: { start: string; end: string }) =>
    update((p) => {
      p.set('period', 'custom');
      if (r.start) p.set('start', r.start);
      if (r.end) p.set('end', r.end);
    });

  const params =
    period === 'custom'
      ? `period=custom&start=${customStart}&end=${customEnd}&branch=${encodeURIComponent(branchValue)}`
      : `period=${period}&branch=${encodeURIComponent(branchValue)}`;

  const query = useQuery<OperationsResponse>({
    queryKey: ['owner-operations', period, branchValue, customStart, customEnd],
    queryFn: () => apiRequest<OperationsResponse>(`${API_BASE}/owner/operations?${params}`),
    enabled: period !== 'custom' || customReady,
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  });

  // Data in a shape this screen doesn't know (the page or the server was just
  // updated): say so and offer a reload, never spin forever.
  const data = query.data?.branches ? query.data : undefined;
  const periodLabel = period === 'custom' ? `${customStart} – ${customEnd}` : PERIOD_LABEL[period];

  return (
    <AppLayout context="owner" hideContextBanner>
      <div className="mx-auto" style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}>
        <OwnerPageHeader
          title="Operations"
          subtitle={data ? `${formatIstDateTime(data.generatedAt)} · ${data.branchScope.branchName ?? 'all branches'} · updates every minute` : 'Loading…'}
          rightSlot={
            <>
              <BranchFilter value={branchValue} onChange={setBranchValue} />
              <RefreshButton isFetching={query.isFetching} onClick={() => query.refetch()} />
            </>
          }
        />

        {query.isLoading && <FullPageSkeleton />}
        {query.data && !data && (
          <SectionCard>
            <div className="flex flex-wrap items-center justify-between gap-3" style={{ fontSize: 13 }}>
              <span>This page was updated. Reload to see the new version.</span>
              <button
                onClick={() => window.location.reload()}
                className="rounded-md border px-3 py-1.5"
                style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.info }}
              >
                Reload
              </button>
            </div>
          </SectionCard>
        )}
        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div className="space-y-4">
            <div>
              <GroupLabel>Branches right now · {formatIstTime(data.generatedAt)}</GroupLabel>
              {data.branches.length > 4 ? (
                <BranchTable rows={data.branches} now={data.generatedAt} selected={branchValue} onPick={(id) => setBranchValue(branchValue === id ? 'all' : id)} />
              ) : (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', maxWidth: data.branches.length === 1 ? 520 : undefined }}
                >
                  {[...data.branches].sort((a, b) => b.registeredToday + b.inProgress - (a.registeredToday + a.inProgress)).map((b) => (
                    <BranchCard
                      key={b.branchId}
                      b={b}
                      now={data.generatedAt}
                      selected={branchValue === b.branchId}
                      onPick={() => setBranchValue(branchValue === b.branchId ? 'all' : b.branchId)}
                    />
                  ))}
                </div>
              )}
            </div>

            <PendingCard data={data} />

            <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
              <GroupLabel>How it went · {periodLabel}</GroupLabel>
              <PeriodFilter
                value={period}
                onChange={setPeriod}
                options={OPS_PERIOD_OPTS}
                customRange={{ start: customStart || todayKey(), end: customEnd || todayKey() }}
                onCustomRangeChange={setCustomRange}
              />
            </div>

            <BranchesComparedCard data={data} periodLabel={periodLabel} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-8">
                <OnTimeCard data={data} periodLabel={periodLabel} onPickDay={(d) => setCustomRange({ start: d, end: d })} />
              </div>
              <div className="lg:col-span-4">
                <DeliveryCard d={data.delivery} periodLabel={periodLabel} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <DepartmentsCard rows={data.departments} periodLabel={periodLabel} />
              <TeamCard rows={data.team} periodLabel={periodLabel} />
              <ClinicCard data={data} periodLabel={periodLabel} />
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
