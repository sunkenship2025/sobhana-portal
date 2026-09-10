import { useEffect, useRef, useState } from 'react';
import { AnswerView, Chips, oneLine, Card } from './PulseCards';
import { rupees } from './format';
import type { usePulse } from './usePulse';

type P = ReturnType<typeof usePulse>;
export function PulsePanel({ p, onClose }: { p: P; onClose: () => void }) {
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }, [p.turns.length, p.thinking]);
  const submit = (q?: string) => { const v = (q ?? text).trim(); if (!v) return; setText(''); p.ask(v); };
  const empty = p.turns.length === 0;

  return (
    <div className={`pulse-panel fixed bottom-6 right-6 z-50 flex flex-col overflow-hidden rounded-2xl border bg-card ${p.expanded ? 'h-[min(720px,calc(100vh-48px))] w-[min(560px,calc(100vw-48px))]' : 'h-[min(560px,calc(100vh-48px))] w-[min(400px,calc(100vw-48px))]'}`} role="dialog" aria-label="Pulse">
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <div className={`pulse-orb is-small ${p.thinking ? 'is-thinking' : ''}`} />
        <span className="pulse-label">PULSE</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{p.context.period ? `${p.context.period} · ` : ''}All branches</span>
        <button type="button" title={p.expanded ? 'Smaller' : 'Larger'} onClick={() => p.setExpanded(!p.expanded)} className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">⤡</button>
        {!empty && <button type="button" title="Start over" onClick={p.reset} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">↺</button>}
        <button type="button" title="Close" onClick={onClose} className="rounded p-1 text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground">×</button>
      </div>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {empty && (p.today ? (
          <>
            <Card><div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">Collection today</div>
              <div className="mt-0.5 text-[22px] font-semibold tracking-tight">{rupees(p.today.collectionToday)}{p.today.sofar && <span className="ml-2 text-xs font-normal text-muted-foreground">so far</span>}{p.today.vsUsual != null && <span className={`ml-2 text-xs font-semibold ${p.today.vsUsual < 0 ? 'text-[#D91C2B]' : 'text-green-700'}`}>{p.today.vsUsual > 0 ? '↑' : '↓'} {Math.abs(p.today.vsUsual)}% vs usual</span>}</div></Card>
            <Card><div className="flex gap-6">
              <div><div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">Cases</div><div className="text-lg font-semibold">{p.today.cases}</div></div>
              <div><div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">Pending due</div><div className="text-lg font-semibold">{rupees(p.today.due, { compact: true })}</div></div>
              <div><div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">Reports &gt;24h</div><div className={`text-lg font-semibold ${p.today.lateReports ? 'text-[#D91C2B]' : ''}`}>{p.today.lateReports}</div></div>
            </div></Card>
            <Chips chips={p.today.chips} onAsk={submit} />
          </>
        ) : p.todayFailed ? (
          <div className="pt-2"><p className="text-[15px] font-semibold">Hey.</p><p className="text-[13px] text-muted-foreground">What would you like to look into?</p>
            <Chips chips={[{ label: 'Collection', q: 'this month collection how much' }, { label: 'Cases', q: 'cases this month branch wise' }, { label: 'Referrals', q: 'doctor wise cases this month top 5' }, { label: 'Reports late?', q: 'reports late kitne hain' }]} onAsk={submit} /></div>
        ) : (
          <div className="space-y-3 pt-1"><div className="h-3 w-2/5 animate-pulse rounded bg-muted" /><div className="h-6 w-3/5 animate-pulse rounded bg-muted" /><div className="h-3 w-1/2 animate-pulse rounded bg-muted" /></div>
        ))}

        {p.turns.map((t) => t.collapsed && t.answer && t.answer.kind !== 'pick' ? (
          <button key={t.id} type="button" onClick={() => p.toggleCollapse(t.id)} className="flex w-full items-center justify-between border-b border-dashed pb-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground">
            <span className="truncate pr-3">{t.q}</span><span className="shrink-0 font-medium text-foreground">{oneLine(t.answer)}</span>
          </button>
        ) : (
          <div key={t.id} className="space-y-2">
            <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-muted px-3 py-1.5 text-[13px]">{t.q}</div>
            {t.pending && <div className="flex items-center gap-1.5 py-1"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#25397a]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#25397a] [animation-delay:150ms]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#25397a] [animation-delay:300ms]" /></div>}
            {t.error && <p className="text-[13px] text-[#D91C2B]">{t.error}</p>}
            {t.answer && <AnswerView a={t.answer} onAsk={submit} />}
          </div>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-center gap-2 border-t px-4 py-3">
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Pulse…" disabled={p.thinking}
          className="h-10 flex-1 rounded-full border bg-background px-4 text-[14px] outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-60" />
        <button type="submit" disabled={p.thinking || !text.trim()} aria-label="Ask" className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40">↑</button>
      </form>
    </div>
  );
}
