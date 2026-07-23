/**
 * Owner Operations page — GET /api/owner/operations
 *
 * Answers: are reports going out on time, where is the queue stuck, what
 * looks wrong, what failed.
 *
 * Layout:
 *   - 4 KPI: TAT median / finalized today / in queue / delivery rate
 *   - Report turnaround buckets (last 7 days)
 *   - Diagnostics queue (50%) + Clinic queue grouped by doctor (50%)
 *   - Audit feed
 *   - Communication failures (conditional — hides at zero)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { formatPatientName } from '@/lib/patientDisplay';
import {
  TOKENS,
  formatIstDateTime,
  formatIstTime,
  SectionCard,
  KpiCard,
  BranchFilter,
  OwnerPageHeader,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
  SeverityBadge,
  TruncationFooter,
} from './_shared/ownerUi';

interface OperationsResponse {
  generatedAt: string;
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: {
    tatMedianMinutes: number | null;
    tatSampleCount: number;
    finalizedToday: number;
    finalizableToday: number;
    inQueue: number;
    inQueueDiagnostics: number;
    inQueueClinic: number;
    deliveryRatePercent: number | null;
    deliveryAttempted: number;
    inFlight: number;
  };
  reportTurnaround: {
    sampleCount: number;
    windowDays: number;
    medianMinutes: number | null;
    slaMinutes: number;
    withinSlaPercent: number | null;
    overSlaCount: number;
    buckets: { label: string; count: number }[];
  };
   diagnosticsQueue: Array<{
     visitId: string;
     patientName: string;
     patientTitle?: string | null;
     branchCode: string;
    productName: string | null;
    stage:
      | 'awaiting result entry'
      | 'in progress'
      | 'draft · awaiting sign-off'
      | 'sample pending'
      | 'PDF missing';
    ageMinutes: number;
  }>;
  clinicQueue: Array<{
    doctorId: string;
    doctorName: string;
    branchName: string | null;
    shiftStartIso: string | null;
    waitingCount: number;
    inProgressCount: number;
    avgWaitMinutes: number | null;
     patients: Array<{
       visitId: string;
       patientName: string;
       patientTitle?: string | null;
       visitType: 'OP' | 'IP';
      waitMinutes: number;
    }>;
  }>;
  audit: Array<{
    id: string;
    severity: 'high' | 'medium' | 'low';
    event: string;
    who: string | null;
    detail: string;
    whenIso: string;
    drillTo: string | null;
  }>;
   commsFailures: Array<{
     patientName: string;
     patientTitle?: string | null;
     channel: 'WHATSAPP' | 'SMS';
    context: string;
    errorCode: string | null;
    failureReason: string;
    action: string;
    phone: string;
    failedAtIso: string;
  }>;
}

// ----- TAT histogram ----------------------------------------------------

// Compact human label for a duration in minutes (axis spans hours now).
// Human-readable duration that adapts to magnitude:
//   < 60 min  → "45m"
//   < 24 h    → "6h 18m" (drops 0m → "6h")
//   >= 24 h   → "2d 4h"  (drops 0h → "2d")
function fmtDuration(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const totalH = Math.floor(m / 60);
  const rem = m % 60;
  if (totalH < 24) return rem === 0 ? `${totalH}h` : `${totalH}h ${rem}m`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

// One turnaround bucket. The row shows a raw count; what it never says is how
// big a slice of the week that is, so hover/focus reveals the share in the
// count cell (whose width is reserved up front, so nothing shifts).
function TurnaroundRow({
  label,
  count,
  maxCount,
  sampleCount,
  color,
}: {
  label: string;
  count: number;
  maxCount: number;
  sampleCount: number;
  color: string;
}) {
  const [hovered, setHovered] = useState(false);
  const pct = sampleCount > 0 ? Math.round((count / sampleCount) * 100) : 0;
  return (
    <div
      className="flex items-center gap-3"
      style={{ fontSize: 12, outline: 'none', cursor: 'default' }}
      tabIndex={0}
      aria-label={`${label}: ${count} reports, ${pct} percent of the window`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div style={{ width: 92, flexShrink: 0, color: TOKENS.textSecondary }}>{label}</div>
      <div className="flex-1">
        <div
          style={{
            width: `${count === 0 ? 0 : Math.max(3, (count / maxCount) * 100)}%`,
            height: hovered ? 12 : 10,
            borderRadius: 3,
            background: color,
            transition: 'height 120ms ease',
          }}
        />
      </div>
      <div
        style={{
          width: 68,
          flexShrink: 0,
          textAlign: 'right',
          color: TOKENS.textSecondary,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {hovered ? `${count} · ${pct}%` : count}
      </div>
    </div>
  );
}

// Report turnaround, in plain language for owners/managers: a "typical" time,
// the share within the 24h SLA, and fixed time buckets with counts. Fixed
// buckets mean a single slow report can't stretch the scale — it just lands in
// "Over 3 days" — which is what made the old percentile histogram unreadable.
function ReportTurnaroundCard({
  turnaround,
}: {
  turnaround: OperationsResponse['reportTurnaround'];
}) {
  if (turnaround.sampleCount === 0) {
    return (
      <SectionCard label="Report turnaround" description={`Last ${turnaround.windowDays} days`}>
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          No reports finalized yet.
        </div>
      </SectionCard>
    );
  }
  const maxCount = Math.max(1, ...turnaround.buckets.map((b) => b.count));
  // Within the day = green; past the SLA (1–3 days / 3 days+) tints amber → red.
  const barColor = (label: string) =>
    label === 'Over 3 days'
      ? TOKENS.critical
      : label === '1–3 days'
        ? TOKENS.caution
        : TOKENS.healthy;

  return (
    <SectionCard
      label="Report turnaround"
      description={`Last ${turnaround.windowDays} days · registration to report`}
    >
      <div className="mb-3" style={{ fontSize: 13, color: TOKENS.textSecondary }}>
        {turnaround.medianMinutes !== null && (
          <>
            Typical{' '}
            <strong style={{ color: TOKENS.textPrimary }}>
              {fmtDuration(turnaround.medianMinutes)}
            </strong>
          </>
        )}
        {turnaround.withinSlaPercent !== null && (
          <>
            {' · '}
            <strong style={{ color: TOKENS.textPrimary }}>
              {turnaround.withinSlaPercent}%
            </strong>{' '}
            ready within a day
          </>
        )}
      </div>

      <div className="space-y-1.5">
        {turnaround.buckets.map((b) => (
          <TurnaroundRow
            key={b.label}
            label={b.label}
            count={b.count}
            maxCount={maxCount}
            sampleCount={turnaround.sampleCount}
            color={barColor(b.label)}
          />
        ))}
      </div>

      {turnaround.overSlaCount > 0 && (
        <div
          className="mt-3 border-t pt-2"
          style={{ borderColor: TOKENS.border, fontSize: 12 }}
        >
          <span style={{ color: TOKENS.critical }}>
            {turnaround.overSlaCount} report{turnaround.overSlaCount === 1 ? '' : 's'} took over a
            day
          </span>{' '}
          <Link to="/diagnostics/pending?filter=overdue" style={{ color: TOKENS.info }}>
            view ↗
          </Link>
        </div>
      )}
    </SectionCard>
  );
}

// ----- diagnostics queue -----------------------------------------------

function DiagnosticsQueueCard({ rows }: { rows: OperationsResponse['diagnosticsQueue'] }) {
  if (rows.length === 0) {
    return (
      <SectionCard label="Diagnostics queue" description="Live · oldest first">
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          Queue is clear.
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      label="Diagnostics queue"
      description="Live · oldest first"
      rightSlot={
        <Link
          to="/diagnostics/pending"
          style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
        >
          view all ↗
        </Link>
      }
    >
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
              <th className="pb-2">Patient · product</th>
              <th className="pb-2">Stage</th>
              <th className="pb-2 text-right">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => {
              const ageColor =
                r.ageMinutes > 30
                  ? TOKENS.critical
                  : r.ageMinutes > 15
                    ? TOKENS.caution
                    : TOKENS.textPrimary;
              return (
                <tr key={r.visitId} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                  <td className="py-2">
                    <Link
                      to={`/diagnostics/results/${r.visitId}`}
                      style={{ color: TOKENS.info, textDecoration: 'none' }}
                    >
                      {formatPatientName(r.patientName, r.patientTitle)}
                    </Link>
                    <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                      {r.branchCode} · {r.productName ?? '—'}
                    </div>
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                    {r.stage}
                  </td>
                  <td className="py-2 text-right" style={{ color: ageColor }}>
                    {fmtDuration(r.ageMinutes)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TruncationFooter shown={Math.min(10, rows.length)} total={rows.length} />
    </SectionCard>
  );
}

// ----- clinic queue grouped by doctor ----------------------------------

function ClinicQueueCard({ groups }: { groups: OperationsResponse['clinicQueue'] }) {
  if (groups.length === 0) {
    return (
      <SectionCard label="Clinic queue" description="Grouped by doctor on shift">
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          No clinic doctor on shift.
        </div>
      </SectionCard>
    );
  }
  return (
    <SectionCard
      label="Clinic queue"
      description="Grouped by doctor · oldest waiting first"
      rightSlot={
        <Link
          to="/clinic/queue"
          style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
        >
          view all ↗
        </Link>
      }
    >
      <div className="space-y-3">
        {groups.map((g) => (
          <div
            key={g.doctorId}
            style={{
              borderTop: `0.5px solid ${TOKENS.border}`,
              paddingTop: 8,
            }}
          >
            <div className="flex items-baseline justify-between">
              <div className="flex items-center gap-2">
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: '#E5F4ED',
                    color: TOKENS.healthy,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  {g.doctorName
                    .split(' ')
                    .filter(Boolean)
                    .map((s) => s[0])
                    .slice(0, 2)
                    .join('')
                    .toUpperCase()}
                </span>
                <span>
                  <span style={{ color: TOKENS.textPrimary, fontSize: 13 }}>
                    {g.doctorName}
                  </span>
                  <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                    {g.branchName ?? '—'}
                    {g.shiftStartIso && ` · first consult at ${formatIstTime(g.shiftStartIso)}`}
                  </div>
                </span>
              </div>
              <div style={{ fontSize: 12, color: TOKENS.textSecondary }}>
                {g.waitingCount} waiting · {g.inProgressCount} in consultation
                {g.avgWaitMinutes !== null && ` · avg wait ${fmtDuration(g.avgWaitMinutes)}`}
              </div>
            </div>
            {g.patients.length > 0 && (
              <div className="mt-2 space-y-1 pl-10">
                {g.patients.slice(0, 5).map((p) => (
                  <div
                    key={p.visitId}
                    className="flex items-baseline justify-between"
                    style={{ fontSize: 12 }}
                  >
                    <span>
                      <span style={{ color: TOKENS.textPrimary }}>{formatPatientName(p.patientName, p.patientTitle)}</span>
                      <span
                        style={{
                          fontSize: 10,
                          marginLeft: 6,
                          padding: '1px 4px',
                          background: p.visitType === 'IP' ? '#FCEBEB30' : '#E5F0FB',
                          color: p.visitType === 'IP' ? TOKENS.critical : TOKENS.info,
                          borderRadius: 3,
                        }}
                      >
                        {p.visitType}
                      </span>
                    </span>
                    <span
                      style={{
                        color: p.waitMinutes > 30 ? TOKENS.critical : TOKENS.textTertiary,
                      }}
                    >
                      {fmtDuration(p.waitMinutes)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ----- audit feed -------------------------------------------------------

function AuditFeedCard({ rows }: { rows: OperationsResponse['audit'] }) {
  if (rows.length === 0) {
    return (
      <SectionCard label="Audit & anomalies">
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          Nothing notable in the last 24h.
        </div>
      </SectionCard>
    );
  }
  return (
    <SectionCard
      label="Audit & anomalies"
      description="Last 20 high/medium/low events in 24h"
    >
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
              <th className="pb-2">Severity</th>
              <th className="pb-2">Event</th>
              <th className="pb-2">Who</th>
              <th className="pb-2">Detail</th>
              <th className="pb-2">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                <td className="py-2">
                  <SeverityBadge severity={r.severity} />
                </td>
                <td className="py-2" style={{ color: TOKENS.textPrimary }}>
                  {r.drillTo ? (
                    <Link to={r.drillTo} style={{ color: TOKENS.info, textDecoration: 'none' }}>
                      {r.event}
                    </Link>
                  ) : (
                    r.event
                  )}
                </td>
                <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                  {r.who ?? '—'}
                </td>
                <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                  {r.detail}
                </td>
                <td className="py-2" style={{ color: TOKENS.textTertiary }}>
                  {formatIstTime(r.whenIso)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ----- comms failures ---------------------------------------------------

function CommsFailuresCard({ rows }: { rows: OperationsResponse['commsFailures'] }) {
  // Per brief §7.7: hides entirely when count is 0
  if (rows.length === 0) return null;
  return (
    <SectionCard label="Communication failures · last 24h">
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
              <th className="pb-2">Patient</th>
              <th className="pb-2">Channel</th>
              <th className="pb-2">Context</th>
              <th className="pb-2">Reason</th>
              <th className="pb-2">Action</th>
              <th className="pb-2">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                <td className="py-2" style={{ color: TOKENS.textPrimary }}>
                  {formatPatientName(r.patientName, r.patientTitle)}
                </td>
                <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                  {r.channel.toLowerCase()}
                </td>
                <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                  {r.context}
                </td>
                <td className="py-2" style={{ color: TOKENS.critical }}>
                  {r.errorCode && (
                    <span
                      style={{ color: TOKENS.textTertiary, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {r.errorCode}
                      {' · '}
                    </span>
                  )}
                  {r.failureReason}
                </td>
                <td
                  className="py-2"
                  style={{ color: TOKENS.textTertiary, fontVariantNumeric: 'tabular-nums' }}
                >
                  {/* "call patient" is only actionable with the number in hand */}
                  {r.action === 'call patient' && r.phone ? `call ${r.phone}` : r.action}
                </td>
                <td className="py-2" style={{ color: TOKENS.textTertiary }}>
                  {formatIstTime(r.failedAtIso)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ----- main page --------------------------------------------------------

export default function OwnerOperationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';

  const setBranchValue = (newBranch: string) => {
    setSearchParams(prev => {
      prev.set('branch', newBranch);
      return prev;
    });
  };

  const query = useQuery<OperationsResponse>({
    queryKey: ['owner-operations', branchValue],
    queryFn: () =>
      apiRequest<OperationsResponse>(
        `${API_BASE}/owner/operations?branch=${encodeURIComponent(branchValue)}`,
      ),
    refetchInterval: 30 * 1000, // live page — 30s
    staleTime: 15 * 1000,
  });

  const data = query.data;

  return (
    <AppLayout context="owner" hideContextBanner>
      <div
        className="mx-auto"
        style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}
      >
        <OwnerPageHeader
          title="Operations"
          subtitle={
            data
              ? `${formatIstDateTime(data.generatedAt)} · ${
                  data.branchScope.branchName ?? 'all branches'
                } · live`
              : 'Loading…'
          }
          rightSlot={
            <>
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
                label="Registration→Report (median)"
                value={
                  data.kpis.tatMedianMinutes !== null
                    ? fmtDuration(data.kpis.tatMedianMinutes)
                    : '—'
                }
                sub={
                  data.kpis.tatSampleCount >= 4
                    ? `${data.kpis.tatSampleCount} reports · last 7 days`
                    : `${data.kpis.tatSampleCount}/4 samples · baseline forming`
                }
              />
              <KpiCard
                label="Reports finalized today"
                value={data.kpis.finalizedToday}
                sub="since midnight"
              />
              <KpiCard
                label="In queue right now"
                value={data.kpis.inQueue}
                sub={
                  Number.isFinite(data.kpis.inQueueDiagnostics)
                    ? `incl. ${data.kpis.inQueueDiagnostics} diagnostics + ${data.kpis.inQueueClinic} clinic`
                    : undefined
                }
              />
              <KpiCard
                label="Message delivery"
                value={
                  data.kpis.deliveryRatePercent !== null
                    ? `${data.kpis.deliveryRatePercent}%`
                    : data.kpis.inFlight > 0
                      ? 'in flight'
                      : '—'
                }
                sub={
                  data.kpis.deliveryRatePercent === null && data.kpis.inFlight > 0
                    ? `${data.kpis.inFlight} awaiting delivery receipts · 0 settled`
                    : `${data.kpis.deliveryAttempted} settled${
                        Number.isFinite(data.kpis.inFlight) ? ` · ${data.kpis.inFlight} in flight` : ''
                      }`
                }
              />
            </div>

            <ReportTurnaroundCard turnaround={data.reportTurnaround} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DiagnosticsQueueCard rows={data.diagnosticsQueue} />
              <ClinicQueueCard groups={data.clinicQueue} />
            </div>

            <AuditFeedCard rows={data.audit} />

            <CommsFailuresCard rows={data.commsFailures} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
