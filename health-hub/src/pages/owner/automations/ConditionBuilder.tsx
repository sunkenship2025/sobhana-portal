/**
 * Who qualifies — ALL of these, and optionally ANY of these.
 *
 * Enough for "adults on visits over ₹300, who have either not had tests since this
 * visit or not had one in 90 days" without a segment builder. The field list is served
 * by the backend, so a condition can never name a predicate the engine does not have.
 *
 * SCOPE IS SHOWN, NEVER ASSUMED. "since this visit" versus "ever" is the difference
 * between chasing a patient who never went and one who went last year, and a hidden
 * default is how a recovery journey quietly messages people who already came.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { listPredicates, type Condition, type Op, type PredicateMeta } from './api';

type Leaf = Extract<Condition, { fn: string }>;

/** The editor works on two flat groups; anything richer round-trips untouched. */
function toGroups(c: Condition): { all: Leaf[]; any: Leaf[] } {
  const out = { all: [] as Leaf[], any: [] as Leaf[] };
  if ('all' in c) {
    for (const child of c.all) {
      if ('any' in child) out.any.push(...(child.any.filter((x) => 'fn' in x) as Leaf[]));
      else if ('fn' in child) out.all.push(child);
    }
  } else if ('any' in c) {
    out.any.push(...(c.any.filter((x) => 'fn' in x) as Leaf[]));
  } else if ('fn' in c) {
    out.all.push(c);
  }
  return out;
}

function fromGroups(g: { all: Leaf[]; any: Leaf[] }): Condition {
  const parts: Condition[] = [...g.all];
  if (g.any.length > 0) parts.push({ any: g.any });
  if (parts.length === 0) return { fn: 'always' };
  if (parts.length === 1) return parts[0];
  return { all: parts };
}

const OPS: { value: Op; label: string; for: PredicateMeta['returns'][] }[] = [
  { value: 'gte', label: 'is at least', for: ['NUMBER'] },
  { value: 'lte', label: 'is at most', for: ['NUMBER'] },
  { value: 'gt', label: 'is more than', for: ['NUMBER'] },
  { value: 'lt', label: 'is less than', for: ['NUMBER'] },
  { value: 'eq', label: 'is', for: ['NUMBER', 'TEXT'] },
  { value: 'ne', label: 'is not', for: ['NUMBER', 'TEXT'] },
  { value: 'in', label: 'is one of', for: ['TEXT'] },
];

function displayValue(leaf: Leaf, meta?: PredicateMeta): string {
  if (leaf.value === undefined || leaf.value === null) return '';
  if (meta?.unit === 'RUPEES') return String(Math.round(Number(leaf.value) / 100));
  return String(leaf.value);
}

function parseValue(raw: string, meta?: PredicateMeta): number | string {
  if (meta?.returns === 'TEXT') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return meta?.unit === 'RUPEES' ? Math.round(n * 100) : n;
}

