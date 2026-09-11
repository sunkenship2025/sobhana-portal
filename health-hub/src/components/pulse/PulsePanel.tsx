import { useEffect, useRef, useState } from 'react';
import { Artifact } from './PulseArtifacts';
import { rupees } from './format';
import type { usePulse, Turn } from './usePulse';

type P = ReturnType<typeof usePulse>;

const Chips = ({ chips, onAsk }: { chips?: { label: string; q: string }[]; onAsk: (q: string) => void }) =>
  !chips?.length ? null : (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {chips.map((c, i) => (
        <button key={i} type="button" onClick={() => onAsk(c.q)}
          className="pulse-chip rounded-full border bg-background px-3 py-1 text-[11.5px] font-medium">
          {c.label}
        </button>))}
    </div>);

/** The wait shows the analysis, not a spinner — the plan is the most reassuring thing we have. */
function Thinking({ steps }: { steps?: string[] }) {
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN((x) => x + 1), 1400); return () => clearInterval(t); }, []);
  const line = steps?.length ? steps[Math.min(n, steps.length - 1)] : ['Working out what to look at…', 'Reading the numbers…', 'Putting it together…'][Math.min(n, 2)];
  return <div className="pulse-step py-1"><i /><span>{line}</span></div>;
}

function TurnView({ t, onAsk, onExpand }: { t: Turn; onAsk: (q: string) => void; onExpand: () => void }) {
  const a = t.answer;
  if (t.collapsed && a) return (
    <button type="button" onClick={onExpand}
      className="flex w-full items-baseline justify-between border-b border-dashed pb-2 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground">
      <span className="truncate pr-3">{t.q}</span>
      <span className="shrink-0 text-[11px]">{a.kind === 'analysis' ? `${a.artifacts?.length || 0 ? 'shown' : 'answered'}` : a.kind}</span>
    </button>);
  return (
    <div className="pulse-turn space-y-2.5">
      <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[13.5px] leading-snug">{t.q}</div>
      {t.pending && <Thinking steps={t.steps} />}
      {t.error && <p className="text-[13px] text-[#D91C2B]">{t.error}</p>}
      {a && <>
        {a.text && <p className="pulse-answer whitespace-pre-line text-[13.5px] leading-[1.65]">{a.text}</p>}
        {(a.artifacts || []).map((x: any, i: number) => <Artifact key={i} a={x} evidence={a.evidence || []} />)}
        {a.kind === 'refuse' && !a.text && <p className="text-[13.5px]">I couldn't answer that.</p>}
        <Chips chips={a.chips} onAsk={onAsk} />
        {a.evidence?.length > 0 && (
          <details className="pulse-evidence text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none py-0.5 hover:text-foreground">how this was worked out</summary>
            <ol className="mt-1.5 space-y-1 border-l pl-3">
              {a.evidence.filter((e: any) => e.ok).map((e: any) => (
                <li key={e.step}><span className="font-medium text-foreground">{e.label}</span>
                  <span className="ml-1.5 opacity-70">{e.tool}</span>
                  {e.sql && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px] leading-snug">{e.sql}</pre>}
                </li>))}
            </ol>
          </details>)}
      </>}
    </div>);
}

export function PulsePanel({ p, onClose }: { p: P; onClose: () => void }) {
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [p.turns.length, p.thinking]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  const submit = (q?: string) => { const v = (q ?? text).trim(); if (!v) return; setText(''); p.ask(v); };
  const empty = p.turns.length === 0;

  return (
    <div className={`pulse-scope pulse-panel fixed bottom-9 right-9 z-50 print:hidden flex flex-col overflow-hidden rounded-2xl border bg-card ${p.expanded ? 'h-[min(760px,calc(100vh-48px))] w-[min(600px,calc(100vw-48px))]' : 'h-[min(600px,calc(100vh-48px))] w-[min(420px,calc(100vw-48px))]'}`}
      role="dialog" aria-label="Pulse">

      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <div className={`pulse-orb is-small ${p.thinking ? 'is-thinking' : ''}`} />
        <span className="pulse-label">PULSE</span>
        <span className="ml-auto truncate text-[11px] text-muted-foreground">{p.branchName || 'All branches'}</span>
        <button type="button" title={p.expanded ? 'Smaller' : 'Larger'} onClick={() => p.setExpanded(!p.expanded)}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          {/* corner brackets: outward to grow, inward to shrink. No diagonal — it read as a broken glyph. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {p.expanded
              ? <><path d="M13 6H10V3" /><path d="M3 10h3v3" /></>
              : <><path d="M10 2.5h3.5V6" /><path d="M6 13.5H2.5V10" /></>}
          </svg></button>
        {!empty && <button type="button" title="Start over" onClick={p.reset}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.1" /><path d="M13.5 2.2V5.4H10.3" /></svg></button>}
        <button type="button" title="Close (Esc)" onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </div>

      <div ref={scroller} className="pulse-scroll flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {empty && (p.today ? (
          <div className="space-y-3">
            <div className="rounded-xl border bg-card px-4 py-3">
              <div className="text-[10.5px] font-medium uppercase tracking-[.08em] text-muted-foreground">Collection today</div>
              <div className="mt-1 text-[26px] font-semibold leading-none tracking-tight">
                {rupees(p.today.collectionToday)}
                {p.today.sofar && <span className="ml-2 text-xs font-normal text-muted-foreground">so far</span>}
                {p.today.vsUsual != null && <span className={`ml-2 text-xs font-semibold ${p.today.vsUsual < 0 ? 'text-[#D91C2B]' : 'text-green-700'}`}>
                  {p.today.vsUsual > 0 ? '↑' : '↓'} {Math.abs(p.today.vsUsual)}% vs usual</span>}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[['Cases', String(p.today.cases), false], ['Pending due', rupees(p.today.due, { compact: true }), false],
                ['Reports >24h', String(p.today.lateReports), p.today.lateReports > 0]].map(([l, v, warn]) => (
                <div key={l as string} className="rounded-xl border bg-card px-3 py-2.5">
                  <div className="text-[10px] text-muted-foreground">{l}</div>
                  <div className={`mt-0.5 text-[17px] font-semibold ${warn ? 'text-[#D91C2B]' : ''}`}>{v}</div>
                </div>))}
            </div>
            <Chips chips={p.today.chips} onAsk={submit} />
          </div>
        ) : p.todayFailed ? (
          <div className="pt-2">
            <p className="text-[16px] font-semibold">Hey.</p>
            <p className="mb-2.5 text-[13px] text-muted-foreground">What would you like to look into?</p>
            <Chips onAsk={submit} chips={[{ label: 'Collection', q: 'this month collection how much' },
              { label: 'Cases', q: 'cases this month branch wise' }, { label: 'Referrals', q: 'doctor wise cases this month top 5' },
              { label: 'Where am I losing money', q: 'where am i losing money' }]} />
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-7 w-3/5 animate-pulse rounded bg-muted" />
            <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />)}</div>
          </div>
        ))}

        {p.turns.map((t) => <TurnView key={t.id} t={t} onAsk={submit} onExpand={() => p.toggleCollapse(t.id)} />)}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-center gap-2 border-t px-4 py-3">
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Pulse…" disabled={p.thinking}
          className="h-11 flex-1 rounded-full border bg-background px-4 text-[14px] outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-60" />
        <button type="submit" disabled={p.thinking || !text.trim()} aria-label="Ask"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-35">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
        </button>
      </form>
    </div>);
}
