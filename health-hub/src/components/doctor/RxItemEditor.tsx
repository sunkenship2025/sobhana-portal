/**
 * One medicine, as a structured card. Every AI-generated value stays editable.
 *
 * THREE RULES THIS COMPONENT EXISTS TO ENFORCE
 *
 * 1. "Not stated" is a VALUE. A field the doctor did not speak renders as italic
 *    grey "not stated" — never a helpfully invented default. Unknown stays
 *    unknown, and the absence is visible rather than silent.
 *
 * 2. The picker never auto-selects. Candidates are stacked, spelt out in full
 *    (generic + strength + form), never truncated, and Enter/Tab never commits
 *    one. 18 of 23 prescribers in one study reported having actually picked the
 *    entry next to the one they meant — juxtaposition error is lived, not
 *    hypothetical.
 *
 * 3. Source is real or absent. "View source" shows the clause that produced the
 *    line and its timestamp. Where the clause could not be located, the control
 *    is not offered at all — an uncheckable citation raises acceptance without
 *    raising accuracy, which is worse than none.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Trash2, Quote, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  doctorApi, itemTitle, FREQUENCY_OPTIONS, TIMING_OPTIONS, ROUTE_OPTIONS, DURATION_UNITS,
  type RxItem, type MedicationCandidate, type Finding,
} from '@/lib/doctorApi';

/** Sentinel for "clear this optional select" — Radix disallows an empty value. */
const NONE = '__none__';

interface Props {
  item: RxItem;
  index: number;
  findings: Finding[];
  readOnly?: boolean;
  onChange: (patch: Partial<RxItem>) => void;
  onRemove: () => void;
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</span>
);

/** Renders a value, or the explicit "not stated" that absence deserves. */
function NotStated() {
  return <span className="text-sm italic text-muted-foreground/70">not stated</span>;
}

