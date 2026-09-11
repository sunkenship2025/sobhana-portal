import { useEffect, useRef, useState } from 'react';
import type { Step, Segments, Opportunity } from './usePulse';
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
/**
 * The work, as it happens. This used to be three canned lines on a 1.4s timer with nothing behind
 * them, so a two-minute investigation sat on "Putting it together…" and read as a hang. The
 * backend now streams what it is measuring and what it has ruled out; the trail stays on screen
 * so the owner can see the reasoning rather than a spinner.
 */
/**
 * The answer, laid out by what each part IS. The model used to return one string and emitted a
 * seven-sentence block whatever the question was; it now declares a verdict, findings, a caveat
 * and an action, and the contract decides which of those a given job may carry. The model picks
 * the content, the contract picks the shape, this picks the typography.
 */
/**
 * What is worth doing, in the order the evidence supports — not the order that sounds most
 * actionable. That ordering is why a ₹7,400 idea once outranked a ₹1,05,035 one. A modelled
 * figure is never shown as money in hand, and anything that could not be sized sits below the
 * line as considered rather than recommended: you may not recommend what you have not measured.
 */
export function Opportunities({ list, considered }: { list: Opportunity[]; considered?: string[] | null }) {
  return (
    <div className="space-y-2 pt-0.5">
      {list.map((o, i) => (
        <div key={i} className="rounded-xl border bg-card px-3.5 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="flex-1 text-[13.5px] font-semibold">{o.title}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-[.07em]"
              style={{ color: o.causality === 'modeled' ? 'var(--pulse-down)' : 'var(--pulse-up)' }}>
              {o.causality === 'modeled' ? 'scenario' : o.causality}
            </span>
          </div>
          <div className="mt-1 pl-[18px] text-[12.5px]">{o.impact}</div>
          {o.lever && <div className="mt-1 pl-[18px] text-[11.5px] text-muted-foreground">{o.lever}</div>}
        </div>))}
      {!!considered?.length && (
        <p className="pl-1 text-[11.5px] text-muted-foreground">
          Also considered, but not sized: {considered.join(', ')} — not ready to recommend.
        </p>)}
    </div>);
}

export function Answer({ s }: { s: Segments }) {
  return (
    <div className="pulse-answer space-y-2.5">
      <p className="text-[13.5px] leading-[1.6]">{s.verdict}</p>

      {!!s.points?.length && (
        <ul className="space-y-1.5">
          {s.points.map((p, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-[1.55]">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full" style={{ background: 'var(--pulse-line)' }} />
              <span>{p.label && <span className="font-medium">{p.label}. </span>}
                <span className="text-muted-foreground">{p.text}</span></span>
            </li>))}
        </ul>)}

      {s.caveat && (
        <p className="border-l-2 pl-2.5 text-[12.5px] leading-[1.5] text-muted-foreground"
           style={{ borderColor: 'var(--pulse-line)' }}>{s.caveat}</p>)}

      {s.action && <p className="text-[13px] font-medium leading-[1.55]">{s.action}</p>}
    </div>);
}

export function Thinking({ steps }: { steps?: Step[] }) {
  const [n, setN] = useState(0);
  const [secs, setSecs] = useState(0);
  const live = steps?.length ? steps : null;
  useEffect(() => { const t = setInterval(() => { setN((x) => x + 1); setSecs((s) => s + 1); }, 1000); return () => clearInterval(t); }, []);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => { tailRef.current?.scrollIntoView({ block: 'nearest' }); }, [steps?.length]);

  if (!live) {
    const line = ['Working out what to look at…', 'Reading the numbers…', 'Putting it together…'][Math.min(Math.floor(n / 1.4), 2)];
    return <div className="pulse-step py-1"><i /><span>{line}</span></div>;
  }
  const objective = live.find((s) => s.kind === 'objective');
  const all = live.filter((s) => s.kind === 'confirmed' || s.kind === 'rejected');
  // The animated line is what Pulse is DOING. When the last event was a verdict it was being
  // echoed there as well as in the list above, reading as if the same thing happened twice.
  const tail = [...live].reverse().find((s) => s.kind === 'phase' || s.kind === 'step')
    ?? { text: 'Working through it', kind: 'phase' as const };
  const recent = live.filter((s) => s.kind === 'step').slice(-3);
  // Bounded, not accumulating. A deep investigation settles eight or nine claims and the block
  // was growing until it pushed the question off screen. Past three, the older ones collapse to
  // a count and only the two most recent stay spelled out — the trail stays a fixed size.
  const many = all.length > 3;
  const verdicts = many ? all.slice(-2) : all;
  const nOk = all.filter((v) => v.kind === 'confirmed').length;
  const nNo = all.length - nOk;

  return (
    <div className="space-y-1.5 py-0.5">
      {objective && (
        <div className="flex gap-2 text-[12px] leading-snug">
          <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--pulse-ink)' }} />
          <span className="font-medium">{objective.text}</span>
        </div>)}

      {many && (
        <div className="flex gap-3 pl-[14px] text-[11px] text-muted-foreground/80">
          {nOk > 0 && <span><span className="pulse-up font-semibold">✓</span> {nOk} established</span>}
          {nNo > 0 && <span><span className="pulse-down font-semibold">✗</span> {nNo} ruled out</span>}
        </div>)}

      {verdicts.length > 0 && (
        <div className="space-y-0.5 pl-[14px]">
          {verdicts.map((v, i) => (
            <div key={i} className="flex gap-1.5 text-[11.5px] leading-snug">
              <span className={`shrink-0 font-semibold ${v.kind === 'confirmed' ? 'pulse-up' : 'pulse-down'}`}>
                {v.kind === 'confirmed' ? '✓' : '✗'}</span>
              <span className="text-muted-foreground">{v.text}</span>
            </div>))}
        </div>)}

      {recent.length > 1 && tail.kind !== 'step' && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-[14px] text-[11px] text-muted-foreground/70">
          {recent.map((s, i) => <span key={i}>{s.text}{i < recent.length - 1 && ' ·'}</span>)}
        </div>)}

      <div ref={tailRef} className="pulse-step py-0.5">
        <i /><span>{tail.text}</span>
        {secs > 6 && <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground/60">{secs}s</span>}
      </div>
    </div>);
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
        {a.segments?.verdict
          ? <Answer s={a.segments} />
          : a.text && <p className="pulse-answer whitespace-pre-line text-[13.5px] leading-[1.65]">{a.text}</p>}
        {!!a.opportunities?.length && <Opportunities list={a.opportunities} considered={a.consideredNotSized} />}
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
