/**
 * Audit & Anomalies — dedicated owner/lab-incharge page (/ops/audit).
 *
 * Slice 2: the Live feed, wired to GET /api/owner/audit/events (keyset-paginated,
 * date-time range up to 1 year, branch / category / free-text filterable). Only
 * the current page is fetched — no full-table pulls (the pending-results / OOM
 * discipline). Severity is shown per row; a true severity facet + the detail
 * drawer + scorecard / access tabs land in later slices.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { useRevalidateOnFocus } from '@/hooks/useRevalidateOnFocus';
import {
  TOKENS,
  OwnerPageHeader,
  BranchFilter,
  RefreshButton,
  ErrorCard,
  FullPageSkeleton,
  formatIstTime,
  formatIstDateTime,
} from './_shared/ownerUi';

type Severity = 'high' | 'medium' | 'low' | 'info';

interface AuditEventRow {
  id: string;
  severity: Severity;
  category: string;
  event: string;
  who: string | null;
  role: string | null;
  entityType: string;
  entityId: string;
  detail: string;
  whenIso: string;
  drillTo: string | null;
  actionType: string;
}

interface AuditEventsResponse {
  items: AuditEventRow[];
  nextCursor: string | null;
  from: string;
  to: string;
}

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'money', label: 'Money' },
  { key: 'report', label: 'Report' },
  { key: 'identity', label: 'Identity' },
  { key: 'access', label: 'Access' },
  { key: 'destructive', label: 'Destructive' },
  { key: 'ops', label: 'Operational' },
];

const QUICK_RANGES: Array<{ key: string; label: string; ms: number }> = [
  { key: '1d', label: 'Today', ms: 1 * 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: '90d', label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
  { key: '1y', label: '1 year', ms: 365 * 24 * 60 * 60 * 1000 },
];

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localToIso = (local: string): string | null => {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function SevBadge({ severity }: { severity: Severity }) {
  const c =
    severity === 'high'
      ? TOKENS.critical
      : severity === 'medium'
        ? TOKENS.caution
        : severity === 'info'
          ? TOKENS.info
          : TOKENS.textTertiary;
  return (
    <span
      style={{
        background: `${c}1A`,
        color: c,
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 3,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        fontWeight: 600,
      }}
    >
      {severity}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  background: TOKENS.surface,
  color: TOKENS.textPrimary,
  fontSize: 12,
  padding: '6px 10px',
};

export default function OwnerAuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';
  const setBranchValue = (newBranch: string) =>
    setSearchParams((prev) => {
      prev.set('branch', newBranch);
      return prev;
    });

  // Date-time window (defaults to the last 7 days; queryable up to 1 year).
  const [fromLocal, setFromLocal] = useState(() =>
    toLocalInput(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  );
  const [toLocal, setToLocal] = useState(() => toLocalInput(new Date()));
  const applyQuickRange = (ms: number) => {
    const now = new Date();
    setFromLocal(toLocalInput(new Date(now.getTime() - ms)));
    setToLocal(toLocalInput(now));
  };

  // Free-text search, debounced so we don't refetch on every keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [cats, setCats] = useState<Set<string>>(new Set());
  const toggleCat = (key: string) =>
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const catList = useMemo(() => Array.from(cats).sort().join(','), [cats]);

  const fromIso = localToIso(fromLocal);
  const toIso = localToIso(toLocal);

  // Keyset cursor pagination — a stack of the cursors we've walked so "prev"
  // returns to the exact previous page. Any filter change resets to page 1.
  const [cursor, setCursor] = useState<string | null>(null);
  const [stack, setStack] = useState<string[]>([]);
  const filterKey = `${branchValue}|${q}|${fromIso}|${toIso}|${catList}`;
  useEffect(() => {
    setCursor(null);
    setStack([]);
  }, [filterKey]);

  const query = useQuery<AuditEventsResponse>({
    queryKey: ['owner-audit', filterKey, cursor],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('branch', branchValue);
      if (q) p.set('q', q);
      if (fromIso) p.set('from', fromIso);
      if (toIso) p.set('to', toIso);
      if (catList) p.set('category', catList);
      if (cursor) p.set('cursor', cursor);
      p.set('limit', '50');
      return apiRequest<AuditEventsResponse>(`${API_BASE}/owner/audit/events?${p.toString()}`);
    },
    refetchInterval: 30 * 1000,
    staleTime: 15 * 1000,
  });
  useRevalidateOnFocus(() => query.refetch(), { enabled: true });

  const data = query.data;
  const items = data?.items ?? [];
  const pageNum = stack.length + 1;

  const goNext = () => {
    if (!data?.nextCursor) return;
    setStack((prev) => [...prev, cursor ?? '']);
    setCursor(data.nextCursor);
  };
  const goPrev = () => {
    if (!stack.length) return;
    const copy = [...stack];
    const prevCursor = copy.pop() ?? '';
    setStack(copy);
    setCursor(prevCursor || null);
  };

  return (
    <AppLayout context="owner" hideContextBanner>
      <div className="mx-auto" style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}>
        <OwnerPageHeader
          title="Audit & Anomalies"
          subtitle={
            data
              ? `${formatIstDateTime(data.from)} → ${formatIstDateTime(data.to)} · loads only the current page · live`
              : 'Loading…'
          }
          rightSlot={
            <>
              <BranchFilter value={branchValue} onChange={setBranchValue} />
              <RefreshButton isFetching={query.isFetching} onClick={() => query.refetch()} />
            </>
          }
        />

        {/* Controls: search · date-time range · quick ranges · category */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search entity / id…"
            style={{ ...inputStyle, minWidth: 200 }}
          />
          <input type="datetime-local" value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} style={inputStyle} />
          <span style={{ color: TOKENS.textTertiary, fontSize: 12 }}>→</span>
          <input type="datetime-local" value={toLocal} onChange={(e) => setToLocal(e.target.value)} style={inputStyle} />
          <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>up to 1 year:</span>
          {QUICK_RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => applyQuickRange(r.ms)}
              style={{ ...inputStyle, cursor: 'pointer', color: TOKENS.textSecondary }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Category:</span>
          {CATEGORIES.map((c) => {
            const on = cats.has(c.key);
            return (
              <button
                key={c.key}
                onClick={() => toggleCat(c.key)}
                style={{
                  ...inputStyle,
                  cursor: 'pointer',
                  background: on ? '#EEF2FF' : TOKENS.surface,
                  color: on ? '#3730A3' : TOKENS.textSecondary,
                  borderColor: on ? '#C7D2FE' : TOKENS.border,
                }}
              >
                {c.label}
              </button>
            );
          })}
          {cats.size > 0 && (
            <button
              onClick={() => setCats(new Set())}
              style={{ background: 'transparent', border: 0, color: TOKENS.info, fontSize: 12, cursor: 'pointer' }}
            >
              Clear
            </button>
          )}
        </div>

        {query.isLoading && <FullPageSkeleton rows={3} />}
        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div
            style={{
              background: TOKENS.surface,
              border: `0.5px solid ${TOKENS.border}`,
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: TOKENS.textTertiary, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ textAlign: 'left', padding: '10px 14px' }}>Severity</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px' }}>Category</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px' }}>Event</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px' }}>Who</th>
                  <th style={{ textAlign: 'left', padding: '10px 14px' }}>Entity</th>
                  <th style={{ textAlign: 'right', padding: '10px 14px' }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: '28px 14px', textAlign: 'center', color: TOKENS.textTertiary }}>
                      Nothing in this window. Widen the date range or clear filters.
                    </td>
                  </tr>
                )}
                {items.map((r) => (
                  <tr key={r.id} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                    <td style={{ padding: '10px 14px' }}>
                      <SevBadge severity={r.severity} />
                    </td>
                    <td style={{ padding: '10px 14px', color: TOKENS.textSecondary, textTransform: 'capitalize' }}>{r.category}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>
                      {r.drillTo ? (
                        <Link to={r.drillTo} style={{ color: TOKENS.info }}>
                          {r.event}
                        </Link>
                      ) : (
                        r.event
                      )}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {r.who ?? <span style={{ color: TOKENS.textTertiary }}>system</span>}
                      {r.role && <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {r.role}</span>}
                    </td>
                    <td style={{ padding: '10px 14px', color: TOKENS.textSecondary, fontSize: 12 }}>
                      {r.entityType} <span style={{ color: TOKENS.textTertiary }}>#{r.entityId.slice(0, 8)}</span>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: TOKENS.textTertiary, fontSize: 12 }}>
                      {formatIstTime(r.whenIso)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div
              className="flex items-center justify-between"
              style={{ padding: '10px 14px', borderTop: `0.5px solid ${TOKENS.border}`, fontSize: 12, color: TOKENS.textSecondary }}
            >
              <span style={{ color: TOKENS.textTertiary }}>
                Page {pageNum} · 50 / page · keyset cursor · only this page is fetched
              </span>
              <span className="flex items-center gap-3">
                <button
                  onClick={goPrev}
                  disabled={!stack.length || query.isFetching}
                  style={{ ...inputStyle, cursor: stack.length ? 'pointer' : 'not-allowed', opacity: stack.length ? 1 : 0.5 }}
                >
                  ‹ Prev
                </button>
                <button
                  onClick={goNext}
                  disabled={!data.nextCursor || query.isFetching}
                  style={{ ...inputStyle, cursor: data.nextCursor ? 'pointer' : 'not-allowed', opacity: data.nextCursor ? 1 : 0.5 }}
                >
                  Next ›
                </button>
              </span>
            </div>
          </div>
        )}

        <div style={{ color: TOKENS.textTertiary, fontSize: 11, padding: '10px 2px' }}>
          Slice 2 · Live feed. Reads only the fields shown for the current page (no full-table scans). Derived rows
          (discounts, identity edits, films-only, draft authorship), the detail drawer, and the Scorecard / Access
          tabs arrive in later slices.
        </div>
      </div>
    </AppLayout>
  );
}
