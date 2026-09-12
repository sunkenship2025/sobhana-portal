/**
 * Pulse — artifact renderers. An answer is TEXT; these attach only when the shape carries
 * something words cannot. Each maps to one artifact type the analyst may request.
 */
import { fmtValue, pct, label as lbl } from './format';
import { deriveView, pctOf, type View } from './deriveView';

type Ev = any;
const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <div className={`rounded-xl border bg-card px-4 py-3 ${className}`}>{children}</div>;
const K = ({ children }: { children: React.ReactNode }) =>
  <div className="text-[10.5px] font-medium uppercase tracking-[.08em] text-muted-foreground">{children}</div>;
/**
 * What the figures ARE. `means` reaches the browser on every step — lineage() sets it — and was
 * displayed nowhere: the top missing field in all six artifact types when measured. It is the
 * sentence that answers "what am I looking at", which is exactly what a card showing `9` with no
 * denominator, period or scope cannot answer.
 */
const Context = ({ v }: { v: View }) => {
  const line = [...v.context].filter(Boolean).join(' · ');
  if (!line && !v.means) return null;
  return <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
    {line}{line && v.means ? ' — ' : ''}{v.means}</div>;
};
/** The tail and the concentration: stated, because slice(8) dropped them in silence. */
const Tail = ({ v }: { v: View }) => {
  const bits = [
    v.total && `Total ${v.total}`,
    v.hidden && `${v.hidden.count} more${v.hidden.value ? ` · ${v.hidden.value}` : ''}`,
    v.concentration && `top ${v.concentration.topN} = ${pctOf(v.concentration.share)}`,
  ].filter(Boolean) as string[];
  if (!bits.length) return null;
  return <div className="mt-2.5 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t pt-2 text-[11.5px] text-muted-foreground">
    {bits.map((b, i) => <span key={i}>{b}</span>)}</div>;
};
const Delta = ({ v }: { v: number | null | undefined }) => v == null ? null :
  <span className={`ml-2 text-xs font-semibold ${v < 0 ? 'text-[#D91C2B]' : v > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>{pct(v)}</span>;

/* A single number with no period, no scope and no statement of what it measures is the artifact
   that prompted "what exactly am I looking at". It scored worst of every type on both axes —
   40% of material fields, 29% of useful — while carrying all of them on the wire. */
const evContext = (ev: Ev): string => {
  const s = ev.summary || {};
  const period = ev.period ?? s.period;
  return [period && (typeof period === 'object' ? `${period.from} to ${period.to}` : String(period)),
    ev.scope ?? s.scope, ev.means].filter(Boolean).join(' · ');
};
function Kpi({ a, ev }: { a: any; ev: Ev }) {
  const s = ev.summary || {};
  const value = s.value ?? s.now ?? s.latestComplete ?? '—';
  const ctx = evContext(ev);
  return <Card><K>{a.label || lbl(ev.metric || ev.label)}</K>
    <div className="mt-1 text-[26px] font-semibold leading-none tracking-tight">{value}<Delta v={s.changePct} /></div>
    {s.comparison && <div className="mt-1.5 text-[11px] text-muted-foreground">{s.comparison}</div>}
    {ctx && <div className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{ctx}</div>}</Card>;
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
    {s.comparison && <div className="mt-2 text-[11px] text-muted-foreground">{s.comparison}</div>}
    {evContext(ev) && <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{evContext(ev)}</div>}</Card>;
}
/**
 * Rows can arrive under any of these. A `query` step puts them in summary.rows while the registry
 * tools use `parts`, so a breakdown bound to a query step found nothing, drew zero bars, and
 * still painted its card and title — an empty box captioned "WALK-IN REVENUE BY SERVICE LINE".
 * Capability had said the step was drawable; the renderer disagreed, and nothing reconciled them.
 */
function seriesOf(ev: Ev): any[] {
  const s = ev.summary || {};
  const pick = s.parts || s.byBranch || s.top || s.doctors || s.rows || ev.data?.rows || [];
  if (!Array.isArray(pick) || !pick.length) return [];
  // normalise a raw row {reason, discount} into the {name, value} the bars expect
  if (pick[0] && typeof pick[0] === 'object' && !('name' in pick[0]) && !('k' in pick[0])) {
    const cols = Object.keys(pick[0]);
    const label = cols.find((c) => typeof pick[0][c] === 'string');
    const val = cols.find((c) => c !== label && (typeof pick[0][c] === 'number' || /₹|%/.test(String(pick[0][c]))));
    if (label && val) return pick.map((r: any) => ({ name: r[label], value: r[val] }));
    return [];
  }
  return pick.map((r: any) => ({ ...r, name: r.name ?? r.k }));
}

function Breakdown({ a, ev }: { a: any; ev: Ev }) {
  const v = deriveView(ev, 8);
  if (!v) return null;                            // never a titled empty box
  const max = Math.max(...v.rows.map((r) => r.n), 1);
  return <Card><K>{a.label || `${lbl(ev.metric || '')}${ev.dimension ? ` by ${lbl(ev.dimension)}` : ''}`}</K>
    <Context v={v} />
    <div className="mt-2 space-y-1.5">
      {v.rows.map((r, i) => (
        <div key={i}>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{r.value}
              {r.share != null && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{pctOf(r.share)}</span>}
              {r.change && <span className="ml-2 text-[11px] font-normal text-muted-foreground">{r.change}</span>}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-foreground/70"
            style={{ width: `${Math.max(2, r.n / max * 100)}%` }} /></div>
        </div>))}
    </div>
    <Tail v={v} /></Card>;
}
function Ranking({ a, ev }: { a: any; ev: Ev }) {
  const v = deriveView(ev, 8);
  if (!v) return null;
  return <Card><K>{a.label || `Top ${lbl(ev.dimension || '')}`}</K>
    <Context v={v} />
    <div className="mt-1.5 divide-y divide-dashed">
      {v.rows.map((r, i) => (
        <div key={i} className={`flex items-center justify-between gap-3 py-1.5 text-[13px] ${i === 0 ? 'font-semibold' : ''}`}>
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span className="w-3 shrink-0 text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="truncate">{r.label}</span></span>
          <span className="shrink-0 tabular-nums">{r.value}
            {r.share != null && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{pctOf(r.share)}</span>}
            {r.change && <span className="ml-2 text-[11px] font-normal text-muted-foreground">{r.change}</span>}</span>
        </div>))}
    </div>
    <Tail v={v} /></Card>;
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
    {ev.summary?.currentIncomplete && <div className="mt-1.5 text-[11px] text-muted-foreground">Latest bar is still in progress.</div>}
    {ev.means && <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{ev.means}</div>}</Card>;
}
function Table({ a, ev }: { a: any; ev: Ev }) {
  const rows: any[] = ev.data?.rows || ev.summary?.rows || [];
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, 15);
  /* The most-used artifact in production, and it stated no period, no scope, no units and no row
     count — 0 of 4 useful fields when measured. It showed fifteen rows of twenty-seven without
     saying so, which reads as the whole answer. */
  const v = deriveView(ev, 15);
  const ctx = [...(v?.context ?? []), v?.means].filter(Boolean).join(' · ');
  return <Card className="overflow-x-auto px-0 py-0">
    {(a.label || ctx) && <div className="border-b px-4 py-2">
      {a.label && <K>{a.label}</K>}
      {ctx && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{ctx}</div>}
    </div>}
    <table className="w-full text-[12.5px]">
      <thead><tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
        {cols.map((c) => <th key={c} className="px-4 py-2 font-medium">{lbl(c)}</th>)}</tr></thead>
      <tbody>{shown.map((r, i) => <tr key={i} className="border-b last:border-0">
        {cols.map((c) => <td key={c} className={`px-4 py-1.5 ${typeof r[c] === 'number' ? 'tabular-nums' : ''}`}>
          {typeof r[c] === 'number' ? fmtValue(r[c], ev.unit, c) : String(r[c] ?? '')}</td>)}</tr>)}</tbody>
    </table>
    {(rows.length > shown.length || ev.summary?.orderedBy) && <div className="flex flex-wrap justify-between gap-x-4 border-t px-4 py-1.5 text-[11.5px] text-muted-foreground">
      {rows.length > shown.length && <span>Showing {shown.length} of {rows.length}</span>}
      {ev.summary?.orderedBy && <span>sorted by {lbl(String(ev.summary.orderedBy).split(' ')[0])} {String(ev.summary.orderedBy).split(' ').slice(1).join(' ')}</span>}
    </div>}
  </Card>;
}

/** signed magnitude out of a value — "-₹4,400" and 440000 both matter here */
const num = (v: any) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
/** Evidence carries money two ways: summaries are pre-formatted strings ("₹2,750"), raw rows are
 *  integers in paise. Running fmtValue over a string that is already rupees converts it a second
 *  time and shows ₹28 for ₹2,750 — a hundredfold understatement that typechecks perfectly. */
const isFormatted = (v: any) => typeof v === 'string' && /[₹%]/.test(v);
const disp = (v: any, unit?: any) => isFormatted(v) ? v : fmtValue(num(v), unit);
/** a total derived from values that were already rupees must not be re-converted either */
const dispSum = (n: number, anyFormatted: boolean, unit?: any) =>
  anyFormatted ? `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}` : fmtValue(n, unit);

/**
 * WATERFALL — what moved, and which way. Every "why did X change" answer is a start, a set of
 * signed contributions, and an end; prose flattens that into a list of numbers. Contributions
 * run out from a centre line so a fall reads as a fall.
 */
function Waterfall({ a, ev }: { a: any; ev: Ev }) {
  const parts = seriesOf(ev);
  const items = parts.map((p: any) => ({ name: p.name, d: num(p.change ?? p.delta), raw: p.change ?? p.delta }))
    .filter((i: any) => i.d !== 0).sort((x: any, y: any) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 8);
  const fmtd = items.some((i: any) => isFormatted(i.raw));
  if (!items.length) return null;
  const max = Math.max(...items.map((i: any) => Math.abs(i.d)), 1);
  const net = items.reduce((t: number, i: any) => t + i.d, 0);
  return <Card><K>{a.label || `What moved${ev.dimension ? ` — by ${lbl(ev.dimension)}` : ''}`}</K>
    {evContext(ev) && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{evContext(ev)}</div>}
    <div className="mt-2.5 space-y-1.5">
      {items.map((i: any, n: number) => {
        const w = Math.max(2, Math.abs(i.d) / max * 50);
        return (<div key={n} className="flex items-center gap-2 text-[12.5px]">
          <span className="w-[38%] truncate pr-1 text-right">{i.name}</span>
          <span className="relative h-3 flex-1">
            <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
            <span className={`absolute top-0 h-3 rounded-sm ${i.d < 0 ? 'pulse-down-bg' : 'pulse-up-bg'}`}
              style={i.d < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
          </span>
          <span className={`w-[22%] shrink-0 tabular-nums text-right text-[11.5px] ${i.d < 0 ? 'pulse-down' : 'pulse-up'}`}>
            {i.d > 0 ? '+' : ''}{disp(i.raw, ev.unit)}</span>
        </div>); })}
    </div>
    <div className="mt-2.5 flex justify-between border-t pt-2 text-[11.5px]">
      <span className="text-muted-foreground">Net change{(ev.data as any)?.total != null
        ? ` · ends at ${dispSum(Math.abs(Number((ev.data as any).total)), fmtd, ev.unit)}` : ''}</span>
      <span className={`font-semibold tabular-nums ${net < 0 ? 'pulse-down' : 'pulse-up'}`}>{net > 0 ? '+' : ''}{dispSum(net, fmtd, ev.unit)}</span>
    </div></Card>;
}

/**
 * DISTRIBUTION — the tail, which an average hides. "Median turnaround 6h" says nothing about the
 * 5% sitting at 48h, and that 5% is what the complaints are about. Buckets are computed here so
 * any query returning a numeric column can be shown this way.
 */
function Distribution({ a, ev }: { a: any; ev: Ev }) {
  const rows: any[] = ev.data?.rows || ev.summary?.rows || [];
  if (rows.length < 4) return null;
  const col = Object.keys(rows[0]).find((c) => typeof rows[0][c] === 'number' && !/^(id|count|n)$/i.test(c));
  if (!col) return null;
  const vals = rows.map((r) => Number(r[col])).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (vals.length < 4) return null;
  const lo = vals[0], hi = vals[vals.length - 1];
  if (hi === lo) return null;
  const B = 10, step = (hi - lo) / B;
  const buckets = Array.from({ length: B }, () => 0);
  vals.forEach((v) => { buckets[Math.min(B - 1, Math.floor((v - lo) / step))]++; });
  const peak = Math.max(...buckets, 1);
  const p = (f: number) => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
  return <Card><K>{a.label || `Spread of ${lbl(col)}`}</K>
    <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
      {[`${vals.length} ${lbl(col).toLowerCase()} values`, evContext(ev)].filter(Boolean).join(' · ')}</div>
    <div className="mt-2 flex h-16 items-end gap-[3px]">
      {buckets.map((c, i) => <div key={i} title={`${fmtValue(lo + i * step, ev.unit, col)} – ${fmtValue(lo + (i + 1) * step, ev.unit, col)}: ${c}`}
        className="pulse-bar flex-1" style={{ height: `${Math.max(3, c / peak * 100)}%` }} />)}
    </div>
    <div className="mt-2 flex justify-between border-t pt-2 text-[11px] text-muted-foreground">
      <span>median {fmtValue(p(0.5), ev.unit, col)}</span>
      <span>90th {fmtValue(p(0.9), ev.unit, col)}</span>
      <span>worst {fmtValue(hi, ev.unit, col)}</span>
    </div></Card>;
}

/**
 * PARETO — concentration. "What is driving this?" is the commonest question an owner asks, and
 * the answer is almost never "everything equally". Bars descending with a cumulative line shows
 * in one glance how few things account for most of it.
 */
function Pareto({ a, ev }: { a: any; ev: Ev }) {
  const src = seriesOf(ev);
  const items = src.map((p: any) => {
    const rawV = p.value ?? p.v ?? Object.values(p).find((x: any) => typeof x === 'number' || isFormatted(x));
    return { name: p.name ?? p.k ?? p.reason ?? p.branch ?? Object.values(p)[0], v: Math.abs(num(rawV)), raw: rawV };
  }).filter((i: any) => i.v > 0).sort((x: any, y: any) => y.v - x.v).slice(0, 12);
  if (items.length < 3) return null;
  const total = items.reduce((t: number, i: any) => t + i.v, 0);
  if (!total) return null;
  const max = items[0].v;
  let run = 0;
  const withCum = items.map((i: any) => { run += i.v; return { ...i, cum: run / total * 100 }; });
  const vital = withCum.findIndex((i: any) => i.cum >= 80) + 1;
  return <Card><K>{a.label || 'What accounts for most of it'}</K>
    <div className="mt-2 space-y-1.5">
      {withCum.map((i: any, n: number) => (
        <div key={n} className="flex items-center gap-2 text-[12.5px]">
          <span className="w-[34%] truncate pr-1 text-right">{i.name}</span>
          <span className="h-3 flex-1 rounded-sm bg-muted">
            <span className="block h-3 rounded-sm bg-foreground/70" style={{ width: `${Math.max(2, i.v / max * 100)}%` }} /></span>
          <span className="w-[16%] shrink-0 text-right tabular-nums text-[11.5px]">{disp(i.raw, ev.unit)}</span>
          <span className="w-[13%] shrink-0 text-right tabular-nums text-[10.5px] text-muted-foreground">{i.cum.toFixed(0)}%</span>
        </div>))}
    </div>
    {vital > 0 && <div className="mt-2.5 border-t pt-2 text-[11.5px] text-muted-foreground">
      The top {vital} of {withCum.length} account for {withCum[vital - 1].cum.toFixed(0)}% of the total.</div>}
  </Card>;
}

/** FUNNEL — how much survives each stage. Sending is not delivering. */
function Funnel({ a, ev }: { a: any; ev: Ev }) {
  const st = ev.summary?.stages || [];
  const stages = Array.isArray(st) && st.length ? st
    : ev.summary?.finalized != null ? [{ name: 'Reports finalised', value: ev.summary.finalized },
      { name: 'Opened by the patient', value: ev.summary.openedByPatient }] : [];
  if (stages.length < 2) return null;
  const top = Math.max(num(stages[0].value), 1);
  return <Card><K>{a.label || 'Reaching the patient'}</K>
    <div className="mt-2 space-y-2">
      {stages.map((s: any, i: number) => { const v = num(s.value), sharePct = v / top * 100; return (
        <div key={i}>
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="truncate pr-3">{s.name}</span>
            <span className="shrink-0 font-medium tabular-nums">{s.value}
              {i > 0 && <span className="ml-2 text-[11px] text-muted-foreground">{sharePct.toFixed(0)}%</span>}</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-muted">
            <div className="h-2 rounded-full bg-foreground/70" style={{ width: `${Math.max(2, sharePct)}%` }} /></div>
        </div>); })}
    </div></Card>;
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
    case 'waterfall': return <Waterfall a={a} ev={ev} />;
    case 'distribution': return <Distribution a={a} ev={ev} />;
    case 'funnel': return <Funnel a={a} ev={ev} />;
    case 'pareto': return <Pareto a={a} ev={ev} />;
    default: return null;
  }
}
