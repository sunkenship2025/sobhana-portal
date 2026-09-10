import { useCallback, useEffect, useRef, useState } from 'react';
import { branchRequest } from '@/lib/query';
import { useBranchStore } from '@/store/branchStore';
const bid = () => useBranchStore.getState().activeBranchId || '';

export interface Chip { label: string; q: string; }
export interface PulseState { lastQ?: string | null; metric?: string | null; period?: string | null; kind?: string | null; }
export interface Answer { kind: string; [k: string]: any; state?: PulseState; }
export interface Turn { id: number; q: string; answer?: Answer; error?: string; pending?: boolean; collapsed?: boolean; steps?: string[]; }
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
      const answer = await branchRequest<Answer>('/pulse/ask', bid(), { method: 'POST', body: JSON.stringify({ q: text, state: stateRef.current }) });
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
