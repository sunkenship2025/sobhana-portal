/**
 * Owner Operations page — GET /api/owner/operations
 *
 * Top to bottom: what needs doing now (chips) · open reports by stage × age
 * beside the visits waiting longest (live) · then, for the period, the KPIs ·
 * turnaround per day beside each department · arrival hour vs same-day
 * reports beside how reports reach patients · the team beside the clinic ·
 * messages that failed (with numbers to call).
 *
 * Every period figure is about one set of visits — diagnostic visits
 * registered in the period that need a report — so the charts add up to the
 * KPIs. No money: the lab in-charge opens this page too.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { formatPatientName } from '@/lib/patientDisplay';
import { KpiTile, ComparisonTrendChart, ActionQueue, GroupLabel, Delta, SERIES, HEAT, TH, ROW, TOTAL_ROW, type AttentionChip } from './_shared/dashboardCharts';
import {
  TOKENS,
  formatIstDateTime,
  formatIstTime,
  formatIstDate,
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

interface Kpis {
  visits: number;
  released: number;
  medianMinutes: number | null;
  within24Pct: number | null;
  deliveredPct: number | null;
  openedPct: number | null;
  consults: number;
}

interface OperationsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  comparison: { startIso: string; endIso: string; sameWeekday: boolean; cutAtNow?: boolean };
  branchScope: { branchId: string | null; branchName: string | null };
  attention: AttentionChip[];
  pipeline: { bands: string[]; rows: { stage: string; label: string; counts: number[] }[]; total: number };
  oldestOpen: {
    visitId: string;
    patientName: string;
    patientTitle: string | null;
    branchCode: string;
    tests: string;
    stage: string;
    ageMinutes: number;
  }[];
  clinicNow: {
    doctorId: string;
    doctorName: string;
    branchName: string | null;
    waiting: number;
    inConsultation: number;
    seenToday: number;
    longestWaitMinutes: number | null;
  }[];
  kpis: Kpis;
  prior: Kpis;
  byDay: { date: string; onTime: number; late: number; pending: number; medianMinutes: number | null }[];
  byHour: { hour: number; sameDay: number; later: number; notYet: number }[];
  departments: { name: string; visits: number; released: number; medianMinutes: number | null; within24Pct: number | null; filmsOnly: number }[];
  delivery: { released: number; sent: number; delivered: number; opened: number; printed: number };
  team: { userId: string; name: string; role: string; registered: number; testsEntered: number; reportsReleased: number }[];
  clinicDoctors: { doctorId: string; doctorName: string; consults: number; priorConsults: number; digitalRx: number; paperRx: number }[];
  failures: {
    patientId: string | null;
    patientName: string;
    patientTitle: string | null;
    phone: string;
    attemptCount: number;
    contextLabel: string;
    failureReason: string;
    lastTriedIso: string;
  }[];
  failureSummary: { patients: number; sends: number };
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
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const NOT_YET = '#C9C7BF';
const LATE = SERIES[1];
const ON_TIME = SERIES[0];

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

/** "vs last Tue (to this hour)" for a single day, else "vs prior period". */
function vsLabel(data: OperationsResponse): string {
  if (!data.comparison.sameWeekday) return 'vs prior period';
  const day = new Date(data.comparison.startIso).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' });
  return `vs last ${day}${data.comparison.cutAtNow ? ' by now' : ''}`;
}

/** 919989655190 → +91 99896 55190 */
const fmtPhone = (raw: string) => {
  const d = raw.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : raw;
};

// ----- KPIs ---------------------------------------------------------------

