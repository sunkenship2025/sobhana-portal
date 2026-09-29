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
import { Checkbox } from '@/components/ui/checkbox';
import { listPredicates, listTests, type ArgMeta, type Condition, type Op, type PredicateMeta } from './api';

type Leaf = Extract<Condition, { fn: string }>;

/**
 * The editor works on two flat groups; anything richer round-trips untouched. "Everyone"
 * is the absence of conditions, not one of them — kept as a leaf, adding the first real
 * condition saved "everyone and how they came".
 */
function toGroups(c: Condition): { all: Leaf[]; any: Leaf[] } {
  const out = { all: [] as Leaf[], any: [] as Leaf[] };
  const real = (x: Condition): x is Leaf => 'fn' in x && x.fn !== 'always';
  if ('all' in c) {
    for (const child of c.all) {
      if ('any' in child) out.any.push(...child.any.filter(real));
      else if (real(child)) out.all.push(child);
    }
  } else if ('any' in c) {
    out.any.push(...c.any.filter(real));
  } else if (real(c)) {
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
  if (Array.isArray(leaf.value)) return leaf.value.join(', ');
  return String(leaf.value);
}

function parseValue(raw: string, meta?: PredicateMeta, op?: Op): number | string | string[] {
  // "is one of" compares against a list; a plain string there never matched anything.
  if (meta?.returns === 'TEXT' && op === 'in') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (meta?.returns === 'TEXT') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return meta?.unit === 'RUPEES' ? Math.round(n * 100) : n;
}

export function ConditionBuilder({ open, condition, matchCount, onClose, onSave, title = 'Who qualifies', subtitle }: {
  open: boolean;
  condition: Condition;
  /** The same editor answers "who qualifies", "check whether" and "stop when". */
  title?: string;
  subtitle?: string;
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
  // A required setting left empty reads as "" and never matches — say so before Done.
  const unset = [...groups.all, ...groups.any].flatMap((leaf) => {
    const meta = metaOf(leaf.fn);
    return (meta?.args ?? [])
      .filter((a) => !a.optional && (leaf.args?.[a.key] ?? '') === '')
      .map((arg) => ({ label: meta!.label, arg }));
  });

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
          : meta.returns === 'TEXT'
            ? { fn: meta.fn, op: 'eq' as Op, value: meta.choices?.[0]?.value ?? '' }
            : { fn: meta.fn, op: 'gte' as Op, value: 0 },
      ],
    }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {matchCount
              ? `${matchCount.visits.toLocaleString('en-IN')} qualifying visits · ${matchCount.patients.toLocaleString('en-IN')} patients right now`
              : subtitle ?? 'Everyone the trigger catches, narrowed by these.'}
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
          {unset.length > 0 && (
            <span className="mr-auto self-center text-xs text-destructive">
              Choose the {unset[0].arg.label.toLowerCase()} for “{unset[0].label}”
            </span>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={unset.length > 0} onClick={() => onSave(fromGroups(groups))}>Done</Button>
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
      {meta?.args?.map((arg) => (
        <ArgControl key={arg.key} arg={arg} args={leaf.args ?? {}}
          onChange={(patch) => update(which, i, { args: clean({ ...(leaf.args ?? {}), ...patch }) })} />
      ))}
      {meta && meta.returns !== 'BOOLEAN' && (
        <>
          <Select value={leaf.op ?? (meta.returns === 'TEXT' ? 'eq' : 'gte')}
            onValueChange={(v) => {
              // Keep the value's shape in step: one value for "is", a list for "is one of".
              const op = v as Op;
              const list = Array.isArray(leaf.value) ? leaf.value.map(String) : leaf.value != null && leaf.value !== '' ? [String(leaf.value)] : [];
              const value = meta.returns !== 'TEXT' ? leaf.value : op === 'in' ? list : list[0] ?? '';
              update(which, i, { op, value });
            }}>
            <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ops.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {meta.choices ? (
            <ChoiceValue leaf={leaf} choices={meta.choices}
              onChange={(value) => update(which, i, { value })} />
          ) : (
            <Input
              className="h-8 w-24"
              value={displayValue(leaf, meta)}
              onChange={(e) => update(which, i, { value: parseValue(e.target.value, meta, leaf.op) })}
            />
          )}
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

/** Settings with nothing in them are left out, so an optional one reads as "any". */
const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

/** One setting of a condition, in the same small controls as the rest of the row. */
function ArgControl({ arg, args, onChange }: {
  arg: ArgMeta; args: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => void;
}) {
  if (arg.kind === 'TEST') return <TestPicker arg={arg} args={args} onChange={onChange} />;
  if (arg.kind === 'CHOICE') {
    const ANY = '__any';
    return (
      <Select value={String(args[arg.key] ?? ANY)}
        onValueChange={(v) => onChange({ [arg.key]: v === ANY ? undefined : v })}>
        <SelectTrigger className="h-8 w-36" aria-label={arg.label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {arg.optional && <SelectItem value={ANY}>{arg.emptyLabel}</SelectItem>}
          {arg.choices?.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {arg.label}
      <Input className="h-8 w-16" aria-label={arg.label} placeholder={arg.emptyLabel}
        value={args[arg.key] == null ? '' : String(args[arg.key])}
        onChange={(e) => {
          const n = e.target.value.trim();
          onChange({ [arg.key]: n === '' ? undefined : Math.max(1, Math.round(Number(n)) || 1) });
        }} />
      {arg.unit === 'DAYS' && 'days'}
    </span>
  );
}

/** Search the test catalog; the chosen test's name is kept beside its code for reading back. */
function TestPicker({ arg, args, onChange }: {
  arg: ArgMeta; args: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['tests', q], queryFn: () => listTests(q), enabled: open, staleTime: 60_000,
  });
  const code = args.testCode as string | undefined;
  const name = (args.testName as string | undefined) ?? code;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={`flex h-8 max-w-56 items-center rounded-md border px-3 text-left text-sm ${
          !code && !arg.optional ? 'border-destructive/50 text-muted-foreground' : ''}`}>
          <span className="truncate">{name ?? (arg.optional ? arg.emptyLabel : 'Choose a test')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="relative mb-2">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input autoFocus className="h-8 pl-7" placeholder="Search tests" value={q}
            onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="max-h-60 overflow-y-auto">
          {arg.optional && (
            <button className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => { onChange({ testCode: undefined, testName: undefined }); setOpen(false); }}>
              {arg.emptyLabel}
            </button>
          )}
          {(data?.tests ?? []).map((t) => (
            <button key={t.code} className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => { onChange({ testCode: t.code, testName: t.name }); setOpen(false); }}>
              <span className="truncate">{t.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.code}</span>
            </button>
          ))}
          {!isFetching && data && data.tests.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No test matches “{q}”.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A TEXT value from its served list: one for "is", several for "is one of". */
function ChoiceValue({ leaf, choices, onChange }: {
  leaf: Leaf; choices: { value: string; label: string }[];
  onChange: (value: string | string[]) => void;
}) {
  const labelOf = (v: unknown) => choices.find((c) => c.value === v)?.label ?? String(v);
  if (leaf.op !== 'in') {
    return (
      <Select value={String(leaf.value ?? '')} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-56"><SelectValue placeholder="Choose" /></SelectTrigger>
        <SelectContent>
          {choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  const picked = Array.isArray(leaf.value) ? leaf.value.map(String) : [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-56 items-center rounded-md border px-3 text-left text-sm">
          <span className="truncate">{picked.length ? picked.map(labelOf).join(', ') : 'Choose'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-1 p-2">
        {choices.map((c) => (
          <label key={c.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
            <Checkbox checked={picked.includes(c.value)}
              onCheckedChange={(on) => onChange(on
                ? choices.map((x) => x.value).filter((v) => v === c.value || picked.includes(v))
                : picked.filter((v) => v !== c.value))} />
            {c.label}
          </label>
        ))}
      </PopoverContent>
    </Popover>
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
