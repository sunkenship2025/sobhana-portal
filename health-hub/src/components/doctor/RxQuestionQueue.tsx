/**
 * The question queue — one open question at a time, at the commit bar.
 *
 * WHY A QUEUE RATHER THAN AMBER BORDERS ON CARDS
 * Inline markers are skippable: a doctor can scroll past them and hit Review,
 * and the sign gate then refuses at the worst possible moment. Real multi-step
 * interaction cost measurably changes that — the classic security-warning study
 * saw dismissal fall from 90% on a one-click warning to 45% once answering took
 * genuine steps. A queue is friction of exactly the right kind: proportional to
 * the number of real questions, and ZERO when there are none.
 *
 * THREE QUESTIONS, THREE CONTROLS
 * The resolver says WHY it is asking, and each reason gets its own shape:
 *   MULTIPLE_MATCHES     a closed choice between real products
 *   STRENGTH_NOT_STOCKED keep what was said, or take a stocked strength
 *   NO_MATCH             an open choice: search, or keep as written
 * Collapsing them into one generic "confirm" dialog is how a specific question
 * becomes a generic click.
 *
 * WHAT IS DELIBERATELY ABSENT
 * No percentage confidence — across 48 models self-reported confidence exceeded
 * accuracy in every one, and in a real clinical task numeric confidence caused
 * overreliance that REDUCED accuracy. No "accept suggestion" default. No
 * dismiss: published CDS override rates run 49-96%, so a question that can be
 * waved away is not a control.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Quote, Search, Loader2, Check, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  doctorApi, itemTitle, openQuestions,
  type RxItem, type MedicationCandidate, type AskReason,
} from '@/lib/doctorApi';

interface Props {
  items: RxItem[];
  /** Apply the doctor's answer to one line. */
  onResolve: (index: number, patch: Partial<RxItem>) => void;
  className?: string;
}

const HEADLINE: Record<AskReason, string> = {
  MULTIPLE_MATCHES: 'Which medicine?',
  STRENGTH_NOT_STOCKED: 'Confirm the strength',
  NO_MATCH: 'Not in the medicine list',
};

