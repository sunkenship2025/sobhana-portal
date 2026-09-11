import { useCallback, useEffect, useRef, useState } from 'react';
import { branchRequest } from '@/lib/query';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
const bid = () => useBranchStore.getState().activeBranchId || '';

export interface Chip { label: string; q: string; }
export interface PulseState { lastQ?: string | null; metric?: string | null; period?: string | null; kind?: string | null; }
export interface Answer { kind: string; [k: string]: any; state?: PulseState; }
export type StepKind = 'phase' | 'objective' | 'step' | 'confirmed' | 'rejected';
export interface Step { text: string; kind: StepKind }
export interface Segments { verdict?: string; points?: { label?: string; text: string }[]; caveat?: string; action?: string }
export interface Turn { id: number; q: string; answer?: Answer; error?: string; pending?: boolean; collapsed?: boolean; steps?: Step[]; }
export interface Today { date: string; sofar?: boolean; collectionToday: number; vsUsual: number | null; cases: number; due: number; lateReports: number; chips: Chip[]; }

const SIZE_KEY = 'pulse.size';
let todayCache: { at: number; data: Today } | null = null;
let todayInflight: Promise<Today> | null = null;
const TTL = 5 * 60 * 1000;

/** Fetch the empty-state pack; cached 5 min, safe to call on hover (prefetch). */
export function fetchToday(): Promise<Today> {
  if (todayCache && Date.now() - todayCache.at < TTL) return Promise.resolve(todayCache.data);
  if (!todayInflight) todayInflight = branchRequest<Today>('/pulse/today', bid()).then((d) => { todayCache = { at: Date.now(), data: d }; todayInflight = null; return d; }).catch((e) => { todayInflight = null; throw e; });
  return todayInflight;
}

/**
 * Ask, and show the work while it happens. The panel used to run a canned three-line rotation on
 * a timer — "Working out what to look at…", "Reading the numbers…", "Putting it together…" — with
 * no connection to the analysis, so a two-minute investigation read as a hang on the third line.
 * The backend now streams what it is measuring and what it has ruled out; this reads that.
 *
 * Falls back to the plain JSON endpoint if streaming is unavailable, so a proxy that cannot do
 * text/event-stream degrades to the old behaviour rather than breaking the feature.
 */
async function askStreaming(q: string, state: any, onLine: (s: Step) => void): Promise<Answer> {
  const { token } = useAuthStore.getState();
  const res = await fetch(`${API_BASE}/pulse/ask/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Branch-Id': bid(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ q, state }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return branchRequest<Answer>('/pulse/ask', bid(), { method: 'POST', body: JSON.stringify({ q, state }) });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', answer: Answer | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // SSE frames are separated by a blank line; keep the tail, it may be half a frame
    const frames = buf.split('\n\n'); buf = frames.pop() ?? '';
    for (const f of frames) {
      const ev = /^event:\s*(\S+)/m.exec(f)?.[1];
      const raw = f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        if (ev === 'progress' && data?.text) onLine({ text: String(data.text), kind: (data.kind || 'step') as StepKind });
        else if (ev === 'answer') answer = data as Answer;
      } catch { /* a partial frame; the next read completes it */ }
    }
  }
  if (!answer) throw new Error('Pulse did not finish answering.');
  return answer;
}

export function usePulse() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<boolean>(() => { try { return localStorage.getItem(SIZE_KEY) === 'lg'; } catch { return false; } });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [today, setToday] = useState<Today | null>(null);
  const branchName = useBranchStore((s) => s.getActiveBranch?.()?.name || null);
  const [todayFailed, setTodayFailed] = useState(false);
  const stateRef = useRef<PulseState>({});
  const idRef = useRef(1);
  const thinking = turns.some((t) => t.pending);

  useEffect(() => { try { localStorage.setItem(SIZE_KEY, expanded ? 'lg' : 'sm'); } catch { /* private mode */ } }, [expanded]);

  const prefetch = useCallback(() => { fetchToday().then(setToday).catch(() => setTodayFailed(true)); }, []);
  useEffect(() => { if (open && !today) { const t = setTimeout(() => setTodayFailed((f) => f || !todayCache), 2000); prefetch(); return () => clearTimeout(t); } }, [open, today, prefetch]);

  const ask = useCallback(async (q: string) => {
    const text = q.trim(); if (!text) return;
    if (text.startsWith('/')) { window.location.assign(text); return; }   // deep-link chips ("open Payouts")
    const id = idRef.current++;
    setTurns((ts) => [...ts.map((t) => ({ ...t, collapsed: true })), { id, q: text, pending: true }]);
    try {
      const answer = await askStreaming(text, stateRef.current, (step) =>
        setTurns((ts) => ts.map((t) => t.id === id ? { ...t, steps: [...(t.steps || []), step] } : t)));
      if (answer.state) stateRef.current = answer.state;
      setTurns((ts) => ts.map((t) => t.id === id ? { ...t, answer, pending: false } : t));
    } catch (e: any) {
      // a raw "HTTP 502" is not an answer; say what happened in the owner's terms
      const m = String(e?.message || '');
      const friendly = /401|403/.test(m) ? 'Pulse is for the owner account.' : /400/.test(m) ? "Pulse didn't receive that question — try once more." : /5\d\d|unavailable|fetch/i.test(m) ? "Pulse couldn't reach the database just now. Try again in a moment." : m || 'Pulse is unavailable right now.';
      setTurns((ts) => ts.map((t) => t.id === id ? { ...t, error: friendly, pending: false } : t));
    }
  }, []);

  const toggleCollapse = useCallback((id: number) => setTurns((ts) => ts.map((t) => t.id === id ? { ...t, collapsed: !t.collapsed } : t)), []);
  const reset = useCallback(() => { setTurns([]); stateRef.current = {}; }, []);
  return { open, setOpen, expanded, setExpanded, turns, today, todayFailed, thinking, ask, prefetch, toggleCollapse, reset, branchName, context: stateRef.current };
}