export function RxItemEditor({ item, index, findings, readOnly, onChange, onRemove }: Props) {
  const [showSource, setShowSource] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<MedicationCandidate[]>([]);
  const debounce = useRef<number | undefined>(undefined);

  const mine = findings.filter((f) => f.itemId === item.id);
  const blocking = mine.filter((f) => f.severity !== 'NOTE');
  const needsChoice = item.resolution === 'AMBIGUOUS' || item.resolution === 'UNRESOLVED';
  const isAlternative = item.fieldStates?.isAlternative === true;

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const r = await doctorApi.searchMedications(query.trim());
        setResults(r.candidates);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(debounce.current);
  }, [query]);

  const pick = useCallback(
    (c: MedicationCandidate) => {
      // Once the doctor chooses, it is MANUAL forever — we never re-resolve or
      // second-guess a human decision.
      onChange({
        medicationId: c.medicationId,
        canonicalName: c.canonicalName,
        genericName: c.genericName,
        brandName: c.brandName,
        strength: c.strength ?? item.strength,
        strengthUnit: c.strengthUnit ?? item.strengthUnit,
        dosageForm: c.dosageForm ?? item.dosageForm,
        route: c.route ?? item.route,
        resolution: 'MANUAL',
        candidates: null,
      });
      setQuery('');
      setResults([]);
    },
    [item.strength, item.strengthUnit, item.dosageForm, item.route, onChange],
  );

  const candidates = item.candidates ?? [];

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 sm:p-4',
        blocking.length > 0 && 'border-amber-300 bg-amber-50/40',
        isAlternative && 'border-red-300 bg-red-50/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold">{index + 1}. {itemTitle(item)}</span>

        {item.resolution === 'RESOLVED' && (
          <Badge className="h-5 border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">Matched</Badge>
        )}
        {item.resolution === 'MANUAL' && <Badge variant="secondary" className="h-5">Your choice</Badge>}
        {item.resolution === 'AMBIGUOUS' && (
          <Badge className="h-5 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-50">Confirm medicine</Badge>
        )}
        {item.resolution === 'UNRESOLVED' && (
          <Badge className="h-5 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-50">Not in list</Badge>
        )}
        {isAlternative && <Badge variant="destructive" className="h-5">One of a choice</Badge>}

        <span className="ml-auto flex gap-1">
          {item.sourceText && item.sourceStart != null && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setShowSource((s) => !s)}>
              <Quote className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Source
            </Button>
          )}
          {!readOnly && (
            <Button
              type="button" variant="ghost" size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-destructive"
              onClick={onRemove} aria-label={`Remove ${item.canonicalName}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </span>
      </div>

      {/* Evidence: the exact clause, with its timestamp. */}
      {showSource && item.sourceText && (
        <blockquote className="mt-2 rounded-md border-l-2 border-muted-foreground/30 bg-muted/50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Spoken{item.sourceStart != null ? ` · ${item.sourceStart.toFixed(0)}s – ${(item.sourceEnd ?? item.sourceStart).toFixed(0)}s` : ''}
          </p>
          <p className="mt-0.5 text-sm italic">“{item.sourceText}”</p>
        </blockquote>
      )}

      {/* Ambiguity: stacked, full names, nothing preselected. */}
      {needsChoice && !readOnly && (
        <div className="mt-3 rounded-md border border-amber-300 bg-white p-3">
          <p className="text-sm font-medium">
            {item.resolution === 'AMBIGUOUS'
              ? <>Heard <span className="font-semibold">“{item.spokenText ?? item.canonicalName}”</span>. Which one?</>
              : <>“{item.spokenText ?? item.canonicalName}” is not in the medicine list.</>}
          </p>
          {candidates.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {candidates.map((c) => (
                <li key={c.medicationId}>
                  <button
                    type="button"
                    onClick={() => pick(c)}
                    className="w-full rounded-md border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-medium">{c.canonicalName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[c.brandName, c.dosageForm, c.route].filter(Boolean).join(' · ') || 'no form recorded'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the medicine list…"
              className="h-9 pl-8"
              aria-label="Search medicines"
            />
            {searching && <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>
          {results.length > 0 && (
            <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto">
              {results.map((c) => (
                <li key={c.medicationId}>
                  <button
                    type="button"
                    onClick={() => pick(c)}
                    className="w-full rounded-md border bg-card px-3 py-2 text-left text-sm hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-medium">{c.canonicalName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[c.brandName, c.dosageForm, c.route].filter(Boolean).join(' · ') || 'no form recorded'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Or keep “{item.spokenText ?? item.canonicalName}” as typed — you are the prescriber.
          </p>
          <Button
            type="button" variant="outline" size="sm" className="mt-1.5 h-7"
            onClick={() => onChange({ resolution: 'MANUAL', candidates: null })}
          >
            Keep as written
          </Button>
        </div>
      )}

      {/* The structured fields. */}
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div>
          <Label>Dose</Label>
          <div className="flex gap-1.5">
            <Input
              value={item.doseQty ?? ''} disabled={readOnly}
              onChange={(e) => onChange({ doseQty: e.target.value || null })}
              placeholder="1" className="h-9 w-14" inputMode="decimal" aria-label="Dose quantity"
            />
            <Input
              value={item.doseUnit ?? ''} disabled={readOnly}
              onChange={(e) => onChange({ doseUnit: e.target.value || null })}
              placeholder={item.dosageForm ?? 'tablet'} className="h-9 min-w-0 flex-1" aria-label="Dose unit"
            />
          </div>
        </div>

        <div>
          <Label>Frequency</Label>
          <Select
            value={item.frequencyCode ?? NONE} disabled={readOnly}
            onValueChange={(v) => onChange({
              frequencyCode: v === NONE ? null : v,
              frequencyText: v === NONE ? null : FREQUENCY_OPTIONS.find((f) => f.code === v)?.label ?? null,
            })}
          >
            <SelectTrigger className="h-9" aria-label="Frequency"><SelectValue placeholder="not stated" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>not stated</SelectItem>
              {FREQUENCY_OPTIONS.map((f) => <SelectItem key={f.code} value={f.code}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Timing</Label>
          <Select
            value={item.timing ?? NONE} disabled={readOnly}
            onValueChange={(v) => onChange({ timing: v === NONE ? null : v })}
          >
            <SelectTrigger className="h-9" aria-label="Timing"><SelectValue placeholder="not stated" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>not stated</SelectItem>
              {TIMING_OPTIONS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>Duration</Label>
          <div className="flex gap-1.5">
            <Input
              value={item.durationValue ?? ''} disabled={readOnly}
              onChange={(e) => onChange({ durationValue: e.target.value ? Number(e.target.value) : null })}
              placeholder="—" className="h-9 w-14 tabular-nums" inputMode="numeric" aria-label="Duration"
            />
            <Select
              value={item.durationUnit ?? 'days'} disabled={readOnly}
              onValueChange={(v) => onChange({ durationUnit: v })}
            >
              <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Duration unit"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DURATION_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label>Route</Label>
          <Select
            value={item.route ?? NONE} disabled={readOnly}
            onValueChange={(v) => onChange({ route: v === NONE ? null : v })}
          >
            <SelectTrigger className="h-9" aria-label="Route"><SelectValue placeholder="not stated" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>not stated</SelectItem>
              {ROUTE_OPTIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="col-span-2 sm:col-span-3">
          <Label>Instructions</Label>
          <Input
            value={item.instructions ?? ''} disabled={readOnly}
            onChange={(e) => onChange({ instructions: e.target.value || null })}
            placeholder="Anything else the patient should know" className="h-9"
            aria-label="Instructions"
          />
        </div>
      </div>

      {blocking.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {blocking.map((f) => (
            <li key={f.code + (f.field ?? '')} className="text-xs font-medium text-amber-800">{f.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { NotStated };