export function RxQuestionQueue({ items, onResolve, className }: Props) {
  const questions = useMemo(() => openQuestions(items), [items]);
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MedicationCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // Answering a question shortens the list; keep the cursor inside it.
  useEffect(() => {
    if (cursor >= questions.length) setCursor(Math.max(0, questions.length - 1));
  }, [questions.length, cursor]);

  useEffect(() => { setQuery(''); setResults([]); }, [cursor]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      try { setResults((await doctorApi.searchMedications(q, 'search')).candidates); }
      catch { setResults([]); }
      finally { setSearching(false); }
    }, 200);
    return () => window.clearTimeout(timer.current);
  }, [query]);

  const current = questions[cursor];

  const choose = useCallback((c: MedicationCandidate) => {
    if (!current) return;
    onResolve(current.index, {
      medicationId: c.medicationId,
      canonicalName: c.canonicalName,
      genericName: c.genericName,
      brandName: c.brandName,
      strength: c.strength ?? current.item.strength,
      strengthUnit: c.strengthUnit ?? current.item.strengthUnit,
      dosageForm: c.dosageForm ?? current.item.dosageForm,
      route: c.route ?? current.item.route,
      // A human chose it. Never re-resolved, never second-guessed.
      resolution: 'MANUAL',
      candidates: null,
    });
  }, [current, onResolve]);

  const keepAsSpoken = useCallback(() => {
    if (!current) return;
    onResolve(current.index, { resolution: 'MANUAL', candidates: null });
  }, [current, onResolve]);

  if (questions.length === 0) return null;
  if (!current) return null;

  const { item, reason, spokenStrength } = current;
  const spoken = item.spokenText ?? item.canonicalName;
  const candidates = item.candidates ?? [];
  const hasSource = !!item.sourceText;

  return (
    <section
      className={cn('rounded-lg border border-amber-300 bg-amber-50 p-3 sm:p-4', className)}
      aria-label="Questions to answer before signing"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <span className="text-sm font-semibold text-amber-900">
          {questions.length === 1
            ? '1 thing needs your answer'
            : `${cursor + 1} of ${questions.length} · needs your answer`}
        </span>
        {questions.length > 1 && (
          <span className="ml-auto flex gap-1">
            <Button
              type="button" variant="ghost" size="sm" className="h-7 text-amber-800"
              onClick={() => setCursor((c) => (c + 1) % questions.length)}
            >
              {/* "Later", not "Skip" — nothing is being dismissed. It comes back. */}
              Answer later
              <ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>

      <p className="mt-2 text-[15px] font-medium text-amber-950">
        {HEADLINE[reason]}
        <span className="ml-2 font-normal text-amber-900">
          {reason === 'STRENGTH_NOT_STOCKED'
            ? <>You said <b>{spokenStrength}</b> for {itemTitle(item)}.</>
            : <>Heard &ldquo;<b>{spoken}</b>&rdquo;</>}
        </span>
      </p>

      {/* The words that produced the question. Real evidence or nothing — an
          uncheckable citation raises acceptance without raising accuracy. */}
      {hasSource && (
        <blockquote className="mt-2 rounded-md border-l-2 border-amber-400 bg-white/70 px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            Spoken{item.sourceStart != null ? ` · ${item.sourceStart.toFixed(0)}s – ${(item.sourceEnd ?? item.sourceStart).toFixed(0)}s` : ''}
          </span>
          <p className="text-sm italic text-amber-950">&ldquo;{item.sourceText}&rdquo;</p>
        </blockquote>
      )}

      <div className="mt-2.5 space-y-1.5">
        {reason === 'STRENGTH_NOT_STOCKED' ? (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {/* "Keep what I said" is FIRST and is the default. The doctor is the
                prescriber; our catalogue being incomplete is our problem. */}
            <button
              type="button" onClick={keepAsSpoken}
              className="rounded-md border-2 border-amber-500 bg-white px-3 py-2 text-left text-sm hover:bg-amber-100/60"
            >
              <span className="font-semibold">Keep {spokenStrength}</span>
              <span className="block text-xs text-muted-foreground">prints exactly as you said it</span>
            </button>
            {candidates.slice(0, 1).map((c) => (
              <button
                key={c.medicationId} type="button" onClick={() => choose(c)}
                className="rounded-md border bg-white px-3 py-2 text-left text-sm hover:border-primary/50 hover:bg-accent"
              >
                <span className="font-semibold">Use {c.strength}{c.strengthUnit ?? ''}</span>
                <span className="block text-xs text-muted-foreground">the strength on the list</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {candidates.map((c) => (
              <button
                key={c.medicationId} type="button" onClick={() => choose(c)}
                className="block w-full rounded-md border bg-white px-3 py-2 text-left text-sm transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* Full name, never truncated: two similar entries must be told
                    apart by reading, not by position in a list. */}
                <span className="font-medium">{c.canonicalName}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>{[c.brandName, c.dosageForm, c.route].filter(Boolean).join(' · ') || 'no form recorded'}</span>
                  {/* A fact about this clinic's own history, not a recommendation. */}
                  {c.usageCount > 0 && (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                      used {c.usageCount}×
                    </Badge>
                  )}
                </span>
              </button>
            ))}

            <div className="relative pt-0.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the medicine list…" className="h-9 bg-white pl-8"
                aria-label="Search medicines"
              />
              {searching && <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true" />}
            </div>
            {results.length > 0 && (
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {results.map((c) => (
                  <li key={c.medicationId}>
                    <button
                      type="button" onClick={() => choose(c)}
                      className="w-full rounded-md border bg-white px-3 py-2 text-left text-sm hover:border-primary/50 hover:bg-accent"
                    >
                      <span className="font-medium">{c.canonicalName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {[c.brandName, c.dosageForm].filter(Boolean).join(' · ') || 'no form recorded'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <Button
              type="button" variant="outline" size="sm"
              className="h-8 w-full justify-start bg-white sm:w-auto"
              onClick={keepAsSpoken}
            >
              <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Keep &ldquo;{spoken}&rdquo; as written
            </Button>
          </>
        )}
      </div>

      {questions.length > 1 && (
        <p className="mt-2.5 flex items-center gap-1.5 text-xs text-amber-800">
          <Quote className="h-3 w-3" aria-hidden="true" />
          {questions.length - 1} more after this. Signing stays disabled until all are answered.
        </p>
      )}
    </section>
  );
}
