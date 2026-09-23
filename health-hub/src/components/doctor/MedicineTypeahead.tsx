/**
 * Medicine typeahead — search the catalogue as you type, and write freely.
 *
 * TWO RULES, AND THEY PULL AGAINST EACH OTHER
 *
 * 1. Enter NEVER selects a suggestion. The single best-evidenced error in
 *    e-prescribing is juxtaposition — 18 of 23 prescribers reported having
 *    picked the entry next to the one they meant. So the top hit is never
 *    pre-highlighted, and pressing Enter adds EXACTLY what was typed. Choosing a
 *    catalogue entry takes a deliberate arrow-down or a click.
 *
 * 2. Free text is a first-class outcome, not a fallback. The doctor is the
 *    prescriber; our catalogue being incomplete is our problem, not theirs. What
 *    they typed is always offered as the first row, always accepted, and prints
 *    exactly as written. It is flagged UNRESOLVED so the validator asks once —
 *    and "Keep as written" clears that in a click.
 *
 * Full names, never truncated: generic + strength + form on every row, so two
 * similar entries are told apart by reading rather than by position.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Search, Loader2, PenLine, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { doctorApi, type MedicationCandidate } from '@/lib/doctorApi';

interface Props {
  /** Chosen from the catalogue. */
  onSelect: (c: MedicationCandidate) => void;
  /** Typed and accepted as-is. */
  onFreeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

export function MedicineTypeahead({ onSelect, onFreeText, placeholder, autoFocus, className }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MedicationCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  /** -1 means "nothing highlighted" — the deliberate default. */
  const [cursor, setCursor] = useState(-1);
  const timer = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const typed = q.trim();
    if (typed.length < 2) { setResults([]); setOpen(false); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const r = await doctorApi.searchMedications(typed, 'search');
        setResults(r.candidates);
        setOpen(true);
        // Reset to "nothing highlighted" on every new result set. A cursor that
        // survives a keystroke is how you select the wrong row.
        setCursor(-1);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  // Close on an outside click, so the list never lingers over the editor.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const reset = useCallback(() => { setQ(''); setResults([]); setOpen(false); setCursor(-1); }, []);

  const take = useCallback((c: MedicationCandidate) => { onSelect(c); reset(); }, [onSelect, reset]);
  const takeTyped = useCallback(() => {
    const t = q.trim();
    if (!t) return;
    onFreeText(t);
    reset();
  }, [q, onFreeText, reset]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
        setCursor((c) => Math.min(c + 1, results.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, -1));
        return;
      }
      if (e.key === 'Escape') { setOpen(false); setCursor(-1); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        // Only a DELIBERATELY highlighted row is selected. Otherwise Enter takes
        // what was typed, verbatim.
        if (cursor >= 0 && results[cursor]) take(results[cursor]);
        else takeTyped();
      }
      // Tab is left alone entirely — it moves focus, it does not commit a drug.
    },
    [cursor, results, take, takeTyped],
  );

  const typed = q.trim();

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        autoFocus={autoFocus}
        placeholder={placeholder ?? 'Type a medicine — brand or molecule'}
        className="h-9 pl-8"
        aria-label="Add a medicine"
        aria-autocomplete="list"
        aria-expanded={open}
        role="combobox"
      />
      {searching && <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true" />}

      {open && typed.length >= 2 && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          {/* Free text, always first and always available. Not a last resort. */}
          <button
            type="button"
            onClick={takeTyped}
            className={cn(
              'flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
              cursor === -1 && 'bg-accent/50',
            )}
          >
            <PenLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              Write <span className="font-semibold">&ldquo;{typed}&rdquo;</span> as typed
            </span>
            <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>

          {results.length > 0 ? (
            <ul className="max-h-72 overflow-y-auto" role="listbox">
              {results.map((c, i) => (
                <li key={c.medicationId} role="option" aria-selected={cursor === i}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => take(c)}
                    className={cn(
                      'w-full px-3 py-2 text-left text-sm transition-colors',
                      cursor === i ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    {/* Full name, never truncated — two similar entries must be
                        told apart by reading, not by position in a list. */}
                    <span className="block font-medium leading-snug">{c.canonicalName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[c.brandName, c.dosageForm, c.route].filter(Boolean).join(' · ') || 'no form recorded'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : !searching ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Not in the medicine list — press Enter to write it as typed.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
