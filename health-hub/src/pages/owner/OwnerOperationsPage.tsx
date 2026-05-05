/**
 * Owner Operations page — GET /api/owner/operations
 *
 * Answers: are reports going out on time, where is the queue stuck, what
 * looks wrong, what failed.
 *
 * Layout:
 *   - 4 KPI: TAT median / finalized today / in queue / delivery rate
 *   - TAT distribution histogram (last 100)
 *   - Diagnostics queue (50%) + Clinic queue grouped by doctor (50%)
 *   - Audit feed
 *   - Communication failures (conditional — hides at zero)
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
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
    deliveryRatePercent: number | null;
    deliveryAttempted: number;
  };
  tatHistogram: {
    bins: { rangeMin: number; rangeMax: number; count: number }[];
    p50Minutes: number | null;
    p95Minutes: number | null;
    slaMinutes: number;
    breachCount: number;
    sampleCount: number;
  };
  diagnosticsQueue: Array<{
    visitId: string;
    patientName: string;
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
    channel: 'WHATSAPP' | 'SMS';
    context: string;
    failureReason: string;
    action: string;
    failedAtIso: string;
  }>;
}

// ----- TAT histogram ----------------------------------------------------

function TatHistogramCard({ histogram }: { histogram: OperationsResponse['tatHistogram'] }) {
  if (histogram.sampleCount === 0) {
    return (
      <SectionCard label="TAT distribution" description="Last 100 finalized reports">
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
          No finalized reports yet.
        </div>
      </SectionCard>
    );
  }
  const max = Math.max(1, ...histogram.bins.map((b) => b.count));
  const width = 600;
  const height = 140;
  const binWidth = width / histogram.bins.length;
  const slaX = (histogram.slaMinutes / 33) * width;
  const p50X =
    histogram.p50Minutes !== null
      ? (Math.min(33, histogram.p50Minutes) / 33) * width
      : null;
  const p95X =
    histogram.p95Minutes !== null
      ? (Math.min(33, histogram.p95Minutes) / 33) * width
      : null;

  function colorFor(rangeMin: number): string {
    if (rangeMin < 10) return TOKENS.healthy;
    if (rangeMin < 18) return TOKENS.cautionLight;
    if (rangeMin < 28) return TOKENS.caution;
    return TOKENS.critical;
  }

  return (
    <SectionCard
      label="TAT distribution"
      description="Last 100 finalized · 3-minute bins · SLA dashed red"
    >
      <div className="relative" style={{ height }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
        >
          {histogram.bins.map((b, i) => {
            const h = (b.count / max) * (height - 20);
            const x = i * binWidth;
            return (
              <rect
                key={i}
                x={x + 1}
                y={height - h - 4}
                width={Math.max(0, binWidth - 2)}
                height={h}
                fill={colorFor(b.rangeMin)}
              />
            );
          })}
          {p50X !== null && (
            <line
              x1={p50X}
              y1={4}
              x2={p50X}
              y2={height - 4}
              stroke={TOKENS.info}
              strokeWidth={1}
              strokeDasharray="3,2"
            />
          )}
          {p95X !== null && (
            <line
              x1={p95X}
              y1={4}
              x2={p95X}
              y2={height - 4}
              stroke={TOKENS.info}
              strokeWidth={1}
              strokeDasharray="3,2"
            />
          )}
          <line
            x1={slaX}
            y1={4}
            x2={slaX}
            y2={height - 4}
            stroke={TOKENS.critical}
            strokeWidth={1}
            strokeDasharray="3,2"
          />
        </svg>
      </div>
      <div
        className="mt-2 flex items-center justify-between"
        style={{ color: TOKENS.textTertiary, fontSize: 11 }}
      >
        <span>0m</span>
        <span>15m</span>
        <span>30m+</span>
      </div>
      <div
        className="mt-2 border-t pt-2"
        style={{ borderColor: TOKENS.border, fontSize: 12, color: TOKENS.textSecondary }}
      >
        p50 {Math.round(histogram.p50Minutes ?? 0)}m · p95 {Math.round(histogram.p95Minutes ?? 0)}m ·{' '}
        SLA {histogram.slaMinutes}m
        {histogram.breachCount > 0 && (
          <span style={{ color: TOKENS.critical }}>
            {' '}
            · {histogram.breachCount} breached SLA{' '}
            <Link to="/diagnostics/pending?filter=overdue" style={{ color: TOKENS.info }}>
              open list ↗
            </Link>
          </span>
        )}
      </div>
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
                      {r.patientName}
                    </Link>
                    <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                      {r.branchCode} · {r.productName ?? '—'}
                    </div>
                  </td>
                  <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                    {r.stage}
                  </td>
                  <td className="py-2 text-right" style={{ color: ageColor }}>
                    {r.ageMinutes}m
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
                    {g.shiftStartIso && ` · since ${formatIstTime(g.shiftStartIso)}`}
                  </div>
                </span>
              </div>
              <div style={{ fontSize: 12, color: TOKENS.textSecondary }}>
                {g.waitingCount} waiting · {g.inProgressCount} in consultation
                {g.avgWaitMinutes !== null && ` · avg wait ${g.avgWaitMinutes}m`}
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
                      <span style={{ color: TOKENS.textPrimary }}>{p.patientName}</span>
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
                      {p.waitMinutes}m
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
                  {r.patientName}
                </td>
                <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                  {r.channel.toLowerCase()}
                </td>
                <td className="py-2" style={{ color: TOKENS.textSecondary }}>
                  {r.context}
                </td>
                <td className="py-2" style={{ color: TOKENS.critical }}>
                  {r.failureReason}
                </td>
                <td className="py-2">
                  <span style={{ color: TOKENS.info, fontSize: 12 }}>{r.action} ↗</span>
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
  const [branchValue, setBranchValue] = useState<string>('all');

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
                label="TAT median (today)"
                value={
                  data.kpis.tatMedianMinutes !== null
                    ? `${Math.round(data.kpis.tatMedianMinutes)}m`
                    : '—'
                }
                sub={
                  data.kpis.tatSampleCount >= 4
                    ? `${data.kpis.tatSampleCount} finalized`
                    : `${data.kpis.tatSampleCount}/4 samples · baseline forming`
                }
              />
              <KpiCard
                label="Reports finalized"
                value={`${data.kpis.finalizedToday}/${data.kpis.finalizableToday}`}
                sub="finalized / orderable today"
              />
              <KpiCard
                label="In queue right now"
                value={data.kpis.inQueue}
                sub="waiting + in progress"
              />
              <KpiCard
                label="Message delivery"
                value={
                  data.kpis.deliveryRatePercent !== null
                    ? `${data.kpis.deliveryRatePercent}%`
                    : '—'
                }
                sub={`${data.kpis.deliveryAttempted} attempted today`}
              />
            </div>

            <TatHistogramCard histogram={data.tatHistogram} />

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