function OpsKpis({ data }: { data: OperationsResponse }) {
  const k = data.kpis;
  const p = data.prior;
  const vs = vsLabel(data);
  const pctDelta = (now: number, before: number) => {
    if (!before) return null;
    const c = Math.round(((now - before) / before) * 100);
    return { text: `${Math.abs(c)}%`, up: c >= 0 };
  };
  const ptsDelta = (now: number | null, before: number | null) => {
    if (now == null || before == null) return null;
    const d = now - before;
    return { text: d === 0 ? '0%' : `${Math.abs(d)} pts`, up: d >= 0 };
  };
  const open = k.visits - k.released;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiTile
        label="Reports out"
        hint={`${count(k.visits)} visits needed a report · ${count(open)} not out yet`}
        value={count(k.released)}
        delta={pctDelta(k.released, p.released)}
        vs={vs}
      />
      <KpiTile
        label="Typical turnaround"
        hint="Median time from registration to the first report out"
        value={k.medianMinutes != null ? fmtDuration(k.medianMinutes) : '—'}
        delta={k.medianMinutes != null && p.medianMinutes ? pctDelta(k.medianMinutes, p.medianMinutes) : null}
        deltaGoodWhenUp={false}
        vs={vs}
      />
      <KpiTile
        label="Out within 24h"
        hint="Of visits whose day is up: reports out within 24 hours of registration"
        value={k.within24Pct != null ? `${k.within24Pct}%` : '—'}
        delta={ptsDelta(k.within24Pct, p.within24Pct)}
        vs={vs}
      />
      <KpiTile
        label="Delivered on WhatsApp"
        hint="Of reports out, the patient's WhatsApp received the message"
        value={k.deliveredPct != null ? `${k.deliveredPct}%` : '—'}
        delta={ptsDelta(k.deliveredPct, p.deliveredPct)}
        vs={vs}
      />
      <KpiTile
        label="Opened online"
        hint="Of reports out, the patient opened the report link or the app"
        value={k.openedPct != null ? `${k.openedPct}%` : '—'}
        delta={ptsDelta(k.openedPct, p.openedPct)}
        vs={vs}
      />
      <KpiTile label="Clinic consults" value={count(k.consults)} delta={pctDelta(k.consults, p.consults)} vs={vs} />
    </div>
  );
}

// ----- live: open reports ------------------------------------------------

