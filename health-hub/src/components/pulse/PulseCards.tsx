/**
 * Pulse — one component per answer shape. The backend decides the shape; nothing here guesses.
 * Cards follow the existing card language (white, 1px border, rounded-lg) — no new primitives.
 */
import { fmtValue, pct, rupees, label } from './format';
import type { Answer, Chip } from './usePulse';

type Row = Record<string, unknown>;
const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const ORDERING = /^(rank|rk|row_number|position|pos|rn)$/i;
function split(rows: Row[]) {
  const cols = Object.keys(rows[0] || {});
  const numCols = cols.filter((c) => !ORDERING.test(c) && rows.every((r) => r[c] === null || isNum(r[c])));
  const keyCols = cols.filter((c) => !numCols.includes(c) && !ORDERING.test(c));
  return { cols, numCols, keyCols };
}

export function Chips({ chips, onAsk }: { chips?: Chip[]; onAsk: (q: string) => void }) {
  if (!chips?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <button key={c.label} type="button" onClick={() => onAsk(c.q)}
          className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted">
          {c.label}
        </button>
      ))}
    </div>
  );
}

function Warning({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-900">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider">Worth checking</span>{text}
    </div>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card px-3.5 py-3 ${className}`}>{children}</div>;
}
const K = ({ children }: { children: React.ReactNode }) => <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{children}</div>;
const Big = ({ children, delta }: { children: React.ReactNode; delta?: number | null }) => (
  <div className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight">
    {children}{delta != null && <span className={`ml-2 text-xs font-semibold ${delta < 0 ? 'text-[#D91C2B]' : 'text-green-700'}`}>{pct(delta)}</span>}
  </div>
);

/* ── SQL shapes ─────────────────────────────────────────────────────────── */
function Scalar({ a }: { a: Answer }) {
  const rows: Row[] = a.rows; const { numCols, cols } = split(rows);
  const c = numCols[0] || cols[0]; const v = rows[0]?.[c];
  return <Card><K>{a.metric ? label(a.metric) : label(c)}</K><Big>{fmtValue(v, a.unit, c)}</Big></Card>;
}
function Kpis({ a }: { a: Answer }) {
  const rows: Row[] = a.rows; const { numCols } = split(rows);
  return (
    <Card><div className="flex flex-wrap gap-x-6 gap-y-2">
      {numCols.map((c) => <div key={c}><K>{label(c)}</K><div className="text-lg font-semibold">{fmtValue(rows[0][c], a.unit, c)}</div></div>)}
    </div></Card>
  );
}
function Compare({ a }: { a: Answer }) {
  const rows: Row[] = a.rows; const { numCols, keyCols } = split(rows);
  const pair = rows.length === 2 && numCols.length >= 1
    ? rows.map((r) => ({ k: String(r[keyCols[0]] ?? ''), v: r[numCols[0]] }))
    : numCols.slice(0, 2).map((c) => ({ k: label(c), v: rows[0][c] }));
  const [x, y] = pair; const d = isNum(x?.v) && isNum(y?.v) && Number(x.v) ? (Number(y.v) - Number(x.v)) / Math.abs(Number(x.v)) * 100 : null;
  return (
    <Card><div className="grid grid-cols-2 gap-3">
      <div><K>{x?.k}</K><div className="text-lg font-semibold">{fmtValue(x?.v, a.unit)}</div></div>
      <div><K>{y?.k}</K><div className="text-lg font-semibold">{fmtValue(y?.v, a.unit)}{d != null && <span className={`ml-2 text-xs ${d < 0 ? 'text-[#D91C2B]' : 'text-green-700'}`}>{pct(d)}</span>}</div></div>
    </div></Card>
  );
}
function List({ a, ranked }: { a: Answer; ranked?: boolean }) {
  const rows: Row[] = a.rows; const { numCols, keyCols } = split(rows);
  const k = keyCols[0], v = numCols[0];
  const total = rows.reduce((s, r) => s + (Number(r[v]) || 0), 0);
  return (
    <Card>
      <K>{a.metric ? label(a.metric) : label(v)}{ranked ? ' · ranked' : ''}</K>
      <div className="mt-1 divide-y divide-dashed">
        {rows.slice(0, 12).map((r, i) => (
          <div key={i} className={`flex items-center justify-between py-1 text-[13px] ${ranked && i === 0 ? 'font-semibold' : ''}`}>
            <span className="truncate pr-3">{ranked && <span className="mr-2 inline-block w-4 text-muted-foreground">{i + 1}</span>}{String(r[k] ?? '(none)')}</span>
            <span className="tabular-nums font-medium">{fmtValue(r[v], a.unit, v)}</span>
          </div>))}
      </div>
      {rows.length > 12 && <div className="mt-1 text-[11px] text-muted-foreground">+{rows.length - 12} more</div>}
      {!ranked && rows.length > 1 && <div className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">Total {fmtValue(total, a.unit, v)}</div>}
    </Card>
  );
}
function Series({ a }: { a: Answer }) {
  const rows: Row[] = a.rows; const { numCols, keyCols } = split(rows);
  const k = keyCols[0], v = numCols[0]; const vals = rows.map((r) => Number(r[v]) || 0); const max = Math.max(...vals, 1);
  const last = rows[rows.length - 1];
  return (
    <Card>
      <K>{a.metric ? label(a.metric) : label(v)}</K>
      <Big>{fmtValue(last?.[v], a.unit, v)}<span className="ml-2 text-xs font-normal text-muted-foreground">{String(last?.[k] ?? '')}</span></Big>
      <div className="mt-2 flex h-14 items-end gap-[3px]">
        {vals.map((x, i) => <div key={i} title={`${rows[i][k]}: ${fmtValue(x, a.unit, v)}`} className={`flex-1 rounded-t-sm ${i === vals.length - 1 ? 'bg-[#D91C2B]' : 'bg-foreground/85'}`} style={{ height: `${Math.max(4, x / max * 100)}%` }} />)}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{String(rows[0]?.[k] ?? '')}</span><span>{String(last?.[k] ?? '')}</span></div>
    </Card>
  );
}
function Table({ a }: { a: Answer }) {
  const rows: Row[] = a.rows; const cols = Object.keys(rows[0] || {});
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-[12px]">
        <thead><tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">{cols.map((c) => <th key={c} className="px-3 py-1.5 font-medium">{label(c)}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 20).map((r, i) => <tr key={i} className="border-b last:border-0">{cols.map((c) => <td key={c} className={`px-3 py-1 ${isNum(r[c]) ? 'tabular-nums' : ''}`}>{isNum(r[c]) ? fmtValue(r[c], a.unit, c) : String(r[c] ?? '')}</td>)}</tr>)}</tbody>
      </table>
    </Card>
  );
}

/* ── pipeline shapes ────────────────────────────────────────────────────── */
function Status({ a }: { a: Answer }) {
  const kpis: any[] = a.kpis || [];
  return (
    <div className="space-y-2">
      {a.text && <p className="text-[13px] leading-relaxed">{a.text}</p>}
      <Card><div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        {kpis.map((k) => <div key={k.metric}><K>{label(k.metric)}</K><div className="text-base font-semibold">{fmtValue(k.current, k.unit)}<span className={`ml-1.5 text-[11px] ${k.deltaPct < 0 ? 'text-[#D91C2B]' : k.deltaPct > 0 ? 'text-green-700' : 'text-muted-foreground'}`}>{pct(k.deltaPct)}</span></div></div>)}
      </div><div className="mt-2 text-[11px] text-muted-foreground">{a.window?.note}</div></Card>
    </div>
  );
}
function Diagnose({ a }: { a: Answer }) {
  const movers: any[] = a.movers || [];
  return (
    <div className="space-y-2">
      {a.text && <p className="text-[13px] leading-relaxed">{a.premiseCorrected && <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">premise corrected</span>}{a.text}</p>}
      {movers.length > 0 && <Card><K>What moved it · {label(a.metric || '')}</K>
        <div className="mt-1 divide-y divide-dashed">{movers.map((m, i) => (
          <div key={i} className="flex items-center justify-between py-1 text-[13px]"><span className="truncate pr-3">{m.name}<span className="ml-1.5 text-[10px] text-muted-foreground">{label(m.by)}</span></span>
            <span className={`tabular-nums font-medium ${m.delta < 0 ? 'text-[#D91C2B]' : 'text-green-700'}`}>{m.delta > 0 ? '+' : ''}{fmtValue(m.delta, a.unit)}</span></div>))}</div>
        {a.baseline && <div className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">{a.baseline.verdict} · typical {fmtValue(a.baseline.baselineMean, a.unit)} over {a.baseline.periodsCompared} periods</div>}
      </Card>}
    </div>
  );
}
function Ladder({ a }: { a: Answer }) {
  const L = a.ladder;
  return (
    <div className="space-y-2">
      <Card><K>What we can see · {L.period}</K>
        <div className="mt-1 divide-y divide-dashed">{L.rungs.map((r: any, i: number) => (
          <div key={i} className={`flex items-center justify-between py-1 text-[13px] ${r.amountPaise < 0 ? 'text-[#D91C2B]' : ''}`}><span>{r.label}</span><span className="tabular-nums">{r.amount}</span></div>))}
          <div className="flex items-center justify-between border-t-2 pt-1.5 text-[13px] font-semibold"><span>Left after recorded payouts</span><span className="tabular-nums">{L.remaining}</span></div>
        </div>
        <div className="mt-2 rounded-md bg-muted px-2.5 py-1.5 text-[11.5px] leading-snug text-muted-foreground"><b className="text-foreground">This is not profit.</b> Not recorded: {L.missing.join(', ')}.</div>
      </Card>
      {a.text && <p className="text-[12.5px] leading-relaxed text-muted-foreground">{a.text}</p>}
    </div>
  );
}
function Entity({ a }: { a: Answer }) {
  return (
    <Card><K>{a.entity.name} · this month</K>
      <div className="mt-1.5 grid grid-cols-3 gap-3">{a.facts.map((f: any) => <div key={f.label}><div className="text-[10px] text-muted-foreground">{f.label}</div><div className="text-[15px] font-semibold">{f.value}{f.deltaPct != null && <span className={`ml-1 text-[10px] ${f.deltaPct < 0 ? 'text-[#D91C2B]' : 'text-green-700'}`}>{pct(f.deltaPct)}</span>}</div></div>)}</div>
      {a.note && <div className="mt-2 text-[11.5px] text-muted-foreground">{a.note}</div>}
    </Card>
  );
}
function Pick({ a, onAsk }: { a: Answer; onAsk: (q: string) => void }) {
  const opts: any[] = a.options || [];
  return (
    <div>
      <p className="mb-1.5 text-[13px]">{a.text}</p>
      <div className="overflow-hidden rounded-lg border">
        {opts.slice(0, 5).map((o) => <button key={o.id} type="button" onClick={() => onAsk(`${a.state?.lastQ || ''} — ${o.name}`.replace(/^ — /, ''))} className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-[13px] last:border-0 hover:bg-muted"><span>{o.name}</span><span className="text-[11px] text-muted-foreground">{o.kind === 'doctor' ? 'referring doctor' : o.kind}</span></button>)}
        {opts.length > 5 && <div className="px-3 py-1.5 text-[11px] text-muted-foreground">+{opts.length - 5} more — add a first name or branch</div>}
      </div>
    </div>
  );
}
function Refuse({ a }: { a: Answer }) {
  return <p className="text-[13px] leading-relaxed">{a.text}{a.reason === 'out_of_scope' && <span className="ml-1 text-[11px] text-muted-foreground">No query was run.</span>}</p>;
}

/* ── dispatcher ─────────────────────────────────────────────────────────── */
export function AnswerView({ a, onAsk }: { a: Answer; onAsk: (q: string) => void }) {
  let body: React.ReactNode;
  if (a.kind === 'sql') {
    const s = a.shape;
    body = s === 'scalar' ? <Scalar a={a} /> : s === 'kpis' ? <Kpis a={a} /> : s === 'compare' ? <Compare a={a} /> : s === 'list' ? <List a={a} /> : s === 'ranked' ? <List a={a} ranked /> : s === 'series' ? <Series a={a} /> : <Table a={a} />;
  } else if (a.kind === 'status') body = <Status a={a} />;
  else if (a.kind === 'diagnose') body = <Diagnose a={a} />;
  else if (a.kind === 'ladder') body = <Ladder a={a} />;
  else if (a.kind === 'entity') body = <Entity a={a} />;
  else if (a.kind === 'pick') return <Pick a={a} onAsk={onAsk} />;
  else body = <Refuse a={a} />;
  return (
    <div>
      {body}
      <Warning text={a.warning?.text} />
      <Chips chips={a.chips} onAsk={onAsk} />
      {a.provenance?.sql && <details className="mt-1.5 text-[11px] text-muted-foreground"><summary className="cursor-pointer select-none">show query</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10.5px] leading-snug">{a.provenance.sql}</pre>
        <div className="mt-1">source {a.provenance.tables?.join(', ')} · {a.provenance.rowCount} row{a.provenance.rowCount === 1 ? '' : 's'}{a.provenance.assumptions ? ` · ${a.provenance.assumptions}` : ''}</div></details>}
    </div>
  );
}

/** One line summary for a collapsed earlier turn. */
export function oneLine(a?: Answer): string {
  if (!a) return '';
  if (a.kind === 'sql' && a.rows?.length) { const { numCols } = split(a.rows); const v = a.rows[0][numCols[0]]; return a.rows.length === 1 ? fmtValue(v, a.unit, numCols[0]) : `${a.rows.length} rows`; }
  if (a.kind === 'ladder') return a.ladder?.remaining || '';
  if (a.kind === 'entity') return a.facts?.[0]?.value || a.entity?.name || '';
  if (a.kind === 'diagnose') return a.total ? `${a.total.deltaPct > 0 ? '+' : ''}${a.total.deltaPct ?? ''}%` : '';
  if (a.kind === 'status') return 'overview';
  return a.kind;
}
export { rupees };
