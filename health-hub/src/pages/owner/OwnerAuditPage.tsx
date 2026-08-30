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
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  status: 'new' | 'ack' | 'resolved';
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
      mistakesActor: { name: string; count: number } | null;
    };
    triage: { new: number; ack: number; resolved: number; open: number };
  };
}
interface AuditDetail extends AuditEventRow {
  ipAddress: string | null;
  userAgent: string | null;
  diff: Array<{ field: string; old: string | null; new: string | null }>;
  reportValues: Array<{ name: string; value: string; flag: string | null; who: string | null }>;
  related: Array<{ id: string; severity: Severity; event: string; who: string | null; whenIso: string; isThis: boolean }>;
}
interface ScorecardActor {
  userId: string;
  name: string;
  role: string | null;
  billed: number;
  slips: number;
  accuracy: number; // percent, -1 = no bills to rate
  byType: Record<string, number>;
  identityBreak: Record<string, number>;
}
interface ScorecardResponse {
  from: string;
  to: string;
  scored: Array<{ key: string; label: string }>;
  info: Array<{ key: string; label: string }>;
  actors: ScorecardActor[];
  noWindowBills: ScorecardActor[];
  labIncharge: ScorecardActor[];
}
interface AccessResponse {
  items: Array<{ id: string; accessType: string; accessedVia: string; who: string | null; patient: string | null; ipAddress: string | null; whenIso: string }>;
  nextCursor: string | null;
  from: string;
  to: string;
  counts: { view: number; download: number; print: number };
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
// Staff-scorecard period toggles. `from: null` = all time (no lower bound).
const SCORE_PERIODS: Array<{ key: string; label: string; from: (() => Date) | null }> = [
  { key: 'daily', label: 'Daily', from: startOfToday },
  { key: 'weekly', label: 'Weekly', from: () => new Date(Date.now() - 7 * 864e5) },
  { key: 'monthly', label: 'Monthly', from: () => new Date(Date.now() - 30 * 864e5) },
  { key: 'yearly', label: 'Yearly', from: () => new Date(Date.now() - 365 * 864e5) },
  { key: 'all', label: 'All time', from: null },
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
.ap .searchbar{position:relative;margin:2px 0 14px}
.ap .searchbig{width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 40px;font-size:14px;color:var(--ink);box-shadow:var(--shadow);font-family:inherit;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888780' stroke-width='2.2'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:15px center}
.ap .searchbig::placeholder{color:var(--ink3)}
.ap .searchbig:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-b)}
.ap .searchclear{position:absolute;right:13px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:var(--ink3);cursor:pointer;font-size:14px;line-height:1}
.ap .search:focus,.ap .dt:focus{outline:none;border-color:var(--accent)}
.ap .btn:hover,.ap .sel:hover{border-color:#cdd2da}
.ap .perfnote{font-size:11px;color:var(--ink3)}
.ap .qfilters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 2px 14px}
.ap .qfilters .flabel{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);font-weight:650;margin-right:2px}
.ap .qfilters .fdiv{width:1px;height:16px;background:var(--border);margin:0 4px}
.ap .qchip{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:3px 9px;font-size:11.5px;color:var(--ink2);cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px}
.ap .qchip:hover{border-color:var(--ink3);color:var(--ink)}
.ap .qchip.on{background:rgba(0,0,0,0.05);border-color:var(--ink3);color:var(--ink);font-weight:600}
.ap .qchip .sw{width:8px;height:8px;border-radius:2px;display:inline-block}
.ap .qfilters .fclear{font-size:11px;color:var(--accent);cursor:pointer;background:none;border:0;padding:2px 4px;font-family:inherit}
.ap .qr{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:-4px 0 14px}
.ap .qr .rng{background:transparent;border:0;padding:2px 4px;font-size:11.5px;color:var(--ink2);cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--border)}
.ap .qr .rng:hover{color:var(--ink)}
.ap .kpis{display:grid;grid-template-columns:1.5fr 1fr 1.1fr;gap:12px;margin-bottom:14px}
.ap .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow)}
.ap .kpi{padding:12px 14px}
.ap .kpi .lbl{font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;font-weight:600}
.ap .sevrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ap .chip{display:inline-flex;align-items:center;gap:6px;border-radius:4px;padding:3px 9px;font-size:12px;font-weight:550;border:1px solid transparent;cursor:pointer;user-select:none}
.ap .chip .n{font-variant-numeric:tabular-nums}
.ap .chip.hi{background:var(--hi-b);color:var(--hi-t);border-color:transparent}
.ap .chip.me{background:var(--me-b);color:var(--me-t);border-color:transparent}
.ap .chip.lo{background:var(--lo-b);color:var(--lo-t);border-color:transparent}
.ap .chip.in{background:var(--in-b);color:var(--in-t);border-color:transparent}
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
.ap .facet.on{background:rgba(0,0,0,0.045);color:var(--ink);font-weight:600}
.ap .facet .l{display:flex;align-items:center;gap:8px}
.ap .facet .sw{width:9px;height:9px;border-radius:3px;display:inline-block}
.ap .facet .c{color:var(--ink3);font-variant-numeric:tabular-nums}
.ap .clearall{margin-top:12px;width:100%;text-align:center;padding:6px;font-size:12px;color:var(--ink2);border:1px solid var(--border);border-radius:8px;background:#fff;cursor:pointer}
.ap .active-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:11px 14px 0}
.ap .active-chips .ac{background:rgba(0,0,0,0.05);color:var(--ink2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11.5px;cursor:pointer}
.ap .tbl{overflow:hidden}
.ap .thead,.ap .trow{display:grid;grid-template-columns:66px 96px 1.4fr 130px 150px 88px;gap:10px;align-items:center}
.ap .thead{padding:9px 14px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);border-bottom:1px solid var(--border);font-weight:650;background:#fbfbfc}
.ap .trow{padding:10px 14px;border-bottom:1px solid var(--border2);cursor:pointer;border-left:3px solid transparent}
.ap .trow:hover{background:#fafbfd}
.ap .trow.hi{border-left-color:var(--hi-br)} .ap .trow.me{border-left-color:var(--me-br)}
.ap .trow.lo{border-left-color:var(--lo-br)} .ap .trow.in{border-left-color:var(--in-br)}
.ap .sev{font-size:10.5px;font-weight:650;padding:2px 7px;border-radius:3px;letter-spacing:.03em;text-align:center;display:inline-block}
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

  // Severity is a stored column on AnomalyEvent → filtered server-side. No
  // default — show everything; the user filters when they want to.
  const [sevSel, setSevSel] = useState<Set<Severity>>(new Set<Severity>());
  const toggleSev = (key: Severity) =>
    setSevSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const sevList = useMemo(() => Array.from(sevSel).sort().join(','), [sevSel]);

  // Triage workqueue filter — default to open work (New + Acknowledged).
  const [statusSel, setStatusSel] = useState<Set<'new' | 'ack' | 'resolved'>>(
    new Set<'new' | 'ack' | 'resolved'>(['new', 'ack']),
  );
  const toggleStatus = (key: 'new' | 'ack' | 'resolved') =>
    setStatusSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const statusList = useMemo(() => Array.from(statusSel).sort().join(','), [statusSel]);

  const fromIso = localToIso(fromLocal);
  const toIso = localToIso(toLocal);

  const [cursor, setCursor] = useState<string | null>(null);
  const [stack, setStack] = useState<string[]>([]);
  const filterKey = `${branchValue}|${q}|${fromIso}|${toIso}|${catList}|${sevList}|${statusList}`;
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
      // While searching, show the FULL timeline for that entity/patient (who
      // billed, who finalized, drafts, access…) — don't hide it behind the
      // severity default.
      if (sevList && !q) p.set('severity', sevList);
      if (statusList && !q) p.set('status', statusList);
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

  const qc = useQueryClient();
  const [triaging, setTriaging] = useState(false);
  const doTriage = async (status: 'new' | 'ack' | 'resolved') => {
    if (!openRow) return;
    setTriaging(true);
    try {
      await apiRequest(`${API_BASE}/owner/audit/events/${openRow.id}/triage`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      setOpenRow((prev) => (prev ? { ...prev, status } : prev));
      qc.invalidateQueries({ queryKey: ['owner-audit'] });
    } catch {
      /* the row simply won't update on failure */
    } finally {
      setTriaging(false);
    }
  };

  // Staff scorecard — staff ranked by mistakes (rework), with its own period.
  const [scorePeriod, setScorePeriod] = useState('daily');
  const scoreFromIso = useMemo(() => {
    const def = SCORE_PERIODS.find((p) => p.key === scorePeriod);
    return def?.from ? def.from().toISOString() : null;
  }, [scorePeriod]);
  const scorecardQuery = useQuery<ScorecardResponse>({
    queryKey: ['owner-audit-scorecard', branchValue, scorePeriod],
    enabled: tab === 'score',
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('branch', branchValue);
      if (scoreFromIso) p.set('from', scoreFromIso);
      return apiRequest<ScorecardResponse>(`${API_BASE}/owner/audit/scorecard?${p.toString()}`);
    },
    staleTime: 45 * 1000,
  });

  // Access & disclosure — who viewed / printed / downloaded reports (header window).
  const accessQuery = useQuery<AccessResponse>({
    queryKey: ['owner-audit-access', branchValue, fromIso, toIso],
    enabled: tab === 'access',
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('branch', branchValue);
      if (fromIso) p.set('from', fromIso);
      if (toIso) p.set('to', toIso);
      p.set('limit', '100');
      return apiRequest<AccessResponse>(`${API_BASE}/owner/audit/access?${p.toString()}`);
    },
    staleTime: 45 * 1000,
  });

  const clearAll = () => {
    setCats(new Set());
    setSevSel(new Set<Severity>());
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
                {/* Card 1 — Severity breakdown (click to filter) + the flagged subset */}
                <div className="card kpi">
                  <div className="lbl">Severity · click to filter</div>
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
                      Flagged: <b style={{ color: '#A32D2D' }}>{h?.deletions ?? 0}</b> deletions ·{' '}
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

                {/* Card 3 — activity: who PERFORMED the most corrections today (the
                    fixer, not who caused it — accountability lives in the scorecard). */}
                <div className="card kpi">
                  <div className="lbl">Most corrections done today</div>
                  <div className="big">{h?.mistakesActor?.name ?? '—'}</div>
                  <div className="sm">
                    {h?.mistakesActor
                      ? `${h.mistakesActor.count} fixes performed — for who's accountable, see`
                      : 'no corrections · see'}
                    {' '}
                    <span
                      style={{ color: 'var(--accent)', cursor: 'pointer' }}
                      onClick={() => setTab('score')}
                    >
                      scorecard →
                    </span>
                  </div>
                  <hr />
                  <div className="sm">
                    {h?.finalized ?? 0} finalized · {h?.drafts ?? 0} drafts · {h?.reportAccess ?? 0} report views
                  </div>
                </div>
              </>
            );
          })()}
        </div>

        {/* Prominent, intentional search — a patient / bill / staff / event
            timeline lookup, sits right above the feed it drives. */}
        <div className="searchbar">
          <input
            className="searchbig"
            placeholder="Search a patient, bill #, staff or event — shows their full timeline"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="searchclear" onClick={() => setSearchInput('')} aria-label="Clear search">✕</button>
          )}
        </div>

        {/* Quick filters right under the search — same state as the rail, so the
            useful cuts (severity + event type) are one click away up top. */}
        {tab === 'feed' && (
          <div className="qfilters">
            <span className="flabel">Severity</span>
            {SEVS.map((s) => (
              <button key={s.key} className={`qchip ${sevSel.has(s.key) ? 'on' : ''}`} onClick={() => toggleSev(s.key)}>
                <span className="sw" style={{ background: `var(--${SEV_ABBR[s.key]}-br)` }} />
                {s.label}
              </button>
            ))}
            <span className="fdiv" />
            <span className="flabel">Type</span>
            {CATEGORIES.map((c) => (
              <button key={c.key} className={`qchip ${cats.has(c.key) ? 'on' : ''}`} onClick={() => toggleCat(c.key)}>
                {c.label}
              </button>
            ))}
            {(cats.size > 0 || sevSel.size > 0) && (
              <button className="fclear" onClick={clearAll}>Reset</button>
            )}
          </div>
        )}

        {/* tabs */}
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'feed' && <span className="cnt">{summary?.total ?? 0}</span>}
            </button>
          ))}
        </div>

        {tab === 'score' ? (
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>Staff scorecard — billing accuracy <span style={{ fontWeight: 400, color: 'var(--ink3)', fontSize: 12 }}>· data-entry fixes charged to whoever billed the patient</span></span>
              <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {SCORE_PERIODS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setScorePeriod(p.key)}
                    style={{
                      border: 0,
                      borderLeft: '1px solid var(--border)',
                      background: scorePeriod === p.key ? '#1F1F1E' : 'transparent',
                      color: scorePeriod === p.key ? '#fff' : 'var(--ink2)',
                      padding: '5px 12px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {scorecardQuery.isLoading && <div className="empty">Loading…</div>}
            {scorecardQuery.data && scorecardQuery.data.actors.length === 0 && scorecardQuery.data.noWindowBills.length === 0 && (
              <div className="empty">No bills in this window.</div>
            )}
            {scorecardQuery.data && (scorecardQuery.data.actors.length > 0 || scorecardQuery.data.noWindowBills.length > 0) && (() => {
              const data = scorecardQuery.data;
              const scored = data.scored;
              const info = data.info;
              const colCount = 2 + scored.length + info.length;
              const identityTip = (a: ScorecardActor) => {
                const b = a.identityBreak || {};
                const parts = Object.keys(b).filter((k) => b[k]).map((k) => `${k} ${b[k]}`);
                return parts.length ? `Identity fixes: ${parts.join(' · ')}` : 'Identity fixes';
              };
              const accColor = (acc: number) => acc >= 99 ? 'var(--ok)' : acc >= 95 ? 'var(--in-t)' : acc >= 90 ? 'var(--me-t)' : 'var(--hi-t)';
              // shared cell renderers for scored + info columns
              const typeCells = (a: ScorecardActor) => (
                <>
                  {scored.map((t) => (
                    <td key={t.key} title={t.key === 'identity' ? identityTip(a) : undefined}
                        style={{ padding: '11px 14px', textAlign: 'right', color: a.byType[t.key] ? 'var(--ink)' : 'var(--ink3)', fontVariantNumeric: 'tabular-nums', fontWeight: a.byType[t.key] ? 600 : 400 }}>
                      {a.byType[t.key] ?? 0}
                    </td>
                  ))}
                  {info.map((t, idx) => (
                    <td key={t.key}
                        style={{ padding: '11px 14px', textAlign: 'right', color: 'var(--ink3)', fontVariantNumeric: 'tabular-nums', borderLeft: idx === 0 ? '1px solid var(--border2)' : undefined }}>
                      {a.byType[t.key] ?? 0}
                    </td>
                  ))}
                </>
              );
              return (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ color: 'var(--ink3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    <th style={{ textAlign: 'left', padding: '9px 14px' }}>Staff</th>
                    <th style={{ textAlign: 'right', padding: '9px 14px' }}>Accuracy</th>
                    {scored.map((t) => (
                      <th key={t.key} style={{ textAlign: 'right', padding: '9px 14px' }}>{t.label}</th>
                    ))}
                    {info.map((t, idx) => (
                      <th key={t.key} style={{ textAlign: 'right', padding: '9px 14px', color: 'var(--ink3)', fontWeight: 500, borderLeft: idx === 0 ? '1px solid var(--border2)' : undefined }}>{t.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.actors.map((a, i) => {
                    const best = i === 0;
                    const acc = a.accuracy;
                    const col = accColor(acc);
                    return (
                      <tr key={a.userId} style={{ borderTop: '1px solid var(--border2)' }}>
                        <td style={{ padding: '11px 14px', fontWeight: 550 }}>
                          <span style={{ color: 'var(--ink3)', marginRight: 9, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                          {a.name}
                          {best && a.slips === 0 && <span style={{ color: 'var(--ok)', fontSize: 11, marginLeft: 7, fontWeight: 600 }}>✓ cleanest</span>}
                          <div style={{ color: 'var(--ink3)', fontSize: 11, marginTop: 2, fontWeight: 400 }}>
                            {a.slips} slip{a.slips === 1 ? '' : 's'} in {a.billed} billed
                          </div>
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 9 }}>
                            <div style={{ width: 56, height: 6, background: 'var(--border2)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${Math.round(acc)}%`, background: col, borderRadius: 3 }} />
                            </div>
                            <b style={{ color: col, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }} title="share of your bills that needed no data-entry fix">{acc.toFixed(1)}%</b>
                          </div>
                        </td>
                        {typeCells(a)}
                      </tr>
                    );
                  })}

                  {data.noWindowBills.length > 0 && (
                    <>
                      <tr>
                        <td colSpan={colCount} style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--ink3)', fontWeight: 650 }}>
                          Fixes on earlier bills <span style={{ textTransform: 'none', fontWeight: 400 }}>· these staff billed nothing this period, so there's no rate — shown for the record</span>
                        </td>
                      </tr>
                      {data.noWindowBills.map((a) => (
                        <tr key={a.userId} style={{ borderTop: '1px solid var(--border2)' }}>
                          <td style={{ padding: '11px 14px', fontWeight: 550 }}>
                            {a.name}
                            <div style={{ color: 'var(--ink3)', fontSize: 11, marginTop: 2, fontWeight: 400 }}>{a.slips} slip{a.slips === 1 ? '' : 's'} · billed 0 this period</div>
                          </td>
                          <td style={{ padding: '11px 14px', textAlign: 'right', color: 'var(--ink3)' }}>—</td>
                          {typeCells(a)}
                        </tr>
                      ))}
                    </>
                  )}

                  {data.labIncharge.length > 0 && (
                    <>
                      <tr>
                        <td colSpan={colCount} style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--ink3)', fontWeight: 650 }}>
                          Lab in-charge <span style={{ textTransform: 'none', fontWeight: 400 }}>· listed, not ranked</span>
                        </td>
                      </tr>
                      {data.labIncharge.map((a) => (
                        <tr key={a.userId} style={{ borderTop: '1px solid var(--border2)' }}>
                          <td style={{ padding: '11px 14px', fontWeight: 550 }}>
                            {a.name} <span style={{ color: 'var(--ink3)', fontSize: 11 }}>· lab in-charge</span>
                            <div style={{ color: 'var(--ink3)', fontSize: 11, marginTop: 2, fontWeight: 400 }}>{a.slips} slip{a.slips === 1 ? '' : 's'} in {a.billed} billed</div>
                          </td>
                          <td style={{ padding: '11px 14px', textAlign: 'right', color: a.accuracy < 0 ? 'var(--ink3)' : accColor(a.accuracy), fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
                            {a.accuracy < 0 ? '—' : `${a.accuracy.toFixed(1)}%`}
                          </td>
                          {typeCells(a)}
                        </tr>
                      ))}
                    </>
                  )}
                </tbody>
              </table>
              );
            })()}
            <div className="note-b" style={{ textAlign: 'left', padding: '12px 16px' }}>
              Accuracy = share of the bills a staff made that needed no later data-entry fix. A slip = a name / age / title /
              gender / phone correction, a referral-doctor change, or a test swap — each charged to whoever <b>billed</b> the
              patient (their mis-key), never the person who fixed it. Refunds, cancels and reopens are shown for context but
              don't affect the score. Counted in the period the fix happened.
            </div>
          </div>
        ) : tab === 'access' ? (
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>Access &amp; disclosure — who saw / printed / downloaded reports</span>
              {accessQuery.data && (
                <span style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--ink2)' }}>
                  <span><b>{accessQuery.data.counts.view}</b> viewed</span>
                  <span><b>{accessQuery.data.counts.download}</b> downloaded</span>
                  <span><b>{accessQuery.data.counts.print}</b> printed</span>
                </span>
              )}
            </div>
            {accessQuery.isLoading && <div className="empty">Loading…</div>}
            {accessQuery.data && accessQuery.data.items.length === 0 && (
              <div className="empty">No report access recorded in this window.</div>
            )}
            {accessQuery.data && accessQuery.data.items.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ color: 'var(--ink3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    <th style={{ textAlign: 'left', padding: '9px 14px' }}>Type</th>
                    <th style={{ textAlign: 'left', padding: '9px 14px' }}>Who</th>
                    <th style={{ textAlign: 'left', padding: '9px 14px' }}>Patient / report</th>
                    <th style={{ textAlign: 'left', padding: '9px 14px' }}>Via</th>
                    <th style={{ textAlign: 'left', padding: '9px 14px' }}>IP</th>
                    <th style={{ textAlign: 'right', padding: '9px 14px' }}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {accessQuery.data.items.map((r) => {
                    const ab = r.accessType === 'DOWNLOAD' ? 'hi' : r.accessType === 'PRINT' ? 'in' : 'lo';
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--border2)' }}>
                        <td style={{ padding: '10px 14px' }}><span className={`sev ${ab}`}>{r.accessType}</span></td>
                        <td style={{ padding: '10px 14px', fontWeight: 550 }}>{r.who ?? '—'}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--ink2)' }}>{r.patient ?? '—'}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--ink3)', fontSize: 12 }}>{r.accessedVia.replace('_', ' ').toLowerCase()}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--ink3)', fontSize: 12 }}>{r.ipAddress ?? '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--ink3)', fontSize: 12 }}>{formatIstDateTime(r.whenIso).split(' · ')[1] ?? formatIstTime(r.whenIso)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="note-b" style={{ textAlign: 'left', padding: '12px 16px' }}>
              Latest report accesses in the selected window (from ReportAccessLog). Backs the "who saw my report" /
              DPDP disclosure request. Token = a patient/public link; staff-portal = a signed-in staff member.
            </div>
          </div>
        ) : tab !== 'feed' ? (
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
              <h4>Triage</h4>
              {([['new', 'New'], ['ack', 'Acknowledged'], ['resolved', 'Resolved']] as const).map(([key, label]) => (
                <div key={key} className={`facet ${statusSel.has(key) ? 'on' : ''}`} onClick={() => toggleStatus(key)}>
                  <span className="l">{label}</span>
                  <span className="c">{summary?.triage[key] ?? 0}</span>
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
                  <div key={r.id} className={`trow ${ab}`} onClick={() => setOpenRow(r)} style={r.status === 'resolved' ? { opacity: 0.55 } : undefined}>
                    <div><span className={`sev ${ab}`}>{r.severity === 'medium' ? 'MED' : r.severity.toUpperCase()}</span></div>
                    <div className="cat">{r.category}</div>
                    <div className="ev">
                      {r.event}
                      {r.status === 'ack' && <span style={{ color: 'var(--me-t)', fontSize: 10.5, marginLeft: 7, fontWeight: 600 }}>ACK</span>}
                      {r.status === 'resolved' && <span style={{ color: 'var(--ok)', fontSize: 10.5, marginLeft: 7, fontWeight: 600 }}>✓ RESOLVED</span>}
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
                <div className="dr-title">{openRow.entityLabel ?? openRow.event}</div>
                <div className="dr-ent">
                  {openRow.event} · <b style={{ fontWeight: 600, color: 'var(--ink2)' }}>{openRow.who ?? 'system'}</b>{openRow.role ? ` (${openRow.role})` : ''} · {formatIstDateTime(openRow.whenIso)}
                </div>
              </div>
              <div className="dr-body">
                {(() => {
                  const isReport = openRow.entityType.toLowerCase() === 'reportdraft';
                  const rv = detail?.reportValues ?? [];
                  const edited = detail?.editedCodes ?? null;
                  const abn = (f: string | null) => f != null && f !== 'NORMAL';
                  const timeOnly = (iso: string) => formatIstDateTime(iso).split(' · ')[1] ?? formatIstDateTime(iso);
                  const ValueTable = ({ items, showWho }: { items: typeof rv; showWho: boolean }) => (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <tbody>
                        {items.map((v, i) => (
                          <tr key={i} style={{ borderTop: i ? '1px solid var(--border2)' : undefined }}>
                            <td style={{ padding: '5px 8px 5px 0', color: 'var(--ink)' }}>{v.name}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: abn(v.flag) ? 'var(--hi-t)' : 'var(--ink)', fontWeight: abn(v.flag) ? 600 : 400, whiteSpace: 'nowrap' }}>{v.value}{abn(v.flag) ? ` ${v.flag![0]}` : ''}</td>
                            {showWho && <td style={{ padding: '5px 0 5px 8px', textAlign: 'right', color: 'var(--ink3)', whiteSpace: 'nowrap' }}>{v.who ?? 'system'}{v.whenIso ? ` · ${timeOnly(v.whenIso)}` : ''}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );

                  if (isReport) {
                    const editedItems = edited ? rv.filter((v) => v.code && edited.includes(v.code)) : [];
                    const missing = edited ? edited.filter((c) => !rv.some((v) => v.code === c)) : [];
                    return (
                      <>
                        <div className="sec">
                          <h5>What {openRow.who ?? 'staff'} changed here</h5>
                          {detailQuery.isLoading && <div className="sm" style={{ color: '#888780' }}>Loading…</div>}
                          {!detailQuery.isLoading && edited === null && (
                            <div className="sm" style={{ color: '#888780' }}>Marks who authored / opened this draft. The exact values changed weren't recorded for this save — see the full report and the edit trail below.</div>
                          )}
                          {edited !== null && editedItems.length > 0 && <ValueTable items={editedItems} showWho={false} />}
                          {edited !== null && missing.length > 0 && (
                            <div className="sm" style={{ color: '#888780', marginTop: 6 }}>Also touched (no longer on the report): {missing.join(', ')}</div>
                          )}
                          {edited !== null && editedItems.length === 0 && missing.length === 0 && (
                            <div className="sm" style={{ color: '#888780' }}>No matching values on the current report.</div>
                          )}
                        </div>
                        {rv.length > 0 && (
                          <details className="sec">
                            <summary style={{ cursor: 'pointer', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--ink3)', fontWeight: 650 }}>
                              Full report · {rv.length} values · who entered each
                            </summary>
                            <div style={{ marginTop: 8 }}><ValueTable items={rv} showWho /></div>
                          </details>
                        )}
                      </>
                    );
                  }

                  // Non-report rows (money / referral / catalog): the field diff is the story.
                  return (
                    <div className="sec">
                      <h5>What changed</h5>
                      {detailQuery.isLoading && <div className="sm" style={{ color: '#888780' }}>Loading…</div>}
                      {detail && detail.diff.length === 0 && (
                        <div className="sm" style={{ color: '#888780' }}>{openRow.detail || 'No recorded field changes for this event.'}</div>
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
                  );
                })()}
                {detail && detail.related.length > 0 && (
                  <div className="sec">
                    <h5>Edit trail · this patient's report</h5>
                    {detail.related.map((r) => (
                      <div key={r.id} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '4px 0', color: r.isThis ? '#A32D2D' : 'var(--ink2)', fontWeight: r.isThis ? 600 : 400, borderTop: '1px solid var(--border2)' }}>
                        <span style={{ color: '#888780', width: 66, flex: 'none' }}>{formatIstDateTime(r.whenIso).split(' · ')[1] ?? ''}</span>
                        <span style={{ flex: 'none', width: 78 }}>{r.who ?? 'system'}</span>
                        <span style={{ color: '#888780' }}>{r.event}{r.isThis ? ' ·(this)' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="sec" style={{ border: 0 }}>
                  <h5>Triage — {openRow.status === 'new' ? 'New' : openRow.status === 'ack' ? 'Acknowledged' : 'Resolved'}</h5>
                  <div className="triage-btns">
                    <button
                      className={`tb ${openRow.status === 'new' ? 'pri' : ''}`}
                      disabled={triaging || openRow.status === 'ack'}
                      onClick={() => doTriage('ack')}
                    >
                      Acknowledge
                    </button>
                    <button
                      className="tb"
                      disabled={triaging || openRow.status === 'resolved'}
                      onClick={() => doTriage('resolved')}
                      style={openRow.status === 'resolved' ? undefined : { borderColor: 'var(--ok)', color: 'var(--ok)' }}
                    >
                      Resolve
                    </button>
                    {openRow.status !== 'new' && (
                      <button className="tb" disabled={triaging} onClick={() => doTriage('new')}>Reopen</button>
                    )}
                    {openRow.drillTo && (
                      <button className="tb" onClick={() => navigate(openRow.drillTo!)}>Open record ▸</button>
                    )}
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