/** Open visits by stage × time since registration. Darker = more visits. */
function PipelineCard({ data }: { data: OperationsResponse['pipeline'] }) {
  const max = Math.max(1, ...data.rows.flatMap((r) => r.counts));
  const colTotal = (i: number) => data.rows.reduce((s, r) => s + r.counts[i], 0);
  return (
    <SectionCard
      label="Open reports · live"
      description="By stage, and how long since the patient registered"
      className="h-full"
      rightSlot={
        <Link to="/diagnostics/pending" style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}>
          Pending ↗
        </Link>
      }
    >
      {data.total === 0 ? (
        <div style={{ color: TOKENS.healthy, fontSize: 13 }}>Nothing open. Every report is out.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', borderCollapse: 'separate', borderSpacing: 2 }}>
            <thead>
              <tr>
                <th className="pb-1 text-left align-bottom" style={TH}>Stage</th>
                {data.bands.map((b, i) => (
                  <th key={b} className="pb-1 text-right align-bottom" style={{ ...TH, minWidth: 56, color: i >= 2 ? TOKENS.critical : TH.color }}>
                    {b}
                  </th>
                ))}
                <th className="pb-1 text-right align-bottom" style={{ ...TH, minWidth: 44 }}>All</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const sum = r.counts.reduce((s, c) => s + c, 0);
                return (
                  <tr key={r.stage}>
                    <td className="py-1.5 pr-2" style={{ color: sum ? TOKENS.textPrimary : TOKENS.textTertiary }}>{r.label}</td>
                    {r.counts.map((c, i) => {
                      const step = Math.min(HEAT.length - 1, Math.floor((c / max) * HEAT.length));
                      return (
                        <td
                          key={i}
                          className="px-2 py-1.5 text-right"
                          title={c ? `${r.label} · ${data.bands[i]}: ${c} visit${c === 1 ? '' : 's'}` : undefined}
                          style={{
                            borderRadius: 4,
                            background: c ? HEAT[step] : 'transparent',
                            color: !c ? TOKENS.textTertiary : step >= 3 ? 'white' : TOKENS.textPrimary,
                          }}
                        >
                          {c || '·'}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-right font-medium">{sum}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-medium" style={TOTAL_ROW}>
                <td className="pt-2">All open</td>
                {data.bands.map((b, i) => (
                  <td key={b} className="px-2 pt-2 text-right" style={{ color: i >= 2 && colTotal(i) ? TOKENS.critical : undefined }}>
                    {colTotal(i)}
                  </td>
                ))}
                <td className="px-2 pt-2 text-right">{data.total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function OldestOpenCard({ rows, total }: { rows: OperationsResponse['oldestOpen']; total: number }) {
  return (
    <SectionCard label="Waiting longest · live" description="Oldest open visits first" className="h-full">
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>Nothing waiting.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr className="text-left">
                <th className="pb-1" style={TH}>Patient · tests</th>
                <th className="pb-1" style={TH}>Stage</th>
                <th className="pb-1 text-right" style={TH}>Waiting</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.visitId} style={ROW}>
                  <td className="py-1.5 pr-3" style={{ maxWidth: 340 }}>
                    <Link to={`/diagnostics/results/${r.visitId}`} style={{ color: TOKENS.info, textDecoration: 'none' }}>
                      {formatPatientName(r.patientName, r.patientTitle)}
                    </Link>
                    <div className="truncate" style={{ color: TOKENS.textTertiary, fontSize: 11 }} title={r.tests}>
                      {r.branchCode} · {r.tests}
                    </div>
                  </td>
                  <td className="py-1.5 pr-3" style={{ color: TOKENS.textSecondary, whiteSpace: 'nowrap' }}>{r.stage}</td>
                  <td
                    className="py-1.5 text-right"
                    style={{ whiteSpace: 'nowrap', color: r.ageMinutes > 1440 ? TOKENS.critical : TOKENS.textPrimary }}
                  >
                    {fmtDuration(r.ageMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > rows.length && (
        <div className="mt-2" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
          {rows.length} of {total} open ·{' '}
          <Link to="/diagnostics/pending" style={{ color: TOKENS.info, textDecoration: 'none' }}>
            see all ↗
          </Link>
        </div>
      )}
    </SectionCard>
  );
}

// ----- turnaround ---------------------------------------------------------

function TurnaroundByDayCard({ data, periodLabel, onPickDay }: { data: OperationsResponse; periodLabel: string; onPickDay: (d: string) => void }) {
  const days = data.byDay;
  const k = data.kpis;
  return (
    <SectionCard
      label={`Reports out on time · ${periodLabel}`}
      description="Visits by the day they registered · click a day to see just that day"
      className="h-full"
    >
      <div className="mb-1 flex flex-wrap gap-4" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
        <Swatch color={ON_TIME} label="Out within 24h" />
        <Swatch color={LATE} label="Took longer" />
        <Swatch color={NOT_YET} label="Not out yet, under 24h" />
        {k.medianMinutes != null && (
          <span style={{ marginLeft: 'auto', color: TOKENS.textTertiary }}>Typical {fmtDuration(k.medianMinutes)}</span>
        )}
      </div>
      <ComparisonTrendChart
        days={days.map((d) => ({ date: d.date, value: d.onTime + d.late + d.pending, prior: null }))}
        average={days.map(() => null)}
        priorAverage={days.map(() => null)}
        format={count}
        valueLabel="Visits"
        height={280}
        onPickDay={onPickDay}
        note={(i) => (days[i].medianMinutes != null ? `Typical ${fmtDuration(days[i].medianMinutes!)}` : null)}
        parts={[
          { label: 'Out within 24h', color: ON_TIME, values: days.map((d) => d.onTime) },
          { label: 'Took longer', color: LATE, values: days.map((d) => d.late) },
          { label: 'Not out yet', color: NOT_YET, values: days.map((d) => d.pending) },
        ]}
      />
    </SectionCard>
  );
}

/** Visits by the hour they registered: report the same day, later, or not yet. */
function ArrivalHourCard({ rows, periodLabel }: { rows: OperationsResponse['byHour']; periodLabel: string }) {
  const sameDayPct = (rs: typeof rows) => {
    const done = rs.reduce((s, r) => s + r.sameDay + r.later, 0);
    return done ? Math.round((rs.reduce((s, r) => s + r.sameDay, 0) / done) * 100) : null;
  };
  const early = sameDayPct(rows.filter((r) => r.hour < 17));
  const late = sameDayPct(rows.filter((r) => r.hour >= 17));
  // Every hour from the first to the last visit, so quiet hours show as gaps.
  const from = rows.length ? Math.min(...rows.map((r) => r.hour)) : 7;
  const to = rows.length ? Math.max(...rows.map((r) => r.hour)) : 21;
  const at = new Map(rows.map((r) => [r.hour, r]));
  const hours = Array.from({ length: to - from + 1 }, (_, i) => at.get(from + i) ?? { hour: from + i, sameDay: 0, later: 0, notYet: 0 });
  return (
    <SectionCard
      label={`When patients come in · ${periodLabel}`}
      description="Visits by the hour they registered, and whether the report went out the same day"
      className="h-full"
    >
      {early != null && late != null && (
        <div className="mb-2" style={{ fontSize: 13, color: TOKENS.textSecondary }}>
          Registered after 5 pm: <strong style={{ color: late < early - 15 ? TOKENS.critical : TOKENS.textPrimary }}>{late}%</strong> got the report the same day,
          against <strong style={{ color: TOKENS.textPrimary }}>{early}%</strong> before 5 pm.
        </div>
      )}
      <div className="mb-1 flex flex-wrap gap-4" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
        <Swatch color={ON_TIME} label="Same day" />
        <Swatch color={LATE} label="Next day or later" />
        <Swatch color={NOT_YET} label="Not out yet (today)" />
      </div>
      <ComparisonTrendChart
        days={hours.map((h) => ({ date: String(h.hour), value: h.sameDay + h.later + h.notYet, prior: null }))}
        average={hours.map(() => null)}
        priorAverage={hours.map(() => null)}
        format={count}
        valueLabel="Visits"
        height={260}
        axisLabel={(k) => hourLabel(Number(k))}
        titleLabel={(k) => `${hourLabel(Number(k))}–${hourLabel(Number(k) + 1)}`}
        note={(i) => {
          const h = hours[i];
          const done = h.sameDay + h.later;
          return done ? `${Math.round((h.sameDay / done) * 100)}% same day` : null;
        }}
        parts={[
          { label: 'Same day', color: ON_TIME, values: hours.map((h) => h.sameDay) },
          { label: 'Next day or later', color: LATE, values: hours.map((h) => h.later) },
          { label: 'Not out yet', color: NOT_YET, values: hours.map((h) => h.notYet) },
        ]}
      />
    </SectionCard>
  );
}

function DepartmentsCard({ rows, periodLabel }: { rows: OperationsResponse['departments']; periodLabel: string }) {
  return (
    <SectionCard
      label={`By department · ${periodLabel}`}
      description="Registration to that department's report"
      className="h-full"
    >
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No visits in this period.</div>
      ) : (
        <>
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
                const notes = [d.filmsOnly ? `${d.filmsOnly} films only` : '', open > 0 ? `${open} open` : ''].filter(Boolean).join(' · ');
                return (
                  <tr key={d.name} style={ROW}>
                    <td className="py-1.5 pr-2">
                      {d.name}
                      {notes && <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>{notes}</div>}
                    </td>
                    <td className="py-1.5 text-right">{count(d.visits)}</td>
                    <td className="py-1.5 text-right">{d.medianMinutes != null ? fmtDuration(d.medianMinutes) : '—'}</td>
                    <td
                      className="py-1.5 text-right"
                      style={{ color: d.within24Pct != null && d.within24Pct < 80 ? TOKENS.critical : undefined }}
                    >
                      {d.within24Pct != null ? `${d.within24Pct}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
            A patient counts once per department. Films only = closed without a typed report.
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ----- delivery -----------------------------------------------------------

function DeliveryCard({ d, failedPatients, periodLabel }: { d: OperationsResponse['delivery']; failedPatients: number; periodLabel: string }) {
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
    <SectionCard label={`How reports reach patients · ${periodLabel}`} description="Of reports out in this period" className="h-full">
      {d.released === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No reports out yet.</div>
      ) : (
        <>
          {step('Reports out', d.released, ON_TIME)}
          {step('Sent on WhatsApp', d.sent, ON_TIME)}
          {step('Delivered', d.delivered, ON_TIME, 'Reached the phone (delivered or read)')}
          {step('Opened online', d.opened, ON_TIME, 'Patient opened the report link or the app')}
          <div className="mt-3">{step('Printed at the counter', d.printed, NOT_YET)}</div>
          {failedPatients > 0 && (
            <a
              href="#failed-messages"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById('failed-messages')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="mt-3 block"
              style={{ fontSize: 12, color: TOKENS.info, textDecoration: 'none' }}
            >
              {failedPatients} patient{failedPatients === 1 ? '' : 's'} with a failed message ↓
            </a>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ----- people -------------------------------------------------------------

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', lab_incharge: 'Lab in-charge', staff: 'Front desk' };

function TeamCard({ rows, periodLabel }: { rows: OperationsResponse['team']; periodLabel: string }) {
  const sum = (k: 'registered' | 'testsEntered' | 'reportsReleased') => rows.reduce((s, r) => s + r[k], 0);
  return (
    <SectionCard label={`Team · ${periodLabel}`} description="Who did the work, diagnostics and clinic" className="h-full">
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No activity in this period.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th className="pb-1 text-left" style={TH}>Person</th>
                <th className="pb-1 text-right" style={TH} title="Visits registered (diagnostics and clinic)">Registered</th>
                <th className="pb-1 text-right" style={TH} title="Tests whose results they entered">Tests entered</th>
                <th className="pb-1 text-right" style={TH} title="Reports they finalized and released">Reports released</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} style={ROW}>
                  <td className="py-1.5 pr-2">
                    {r.name}
                    <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {ROLE_LABEL[r.role] ?? r.role}</span>
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
        </div>
      )}
    </SectionCard>
  );
}

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
      <div className="mb-3" style={{ fontSize: 13 }}>
        <div style={{ color: TOKENS.textTertiary, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase' }}>Now</div>
        {data.clinicNow.length === 0 ? (
          <div style={{ color: TOKENS.textSecondary }}>Nobody waiting for a doctor.</div>
        ) : (
          data.clinicNow.map((c) => (
            <div key={c.doctorId} className="flex flex-wrap justify-between gap-x-3">
              <span>{c.doctorName}</span>
              <span style={{ color: TOKENS.textSecondary }}>
                <span style={{ color: (c.longestWaitMinutes ?? 0) > 30 ? TOKENS.critical : undefined }}>
                  {c.waiting} waiting{c.longestWaitMinutes != null ? ` · longest ${fmtDuration(c.longestWaitMinutes)}` : ''}
                </span>
                {c.inConsultation ? ` · ${c.inConsultation} in with the doctor` : ''} · {c.seenToday} seen today
              </span>
            </div>
          ))
        )}
      </div>
      {rows.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No consults in this period.</div>
      ) : (
        <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th className="pb-1 text-left" style={TH}>Doctor</th>
              <th className="pb-1 text-right" style={TH}>Consults</th>
              <th className="pb-1 text-right" style={TH}>vs before</th>
              <th className="pb-1 text-right" style={TH} title="Prescriptions written in the app · on paper">Rx app · paper</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.doctorId} style={ROW}>
                <td className="py-1.5 pr-2">{r.doctorName}</td>
                <td className="py-1.5 text-right">{count(r.consults)}</td>
                <td className="py-1.5 text-right"><Delta now={r.consults} before={r.priorConsults} /></td>
                <td className="py-1.5 text-right" style={{ color: TOKENS.textSecondary }}>
                  {r.digitalRx} · {r.paperRx}
                </td>
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
      <div className="mt-2" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        No time-with-doctor figure: the desk marks visits done in batches, so those times describe the desk, not the consult.
      </div>
    </SectionCard>
  );
}

// ----- failed messages ----------------------------------------------------

function FailedMessagesCard({ data, periodLabel }: { data: OperationsResponse; periodLabel: string }) {
  const rows = data.failures;
  const s = data.failureSummary;
  return (
    <div id="failed-messages" style={{ scrollMarginTop: 16 }} className="h-full">
      <SectionCard
        label={`Messages that didn't reach the patient · ${periodLabel}`}
        description="Reports, bills and prescriptions (campaigns left out) · call them on the number shown"
        className="h-full"
        rightSlot={
          s.patients > 0 ? (
            <span style={{ fontSize: 12, color: TOKENS.textTertiary }}>
              {s.patients} patient{s.patients === 1 ? '' : 's'} · {s.sends} failed send{s.sends === 1 ? '' : 's'}
            </span>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <div style={{ color: TOKENS.healthy, fontSize: 13 }}>Every message in this period reached the patient's WhatsApp.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: 13 }}>
              <thead>
                <tr className="text-left">
                  <th className="pb-1" style={TH}>Patient</th>
                  <th className="pb-1" style={TH}>Number</th>
                  <th className="pb-1" style={TH}>What failed</th>
                  <th className="pb-1" style={TH}>Why</th>
                  <th className="pb-1 text-right" style={TH}>Last tried</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.patientId ?? `${r.phone}-${i}`} style={ROW}>
                    <td className="py-1.5 pr-3">
                      {r.patientId ? (
                        <Link to={`/clinic/patient-360/${r.patientId}`} style={{ color: TOKENS.info, textDecoration: 'none' }}>
                          {formatPatientName(r.patientName, r.patientTitle)}
                        </Link>
                      ) : (
                        formatPatientName(r.patientName, r.patientTitle)
                      )}
                    </td>
                    <td className="py-1.5 pr-3" style={{ whiteSpace: 'nowrap' }}>
                      <a href={`tel:+${r.phone.replace(/[^\d]/g, '')}`} style={{ color: TOKENS.info, textDecoration: 'none', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtPhone(r.phone)}
                      </a>
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: TOKENS.textSecondary, whiteSpace: 'nowrap' }}>
                      {r.attemptCount > 1 ? `${r.attemptCount} sends · ` : ''}
                      {r.contextLabel}
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: TOKENS.textSecondary }}>{r.failureReason}</td>
                    <td className="py-1.5 text-right" style={{ color: TOKENS.textTertiary, whiteSpace: 'nowrap' }}>
                      {formatIstDate(r.lastTriedIso)} {formatIstTime(r.lastTriedIso)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.patients > rows.length && (
          <div className="mt-2" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
            Latest {rows.length} of {s.patients} patients.
          </div>
        )}
      </SectionCard>
    </div>
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
    refetchInterval: 60 * 1000, // the live half should feel live
    staleTime: 30 * 1000,
  });

  // A server still on the old shape (deploy skew) has no pipeline: wait for it.
  const data = query.data?.pipeline ? query.data : undefined;
  const periodLabel = period === 'custom' ? `${customStart} – ${customEnd}` : PERIOD_LABEL[period];
  const multiDay = (data?.byDay.length ?? 0) > 1;

  return (
    <AppLayout context="owner" hideContextBanner>
      <div className="mx-auto" style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}>
        <OwnerPageHeader
          title="Operations"
          subtitle={
            data
              ? `${formatIstDateTime(data.generatedAt)} · ${data.branchScope.branchName ?? 'all branches'} · live parts refresh every minute`
              : 'Loading…'
          }
          rightSlot={
            <>
              <PeriodFilter
                value={period}
                onChange={setPeriod}
                options={OPS_PERIOD_OPTS}
                customRange={{ start: customStart || todayKey(), end: customEnd || todayKey() }}
                onCustomRangeChange={setCustomRange}
              />
              <BranchFilter value={branchValue} onChange={setBranchValue} />
              <RefreshButton isFetching={query.isFetching} onClick={() => query.refetch()} />
            </>
          }
        />

        {(query.isLoading || (query.data && !data)) && <FullPageSkeleton />}
        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div className="space-y-4">
            <div>
              <GroupLabel>Needs attention · live</GroupLabel>
              <ActionQueue chips={data.attention} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <PipelineCard data={data.pipeline} />
              </div>
              <div className="lg:col-span-7">
                <OldestOpenCard rows={data.oldestOpen} total={data.pipeline.total} />
              </div>
            </div>

            <div>
              <GroupLabel>{periodLabel} · visits registered in the period</GroupLabel>
              <OpsKpis data={data} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-8">
                {multiDay ? (
                  <TurnaroundByDayCard data={data} periodLabel={periodLabel} onPickDay={(d) => setCustomRange({ start: d, end: d })} />
                ) : (
                  <ArrivalHourCard rows={data.byHour} periodLabel={periodLabel} />
                )}
              </div>
              <div className="lg:col-span-4">
                <DepartmentsCard rows={data.departments} periodLabel={periodLabel} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              {multiDay ? (
                <div className="lg:col-span-7">
                  <ArrivalHourCard rows={data.byHour} periodLabel={periodLabel} />
                </div>
              ) : (
                <div className="lg:col-span-7">
                  <FailedMessagesCard data={data} periodLabel={periodLabel} />
                </div>
              )}
              <div className="lg:col-span-5">
                <DeliveryCard d={data.delivery} failedPatients={data.failureSummary.patients} periodLabel={periodLabel} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-7">
                <TeamCard rows={data.team} periodLabel={periodLabel} />
              </div>
              <div className="lg:col-span-5">
                <ClinicCard data={data} periodLabel={periodLabel} />
              </div>
            </div>

            {multiDay && <FailedMessagesCard data={data} periodLabel={periodLabel} />}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