export function ConditionBuilder({ open, condition, matchCount, onClose, onSave }: {
  open: boolean;
  condition: Condition;
  matchCount?: { visits: number; patients: number };
  onClose: () => void;
  onSave: (c: Condition) => void;
}) {
  const { data } = useQuery({ queryKey: ['predicates'], queryFn: listPredicates, enabled: open });
  const catalog = data?.predicates ?? [];
  // Keyed on the condition it was opened with: initialising once meant Cancel did not
  // discard, and a second CHECK opened showing the first one's conditions.
  const [groups, setGroups] = useState(() => toGroups(condition));
  const [key, setKey] = useState('');
  const openedWith = JSON.stringify(condition);
  if (open && key !== openedWith) { setKey(openedWith); setGroups(toGroups(condition)); }

  const metaOf = (fn: string) => catalog.find((p) => p.fn === fn);

  const update = (which: 'all' | 'any', i: number, patch: Partial<Leaf>) =>
    setGroups((g) => ({
      ...g,
      [which]: g[which].map((leaf, j) => (j === i ? { ...leaf, ...patch } : leaf)),
    }));

  const remove = (which: 'all' | 'any', i: number) =>
    setGroups((g) => ({ ...g, [which]: g[which].filter((_, j) => j !== i) }));

  const add = (which: 'all' | 'any', meta: PredicateMeta) =>
    setGroups((g) => ({
      ...g,
      [which]: [
        ...g[which],
        meta.returns === 'BOOLEAN'
          ? { fn: meta.fn }
          : { fn: meta.fn, op: 'gte' as Op, value: 0 },
      ],
    }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Who qualifies</DialogTitle>
          <DialogDescription>
            {matchCount
              ? `${matchCount.visits.toLocaleString('en-IN')} qualifying visits · ${matchCount.patients.toLocaleString('en-IN')} patients right now`
              : 'Everyone the trigger catches, narrowed by these.'}
          </DialogDescription>
        </DialogHeader>

        <div>
          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between bg-muted px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                All of these
              </span>
              <FieldPicker catalog={catalog} onPick={(m) => add('all', m)} />
            </div>
            {groups.all.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                No conditions — everyone the trigger catches qualifies.
              </p>
            ) : groups.all.map((leaf, i) => (
              <Row key={`all-${i}`} which="all" leaf={leaf} i={i}
                meta={metaOf(leaf.fn)} update={update} remove={remove} />
            ))}
          </div>

          {groups.any.length > 0 && (
            <>
              <p className="py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                And
              </p>
              <div className="overflow-hidden rounded-lg border">
                <div className="flex items-center justify-between bg-muted px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Any of these
                  </span>
                  <FieldPicker catalog={catalog} onPick={(m) => add('any', m)} />
                </div>
                {groups.any.map((leaf, i) => (
                  <Row key={`any-${i}`} which="any" leaf={leaf} i={i}
                    meta={metaOf(leaf.fn)} update={update} remove={remove} />
                ))}
              </div>
            </>
          )}

          {groups.any.length === 0 && (
            <div className="mt-2">
              <FieldPicker catalog={catalog} onPick={(m) => add('any', m)}
                trigger={
                  <button className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                    + Add an “any of these” group
                  </button>
                } />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(fromGroups(groups))}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hoisted OUT of ConditionBuilder. Declared inside it, every render produced a new
 * component type, so React unmounted and remounted this row on each keystroke and the
 * value input lost focus after every character. tsc and the rules-of-hooks lint both
 * pass on that — it only shows up if someone types in it.
 */
function Row({ which, leaf, i, meta, update, remove }: {
  which: 'all' | 'any'; leaf: Leaf; i: number;
  meta?: PredicateMeta;
  update: (which: 'all' | 'any', i: number, patch: Partial<Leaf>) => void;
  remove: (which: 'all' | 'any', i: number) => void;
}) {
  const ops = OPS.filter((o) => meta && o.for.includes(meta.returns));
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5 first:border-t-0">
      <span className="text-sm font-medium">{meta?.label ?? leaf.fn}</span>
      {meta?.scope && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {meta.scope}
        </span>
      )}
      {meta && meta.returns !== 'BOOLEAN' && (
        <>
          <Select value={leaf.op ?? 'gte'}
            onValueChange={(v) => update(which, i, { op: v as Op })}>
            <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ops.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            className="h-8 w-24"
            value={displayValue(leaf, meta)}
            onChange={(e) => update(which, i, { value: parseValue(e.target.value, meta) })}
          />
          {meta.unit && (
            <span className="text-xs text-muted-foreground">
              {meta.unit === 'RUPEES' ? 'rupees' : meta.unit === 'DAYS' ? 'days' : 'years'}
            </span>
          )}
        </>
      )}
      <span className="flex-1" />
      <button onClick={() => remove(which, i)}
        className="text-muted-foreground hover:text-destructive" aria-label="Remove">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
  }

/** Search-first, because a permanently visible field tree reads like a database. */
function FieldPicker({ catalog, onPick, trigger }: {
  catalog: PredicateMeta[];
  onPick: (m: PredicateMeta) => void;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const hit = catalog.filter(
      (p) => q === '' || p.label.toLowerCase().includes(q.toLowerCase()) ||
             p.group.toLowerCase().includes(q.toLowerCase()),
    );
    return ['Diagnostics', 'Visit', 'Patient', 'Money']
      .map((g) => ({ group: g, items: hit.filter((p) => p.group === g) }))
      .filter((g) => g.items.length > 0);
  }, [catalog, q]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="relative border-b">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="What do you want to check?"
            className="w-full bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.group}>
              <p className="bg-muted px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {g.group}
              </p>
              {g.items.map((p) => (
                <button key={p.fn}
                  onClick={() => { onPick(p); setOpen(false); setQ(''); }}
                  className="block w-full px-3 py-2 text-left hover:bg-muted/60">
                  <span className="block text-sm">
                    {p.label}
                    {p.scope && <span className="ml-1.5 text-xs text-muted-foreground">{p.scope}</span>}
                  </span>
                  {p.help && (
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{p.help}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
