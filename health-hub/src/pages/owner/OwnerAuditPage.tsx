/**
 * Audit & Anomalies — dedicated owner/lab-incharge page (/ops/audit).
 *
 * Live feed wired to GET /api/owner/audit/events (keyset-paginated, date-time
 * range up to 1 year, branch / category / free-text filterable). Only the
 * current page is fetched — no full-table pulls. Styling is ported from the
 * approved prototype and scoped under `.ap` so its generic class names never
 * leak into the rest of the app.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { useBranchStore } from '@/store/branchStore';
import { useRevalidateOnFocus } from '@/hooks/useRevalidateOnFocus';
import { formatIstDateTime, formatIstTime } from './_shared/ownerUi';

type Severity = 'high' | 'medium' | 'low' | 'info';
type Category = 'money' | 'report' | 'drafts' | 'identity' | 'access' | 'destructive' | 'ops';

interface AuditEventRow {
  id: string;
  severity: Severity;
  category: Category;
  event: string;
  who: string | null;
  role: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  detail: string;
  amountInPaise: number | null;
  whenIso: string;
  drillTo: string | null;
  actionType: string;
}
interface AuditEventsResponse {
  items: AuditEventRow[];
  nextCursor: string | null;
  from: string;
  to: string;
  summary: {
    total: number;
    severity: Record<Severity, number>;
    category: Record<Category, number>;
    highlights: {
      deletions: number;
      payoutsPaid: number;
      billChanges: number;
      postFinalizeEdits: number;
      finalized: number;
      drafts: number;
      reportAccess: number;
      topActor: { name: string; count: number } | null;
    };
  };
}
interface AuditDetail extends AuditEventRow {
  ipAddress: string | null;
  userAgent: string | null;
  diff: Array<{ field: string; old: string | null; new: string | null }>;
  related: Array<{ id: string; severity: Severity; event: string; who: string | null; whenIso: string; isThis: boolean }>;
}

const SEV_ABBR: Record<Severity, string> = { high: 'hi', medium: 'me', low: 'lo', info: 'in' };
const SEVS: Array<{ key: Severity; label: string }> = [
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
  { key: 'info', label: 'Info' },
];
const CATEGORIES: Array<{ key: Category; label: string }> = [
  { key: 'money', label: 'Money & billing' },
  { key: 'report', label: 'Report integrity' },
  { key: 'drafts', label: 'Report drafts' },
  { key: 'identity', label: 'Identity & access' },
  { key: 'access', label: 'Access' },
  { key: 'destructive', label: 'Destructive' },
  { key: 'ops', label: 'Operational' },
];
const startOfToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const QUICK_RANGES: Array<{ label: string; from: () => Date }> = [
  { label: 'Today', from: startOfToday },
  { label: '7d', from: () => new Date(Date.now() - 7 * 864e5) },
  { label: '30d', from: () => new Date(Date.now() - 30 * 864e5) },
  { label: '90d', from: () => new Date(Date.now() - 90 * 864e5) },
  { label: '1 year', from: () => new Date(Date.now() - 365 * 864e5) },
];

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localToIso = (local: string): string | null => {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const CSS = `
.ap{--panel:#fff;--border:rgba(0,0,0,0.08);--border2:rgba(0,0,0,0.05);--ink:#1F1F1E;--ink2:#5F5E5A;--ink3:#888780;--link:#185FA5;
  --hi-t:#A32D2D;--hi-b:rgba(163,45,45,0.08);--hi-br:#A32D2D;--me-t:#854F0B;--me-b:rgba(133,79,11,0.08);--me-br:#B7793C;
  --lo-t:#5F5E5A;--lo-b:rgba(0,0,0,0.04);--lo-br:#B8B6AE;--in-t:#185FA5;--in-b:rgba(24,95,165,0.08);--in-br:#4E8FC7;--ok:#0F6E56;
  --accent:#185FA5;--accent-b:rgba(24,95,165,0.08);--accent-br:rgba(24,95,165,0.28);
  --shadow:0 1px 2px rgba(16,24,40,.03),0 1px 2px rgba(16,24,40,.05);--shadow-lg:0 10px 40px rgba(16,24,40,.16);
  color:var(--ink);font-size:13px;line-height:1.45}
.ap *{box-sizing:border-box}
.ap .top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px;flex-wrap:wrap}
.ap .title h1{font-size:20px;margin:0;font-weight:550;letter-spacing:-.01em}
.ap .title .sub{color:var(--ink3);font-size:12px;margin-top:2px}
.ap .ctrls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ap .sel,.ap .btn,.ap .dt,.ap .search{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:6px 11px;
  font-size:12px;color:var(--ink);cursor:pointer;display:inline-flex;gap:7px;align-items:center;box-shadow:var(--shadow);font-family:inherit}
.ap .search{cursor:text;min-width:210px}
.ap .search:focus,.ap .dt:focus{outline:none;border-color:var(--accent)}
.ap .btn:hover,.ap .sel:hover{border-color:#cdd2da}
.ap .perfnote{display:inline-flex;align-items:center;gap:6px;font-size:11px;background:rgba(15,110,86,0.08);border:1px solid rgba(15,110,86,0.22);color:#0F6E56;border-radius:999px;padding:3px 10px}
.ap .qr{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:-4px 0 14px}
.ap .qr .rng{background:#fff;border:1px solid var(--border);border-radius:999px;padding:3px 11px;font-size:11.5px;color:var(--ink2);cursor:pointer}
.ap .qr .rng:hover{border-color:#cbd5e1;color:var(--ink)}
.ap .kpis{display:grid;grid-template-columns:1.5fr 1fr 1.1fr;gap:12px;margin-bottom:14px}
.ap .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
.ap .kpi{padding:12px 14px}
.ap .kpi .lbl{font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;font-weight:600}
.ap .sevrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ap .chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:600;border:1px solid transparent;cursor:pointer;user-select:none}
.ap .chip .n{font-variant-numeric:tabular-nums}
.ap .chip.hi{background:var(--hi-b);color:var(--hi-t);border-color:#f7d3d3}
.ap .chip.me{background:var(--me-b);color:var(--me-t);border-color:#f5e2b8}
.ap .chip.lo{background:var(--lo-b);color:var(--lo-t);border-color:#dbe1ea}
.ap .chip.in{background:var(--in-b);color:var(--in-t);border-color:#cfe0fd}
.ap .chip.off{opacity:.4}
.ap .kpi hr{border:0;border-top:1px solid var(--border2);margin:9px 0}
.ap .kpi .sm{font-size:12px;color:var(--ink2)}
.ap .kpi .big{font-size:19px;font-weight:650;font-variant-numeric:tabular-nums}
.ap .tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin:2px 2px 14px}
.ap .tabs button{border:0;background:transparent;padding:9px 14px;font-size:13px;color:var(--ink2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;font-weight:520}
.ap .tabs button.on{color:var(--ink);border-bottom-color:#1F1F1E;font-weight:620}
.ap .tabs .cnt{font-size:11px;color:var(--ink3);margin-left:5px}
.ap .body{display:grid;grid-template-columns:212px 1fr;gap:14px;align-items:start}
.ap .rail{padding:12px}
.ap .rail h4{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);margin:14px 0 7px;font-weight:650}
.ap .rail h4:first-child{margin-top:2px}
.ap .facet{display:flex;align-items:center;justify-content:space-between;padding:5px 7px;border-radius:7px;cursor:pointer;font-size:12.5px}
.ap .facet:hover{background:#f5f6f8}
.ap .facet.on{background:var(--accent-b);color:var(--accent);font-weight:560}
.ap .facet .l{display:flex;align-items:center;gap:8px}
.ap .facet .sw{width:9px;height:9px;border-radius:3px;display:inline-block}
.ap .facet .c{color:var(--ink3);font-variant-numeric:tabular-nums}
.ap .clearall{margin-top:12px;width:100%;text-align:center;padding:6px;font-size:12px;color:var(--ink2);border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer}
.ap .active-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:11px 14px 0}
.ap .active-chips .ac{background:var(--accent-b);color:var(--accent);border:1px solid var(--accent-br);border-radius:999px;padding:3px 9px;font-size:11.5px;cursor:pointer}
.ap .tbl{overflow:hidden}
.ap .thead,.ap .trow{display:grid;grid-template-columns:66px 96px 1.4fr 130px 150px 88px;gap:10px;align-items:center}
.ap .thead{padding:9px 14px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);border-bottom:1px solid var(--border);font-weight:650;background:#fbfbfc}
.ap .trow{padding:10px 14px;border-bottom:1px solid var(--border2);cursor:pointer;border-left:3px solid transparent}
.ap .trow:hover{background:#fafbfd}
.ap .trow.hi{border-left-color:var(--hi-br)} .ap .trow.me{border-left-color:var(--me-br)}
.ap .trow.lo{border-left-color:var(--lo-br)} .ap .trow.in{border-left-color:var(--in-br)}
.ap .sev{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;letter-spacing:.03em;text-align:center;display:inline-block}
.ap .sev.hi{background:var(--hi-b);color:var(--hi-t)} .ap .sev.me{background:var(--me-b);color:var(--me-t)}
.ap .sev.lo{background:var(--lo-b);color:var(--lo-t)} .ap .sev.in{background:var(--in-b);color:var(--in-t)}
.ap .cat{font-size:11.5px;color:var(--ink2);font-weight:550;text-transform:capitalize}
.ap .ev{font-weight:560;color:var(--ink)}
.ap .ev .sub{color:var(--ink3);font-size:11px;font-weight:400}
.ap .who .nm{font-weight:550} .ap .who .rl{color:var(--ink3);font-size:11px}
.ap .ent{color:var(--ink2);font-size:12px}
.ap .ent .id{color:var(--ink3)}
.ap .time{text-align:right;color:var(--ink3);font-size:12px;font-variant-numeric:tabular-nums}
.ap .empty{padding:34px 14px;text-align:center;color:var(--ink3)}
.ap .pager{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 14px;border-top:1px solid var(--border2);color:var(--ink2);font-size:12px}
.ap .pgbtn{background:#fff;border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.ap .pgbtn:disabled{opacity:.45;cursor:not-allowed}
.ap .note-b{font-size:11.5px;color:var(--ink3);padding:12px 2px 0}
.ap .backdrop{position:fixed;inset:0;background:rgba(15,23,42,.28);opacity:0;pointer-events:none;transition:opacity .18s;z-index:40}
.ap .backdrop.on{opacity:1;pointer-events:auto}
.ap .drawer{position:fixed;top:0;right:0;height:100vh;width:440px;max-width:94vw;background:#fff;box-shadow:var(--shadow-lg);
  transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1);z-index:50;display:flex;flex-direction:column}
.ap .drawer.on{transform:translateX(0)}
.ap .dr-head{padding:16px 18px;border-bottom:1px solid var(--border)}
.ap .dr-head .x{float:right;cursor:pointer;color:var(--ink3);font-size:18px;line-height:1;border:0;background:0}
.ap .dr-sev{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:650;text-transform:capitalize}
.ap .dr-title{font-size:15px;font-weight:620;margin:8px 0 4px}
.ap .dr-ent{font-size:12px;color:var(--ink2)}
.ap .dr-body{overflow:auto;padding:4px 18px 24px}
.ap .sec{padding:14px 0;border-bottom:1px solid var(--border2)}
.ap .sec h5{margin:0 0 9px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);font-weight:650}
.ap .kv{display:grid;grid-template-columns:82px 1fr;gap:5px 10px;font-size:12.5px}
.ap .kv .k{color:var(--ink3)} .ap .kv .v{color:var(--ink)}
.ap .triage-btns{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0}
.ap .tb{border:1px solid var(--border);background:#fff;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;font-weight:550}
.ap .tb.pri{background:#1F1F1E;color:#fff;border-color:#1F1F1E}
@media(max-width:900px){.ap .body{grid-template-columns:1fr}.ap .kpis{grid-template-columns:1fr}
  .ap .thead{display:none}.ap .trow{grid-template-columns:1fr auto}.ap .trow .cat{display:none}.ap .drawer{width:100vw}}
`;

const TABS = [
  { key: 'feed', label: 'Live feed' },
  { key: 'score', label: 'Staff scorecard' },
  { key: 'review', label: 'Anomaly review' },
  { key: 'access', label: 'Access & disclosure' },
];

export default function OwnerAuditPage() {
  const navigate = useNavigate();
  const branches = useBranchStore((s) => s.branches);
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';
  const setBranchValue = (v: string) =>
    setSearchParams((prev) => {
      prev.set('branch', v);
      return prev;
    });

  const [tab, setTab] = useState('feed');
  // Default to TODAY (start of the calendar day → now).
  const [fromLocal, setFromLocal] = useState(() => toLocalInput(startOfToday()));
  const [toLocal, setToLocal] = useState(() => toLocalInput(new Date()));
  const applyQuickRange = (from: () => Date) => {
    setFromLocal(toLocalInput(from()));
    setToLocal(toLocalInput(new Date()));
  };

  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [cats, setCats] = useState<Set<Category>>(new Set());
  const toggleCat = (key: Category) =>
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const catList = useMemo(() => Array.from(cats).sort().join(','), [cats]);

  // Severity is a stored column on AnomalyEvent → filtered server-side. Default
  // to High+Medium so the feed shows what needs attention, not the flood of
  // routine Low/Info (uploads, views, creates). The rail shows all counts; click
  // Low / Info to include them.
  const [sevSel, setSevSel] = useState<Set<Severity>>(new Set<Severity>(['high', 'medium']));
  const toggleSev = (key: Severity) =>
    setSevSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const sevList = useMemo(() => Array.from(sevSel).sort().join(','), [sevSel]);

  const fromIso = localToIso(fromLocal);
  const toIso = localToIso(toLocal);

  const [cursor, setCursor] = useState<string | null>(null);
  const [stack, setStack] = useState<string[]>([]);
  const filterKey = `${branchValue}|${q}|${fromIso}|${toIso}|${catList}|${sevList}`;
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
      if (sevList) p.set('severity', sevList);
      if (cursor) p.set('cursor', cursor);
      p.set('limit', '50');
      return apiRequest<AuditEventsResponse>(`${API_BASE}/owner/audit/events?${p.toString()}`);
    },
    refetchInterval: 60 * 1000,
    staleTime: 45 * 1000,
    refetchOnWindowFocus: false,
  });
  useRevalidateOnFocus(() => query.refetch(), { enabled: true });

  const data = query.data;
  const summary = data?.summary;
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
    const prev = copy.pop() ?? '';
    setStack(copy);
    setCursor(prev || null);
  };

  const [openRow, setOpenRow] = useState<AuditEventRow | null>(null);
  const detailQuery = useQuery<AuditDetail>({
    queryKey: ['owner-audit-detail', openRow?.id, branchValue],
    enabled: !!openRow,
    queryFn: () =>
      apiRequest<AuditDetail>(
        `${API_BASE}/owner/audit/events/${openRow!.id}?branch=${encodeURIComponent(branchValue)}`,
      ),
    staleTime: 60 * 1000,
  });
  const detail = detailQuery.data;
  const clearAll = () => {
    setCats(new Set());
    setSevSel(new Set<Severity>(['high', 'medium']));
    setSearchInput('');
  };

  return (
    <AppLayout context="owner" hideContextBanner>
      <style>{CSS}</style>
      <div className="ap mx-auto" style={{ maxWidth: 1320, padding: '4px 2px 40px' }}>
        {/* header */}
        <div className="top">
          <div className="title">
            <h1>Audit &amp; Anomalies</h1>
            <div className="sub">
              {data
                ? `${formatIstDateTime(data.from)} → ${formatIstDateTime(data.to)} · ${summary?.total ?? 0} events in window · live`
                : 'Loading…'}
            </div>
          </div>
          <div className="ctrls">
            <input
              className="search"
              placeholder="Search entity / id…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <select className="sel" value={branchValue} onChange={(e) => setBranchValue(e.target.value)}>
              <option value="all">All branches</option>
              {branches.filter((b) => b.isActive).map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
              ))}
            </select>
            <input className="dt" type="datetime-local" value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} />
            <span className="faint" style={{ color: '#888780' }}>→</span>
            <input className="dt" type="datetime-local" value={toLocal} onChange={(e) => setToLocal(e.target.value)} />
            <button className="btn" onClick={() => query.refetch()}>{query.isFetching ? '⟳…' : '⟳'}</button>
          </div>
        </div>

        <div className="qr">
          <span className="perfnote">⚡ Loads only the visible page · cursor-paginated · up to 1 year</span>
          <span className="faint" style={{ fontSize: 11, color: '#888780' }}>Quick range:</span>
          {QUICK_RANGES.map((r) => (
            <span key={r.label} className="rng" onClick={() => applyQuickRange(r.from)}>{r.label}</span>
          ))}
        </div>

        {/* KPI strip — action-oriented: what should I check, is money moving,
            who's most active. */}
        <div className="kpis">
          {(() => {
            const h = summary?.highlights;
            const flagged = (h?.deletions ?? 0) + (h?.postFinalizeEdits ?? 0) + (h?.payoutsPaid ?? 0);
            return (
              <>
                {/* Card 1 — Needs review (act-on-now) + severity filter chips */}
                <div className="card kpi">
                  <div className="lbl">Needs review</div>
                  <div className="sevrow">
                    {SEVS.map((s) => {
                      const ab = SEV_ABBR[s.key];
                      const on = !sevSel.size || sevSel.has(s.key);
                      return (
                        <span key={s.key} className={`chip ${ab} ${on ? '' : 'off'}`} onClick={() => toggleSev(s.key)}>
                          {s.label} <span className="n">{summary?.severity[s.key] ?? 0}</span>
                        </span>
                      );
                    })}
                  </div>
                  <hr />
                  {flagged === 0 ? (
                    <div className="sm" style={{ color: '#0F6E56' }}>✓ Nothing flagged in this window.</div>
                  ) : (
                    <div className="sm">
                      <b style={{ color: '#A32D2D' }}>{h?.deletions ?? 0}</b> deletions ·{' '}
                      <b style={{ color: '#A32D2D' }}>{h?.postFinalizeEdits ?? 0}</b> edits after finalize ·{' '}
                      <b>{h?.payoutsPaid ?? 0}</b> payouts paid
                    </div>
                  )}
                </div>

                {/* Card 2 — Money & payouts */}
                <div className="card kpi">
                  <div className="lbl">Money &amp; payouts</div>
                  <div className="big">{h?.billChanges ?? 0}</div>
                  <div className="sm">bill changes — discounts / refunds / edits</div>
                  <hr />
                  <div className="sm">
                    {h?.payoutsPaid ?? 0} payouts paid · {h?.deletions ?? 0} deletions{' '}
                    <span className="faint" style={{ color: '#888780' }}>(₹ amounts land with the money slice)</span>
                  </div>
                </div>

                {/* Card 3 — Activity & throughput */}
                <div className="card kpi">
                  <div className="lbl">Activity today</div>
                  <div className="big">{h?.topActor?.name ?? '—'}</div>
                  <div className="sm">busiest actor{h?.topActor ? ` · ${h.topActor.count} actions` : ''}</div>
                  <hr />
                  <div className="sm">
                    {h?.finalized ?? 0} finalized · {h?.drafts ?? 0} drafts in progress · {h?.reportAccess ?? 0} report views
                  </div>
                </div>
              </>
            );
          })()}
        </div>

        {/* tabs */}
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'feed' && <span className="cnt">{summary?.total ?? 0}</span>}
            </button>
          ))}
        </div>

        {tab !== 'feed' ? (
          <div className="card" style={{ padding: 28, color: '#888780', fontSize: 13 }}>
            {TABS.find((t) => t.key === tab)?.label} — arrives in a later slice.
          </div>
        ) : (
          <div className="body">
            {/* filter rail */}
            <div className="card rail">
              <h4>Severity</h4>
              {SEVS.map((s) => (
                <div key={s.key} className={`facet ${sevSel.has(s.key) ? 'on' : ''}`} onClick={() => toggleSev(s.key)}>
                  <span className="l">
                    <span className="sw" style={{ background: `var(--${SEV_ABBR[s.key]}-br)` }} />
                    {s.label}
                  </span>
                  <span className="c">{summary?.severity[s.key] ?? 0}</span>
                </div>
              ))}
              <h4>Category</h4>
              {CATEGORIES.map((c) => (
                <div key={c.key} className={`facet ${cats.has(c.key) ? 'on' : ''}`} onClick={() => toggleCat(c.key)}>
                  <span className="l">{c.label}</span>
                  <span className="c">{summary?.category[c.key] ?? 0}</span>
                </div>
              ))}
              <button className="clearall" onClick={clearAll}>Clear all filters</button>
            </div>

            {/* table */}
            <div className="card tbl">
              {(cats.size > 0 || sevSel.size > 0 || q) && (
                <div className="active-chips">
                  <span className="faint" style={{ fontSize: 11.5, color: '#888780' }}>Filters:</span>
                  {Array.from(sevSel).map((s) => (
                    <span key={s} className="ac" onClick={() => toggleSev(s)}>{s} ✕</span>
                  ))}
                  {Array.from(cats).map((c) => (
                    <span key={c} className="ac" onClick={() => toggleCat(c)}>{c} ✕</span>
                  ))}
                  {q && <span className="ac" onClick={() => setSearchInput('')}>“{q}” ✕</span>}
                </div>
              )}
              <div className="thead">
                <div>Sev</div><div>Category</div><div>Event</div><div>Who</div><div>Entity</div><div>Time</div>
              </div>

              {query.isLoading && <div className="empty">Loading…</div>}
              {query.isError && <div className="empty">Failed to load. <span style={{ color: '#2563eb', cursor: 'pointer' }} onClick={() => query.refetch()}>Retry</span></div>}
              {data && items.length === 0 && (
                <div className="empty">Nothing in this window. Widen the date range or clear filters.</div>
              )}

              {data && items.map((r) => {
                const ab = SEV_ABBR[r.severity];
                return (
                  <div key={r.id} className={`trow ${ab}`} onClick={() => setOpenRow(r)}>
                    <div><span className={`sev ${ab}`}>{r.severity === 'medium' ? 'MED' : r.severity.toUpperCase()}</span></div>
                    <div className="cat">{r.category}</div>
                    <div className="ev">
                      {r.event}
                      {r.detail && r.detail !== r.event && <div className="sub">{r.detail}</div>}
                    </div>
                    <div className="who">
                      <span className="nm">{r.who ?? 'system'}</span>
                      {r.role && <span className="rl"> · {r.role}</span>}
                    </div>
                    <div className="ent">{r.entityType} <span className="id">{r.entityLabel ?? `#${r.entityId.slice(0, 8)}`}</span></div>
                    <div className="time">{formatIstTime(r.whenIso)}</div>
                  </div>
                );
              })}

              <div className="pager">
                <span className="faint" style={{ color: '#888780' }}>
                  Page {pageNum} · 50 / page · keyset cursor · only this page is fetched
                </span>
                <span style={{ display: 'flex', gap: 10 }}>
                  <button className="pgbtn" onClick={goPrev} disabled={!stack.length || query.isFetching}>‹ Prev</button>
                  <button className="pgbtn" onClick={goNext} disabled={!data?.nextCursor || query.isFetching}>Next ›</button>
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="note-b">
          Reads the materialized AnomalyEvent model — severity / category / search / date-range all filter server-side,
          keyset-paginated over up to 1 year, only the current page fetched. Discounts &amp; refunds show ₹ amount + reason.
          Staff scorecard &amp; Access tabs and triage arrive next.
        </div>
      </div>

      {/* detail drawer */}
      <div className={`ap`}>
        <div className={`backdrop ${openRow ? 'on' : ''}`} onClick={() => setOpenRow(null)} />
        <aside className={`drawer ${openRow ? 'on' : ''}`}>
          {openRow && (
            <>
              <div className="dr-head">
                <button className="x" onClick={() => setOpenRow(null)}>✕</button>
                <div className="dr-sev">
                  <span className={`sev ${SEV_ABBR[openRow.severity]}`}>{openRow.severity}</span> · {openRow.category}
                </div>
                <div className="dr-title">{openRow.event}</div>
                <div className="dr-ent">{openRow.entityType} {openRow.entityLabel ?? `#${openRow.entityId.slice(0, 12)}`}</div>
              </div>
              <div className="dr-body">
                <div className="sec">
                  <h5>Summary</h5>
                  <div className="kv">
                    <div className="k">Actor</div><div className="v">{openRow.who ?? 'system'}{openRow.role ? ` (${openRow.role})` : ''}</div>
                    <div className="k">When</div><div className="v">{formatIstDateTime(openRow.whenIso)}</div>
                    <div className="k">Action</div><div className="v">{openRow.actionType}</div>
                    <div className="k">Entity</div><div className="v">{openRow.entityType} {openRow.entityLabel ?? `#${openRow.entityId.slice(0, 12)}`}</div>
                    {openRow.detail && openRow.detail !== openRow.event && (
                      <><div className="k">Detail</div><div className="v">{openRow.detail}</div></>
                    )}
                    {detail?.ipAddress && (<><div className="k">IP</div><div className="v">{detail.ipAddress}</div></>)}
                  </div>
                </div>
                <div className="sec">
                  <h5>Before → After</h5>
                  {detailQuery.isLoading && <div className="sm" style={{ color: '#888780' }}>Loading…</div>}
                  {detail && detail.diff.length === 0 && (
                    <div className="sm" style={{ color: '#888780' }}>No recorded field changes for this event.</div>
                  )}
                  {detail && detail.diff.map((d) => (
                    <div key={d.field} style={{ marginBottom: 8 }}>
                      <div style={{ color: '#888780', fontSize: 11, marginBottom: 2 }}>{d.field}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <span style={{ background: '#fef2f2', color: '#A32D2D', borderRadius: 5, padding: '2px 7px', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.old ?? '—'}</span>
                        <span style={{ color: '#888780' }}>→</span>
                        <span style={{ background: 'rgba(15,110,86,0.08)', color: '#0F6E56', borderRadius: 5, padding: '2px 7px', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.new ?? '—'}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {detail && detail.related.length > 0 && (
                  <div className="sec">
                    <h5>Related events (same entity)</h5>
                    {detail.related.map((r) => (
                      <div key={r.id} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '3px 0', color: r.isThis ? '#A32D2D' : '#475569', fontWeight: r.isThis ? 600 : 400 }}>
                        <span style={{ color: '#888780', width: 96, flex: 'none' }}>{formatIstDateTime(r.whenIso).split(' · ')[1] ?? ''}</span>
                        <span>{r.event}{r.isThis ? ' (this)' : ''}</span>
                        <span style={{ marginLeft: 'auto', color: '#888780' }}>{r.who ?? 'system'}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="sec" style={{ border: 0 }}>
                  <h5>Triage</h5>
                  <div className="triage-btns">
                    <button className="tb pri" disabled>Acknowledge</button>
                    <button className="tb" disabled>Resolve</button>
                    {openRow.drillTo && (
                      <button className="tb" onClick={() => navigate(openRow.drillTo!)}>Open record ▸</button>
                    )}
                  </div>
                  <div className="sm" style={{ color: '#888780', fontSize: 11, marginTop: 6 }}>
                    Acknowledge / resolve wiring lands with the triage-state slice.
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </AppLayout>
  );
}
