/**
 * Pulse — artifact renderers. An answer is TEXT; these attach only when the shape carries
 * something words cannot. Each maps to one artifact type the analyst may request.
 */
import { fmtValue, pct, label as lbl } from './format';

type Ev = any;
const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <div className={`rounded-xl border bg-card px-4 py-3 ${className}`}>{children}</div>;
const K = ({ children }: { children: React.ReactNode }) =>
  <div className="text-[10.5px] font-medium uppercase tracking-[.08em] text-muted-foreground">{children}</div>;
const Delta = ({ v }: { v: number | null | undefined }) => v == null ? null :
  <span className={`ml-2 text-xs font-semibold ${v < 0 ? 'text-[#D91C2B]' : v > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>{pct(v)}</span>;

function Kpi({ a, ev }: { a: any; ev: Ev }) {
  const s = ev.summary || {};
  const value = s.value ?? s.now ?? s.latestComplete ?? '—';
  return <Card><K>{a.label || lbl(ev.metric || ev.label)}</K>
    <div className="mt-1 text-[26px] font-semibold leading-none tracking-tight">{value}<Delta v={s.changePct} /></div>
    {s.comparison && <div className="mt-1.5 text-[11px] text-muted-foreground">{s.comparison}</div>}</Card>;
}
function Kpis({ a, evs }: { a: any; evs: Ev[] }) {
  return <Card><div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
    {evs.map((e, i) => { const s = e.summary || {}; return (
      <div key={i}><K>{lbl(e.metric || e.label)}</K>
        <div className="mt-0.5 text-[17px] font-semibold leading-tight">{s.value ?? s.now ?? '—'}<Delta v={s.changePct} /></div>
      </div>); })}
  </div>{a.label && <div className="mt-2 text-[11px] text-muted-foreground">{a.label}</div>}</Card>;
}
function Compare({ a, ev }: { a: any; ev: Ev }) {
  const s = ev.summary || {};
  return <Card><K>{a.label || lbl(ev.metric)}</K>
    <div className="mt-1.5 flex items-end gap-6">
      <div><div className="text-[10.5px] text-muted-foreground">before</div><div className="text-[17px] font-semibold">{s.before}</div></div>
      <div className="pb-1 text-muted-foreground">→</div>
      <div><div className="text-[10.5px] text-muted-foreground">now</div><div className="text-[20px] font-semibold">{s.now}<Delta v={s.changePct} /></div></div>
    </div>
    {s.comparison && <div className="mt-2 text-[11px] text-muted-foreground">{s.comparison}</div>}</Card>;
}
function Breakdown({ a, ev }: { a: any; ev: Ev }) {
  const parts = ev.summary?.parts || ev.summary?.byBranch || ev.summary?.top || [];
  const max = Math.max(...parts.map((p: any) => Math.abs(Number(String(p.value).replace(/[^\d.-]/g, '')) || 0)), 1);
  return <Card><K>{a.label || `${lbl(ev.metric || '')}${ev.dimension ? ` by ${lbl(ev.dimension)}` : ''}`}</K>
    <div className="mt-2 space-y-1.5">
      {parts.slice(0, 8).map((p: any, i: number) => {
        const n = Math.abs(Number(String(p.value).replace(/[^\d.-]/g, '')) || 0);
        return (<div key={i}>
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="truncate pr-3">{p.name}</span>
            <span className="shrink-0 font-medium tabular-nums">{p.value}
              {p.change && p.change !== '—' && <span className="ml-2 text-[11px] text-muted-foreground">{p.change}</span>}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-foreground/70" style={{ width: `${Math.max(2, n / max * 100)}%` }} /></div>
        </div>); })}
    </div>
    {ev.summary?.total && <div className="mt-2.5 border-t pt-2 text-[11.5px] text-muted-foreground">Total {ev.summary.total}</div>}</Card>;
}
function Ranking({ a, ev }: { a: any; ev: Ev }) {
  const rows = ev.summary?.top || ev.summary?.doctors || ev.summary?.parts || [];
  return <Card><K>{a.label || `Top ${lbl(ev.dimension || '')}`}</K>
    <div className="mt-1.5 divide-y divide-dashed">
      {rows.slice(0, 8).map((r: any, i: number) => (
        <div key={i} className={`flex items-center justify-between py-1.5 text-[13px] ${i === 0 ? 'font-semibold' : ''}`}>
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="w-3 shrink-0 text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="truncate">{r.name}</span></span>
          <span className="shrink-0 tabular-nums">{r.value ?? r.referralsBefore}</span>
        </div>))}
    </div></Card>;
}
function Chart({ a, ev }: { a: any; ev: Ev }) {
  const rows: any[] = ev.data?.rows || [];
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => Math.abs(r.v)), 1);
  const last = rows[rows.length - 1];
  return <Card><K>{a.label || lbl(ev.metric || '')}</K>
    <div className="mt-1 text-[20px] font-semibold leading-none tracking-tight">
      {ev.summary?.latestComplete?.split(': ')[1] ?? fmtValue(last?.v, ev.unit)}
      <span className="ml-2 text-[11px] font-normal text-muted-foreground">{ev.summary?.latestComplete?.split(':')[0] ?? last?.k}</span>
    </div>
    <div className="mt-3 flex h-16 items-end gap-[3px]">
      {rows.map((r, i) => <div key={i} title={`${r.k}: ${fmtValue(r.v, ev.unit)}${r.partial ? ' (in progress)' : ''}`}
        className={`pulse-bar flex-1 ${r.partial ? 'is-partial' : i === rows.length - 1 ? 'is-latest' : ''}`}
        style={{ height: `${Math.max(4, Math.abs(r.v) / max * 100)}%` }} />)}
    </div>
    <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground"><span>{rows[0]?.k}</span><span>{last?.k}</span></div>
    {ev.summary?.currentIncomplete && <div className="mt-1.5 text-[11px] text-muted-foreground">Latest bar is still in progress.</div>}</Card>;
}
function Table({ a, ev }: { a: any; ev: Ev }) {
  const rows: any[] = ev.data?.rows || ev.summary?.rows || [];
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  return <Card className="overflow-x-auto px-0 py-0">
    {a.label && <div className="border-b px-4 py-2"><K>{a.label}</K></div>}
    <table className="w-full text-[12.5px]">
      <thead><tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
        {cols.map((c) => <th key={c} className="px-4 py-2 font-medium">{lbl(c)}</th>)}</tr></thead>
      <tbody>{rows.slice(0, 15).map((r, i) => <tr key={i} className="border-b last:border-0">
        {cols.map((c) => <td key={c} className={`px-4 py-1.5 ${typeof r[c] === 'number' ? 'tabular-nums' : ''}`}>
          {typeof r[c] === 'number' ? fmtValue(r[c], ev.unit, c) : String(r[c] ?? '')}</td>)}</tr>)}</tbody>
    </table></Card>;
}

export function Artifact({ a, evidence }: { a: any; evidence: Ev[] }) {
  const byIdx = new Map(evidence.map((e) => [e.step, e]));
  const one = (i: any) => byIdx.get(Number(i));
  if (a.type === 'kpis') { const evs = (Array.isArray(a.evidence) ? a.evidence : [a.evidence]).map(one).filter(Boolean); return evs.length ? <Kpis a={a} evs={evs} /> : null; }
  const ev = one(Array.isArray(a.evidence) ? a.evidence[0] : a.evidence);
  if (!ev) return null;
  switch (a.type) {
    case 'kpi': return <Kpi a={a} ev={ev} />;
    case 'compare': return <Compare a={a} ev={ev} />;
    case 'breakdown': return <Breakdown a={a} ev={ev} />;
    case 'ranking': return <Ranking a={a} ev={ev} />;
    case 'chart': return <Chart a={a} ev={ev} />;
    case 'table': return <Table a={a} ev={ev} />;
    default: return null;
  }
}
