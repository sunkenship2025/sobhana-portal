/**
 * The editors that make the builder a builder: what fills each blank in a message, who a
 * message goes to, what starts a journey and how often, and when it stops.
 *
 * Every list on these screens is SERVED — fields, triggers, recipients, conditions — so a
 * new one is a backend entry and this file does not change. Every choice is worded as the
 * owner would say it, and every choice shows what it will actually do.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConditionBuilder } from './ConditionBuilder';
import { describeCondition } from './describe';
import { fitBlanks } from './editSteps';
import {
  listFields, listRecipients, listTriggers, listPredicates,
  type ParamBinding, type TemplateSummary, type Recipients, type AutomationDefinition,
  type Condition, type FieldMeta, type TriggerMeta,
} from './api';

const GROUP_ORDER: FieldMeta['group'][] = ['Patient', 'Visit', 'Offer', 'Centre', 'Other'];

// ── What fills each blank ───────────────────────────────────────────────────

export function BlanksEditor({ template, params, onChange, journeyHasOffer }: {
  template?: TemplateSummary;
  params: ParamBinding[];
  onChange: (params: ParamBinding[]) => void;
  /** Offer fields only make sense if something in the journey issues an offer. */
  journeyHasOffer: boolean;
}) {
  const { data } = useQuery({ queryKey: ['fields'], queryFn: listFields });
  const fields = data?.fields ?? [];
  if (!template) return null;

  const blanks = fitBlanks(params, template.paramCount);
  const set = (i: number, b: ParamBinding) => onChange(blanks.map((x, j) => (j === i ? b : x)));
  const exampleOf = (b: ParamBinding) =>
    b.from === 'LITERAL' ? (b.value || '…') : fields.find((f) => f.from === b.from)?.example;

  // The message as the patient will read it, with each blank showing what goes there.
  const parts = template.bodyText.split(/(\{\{\d+\}\})/g);

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What they will read
        </p>
        <div className="rounded-lg bg-[#e6ded5] p-3">
          <div className="whitespace-pre-wrap rounded-lg rounded-bl-sm bg-white px-3 py-2 text-[13px] leading-relaxed shadow-sm">
            {parts.map((part, k) => {
              const m = /^\{\{(\d+)\}\}$/.exec(part);
              if (!m) return <span key={k}>{part}</span>;
              const b = blanks[Number(m[1]) - 1];
              const ex = b ? exampleOf(b) : undefined;
              return (
                <span key={k} className={`rounded px-1 ${ex ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
                  {ex ?? `blank ${m[1]}`}
                </span>
              );
            })}
          </div>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Green shows an example of what will be filled in.</p>
      </div>

      {blanks.length > 0 && (
        <div>
          <Label className="text-xs">Fill in the blanks</Label>
          <div className="mt-1.5 divide-y rounded-lg border">
            {blanks.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="w-16 shrink-0 text-xs text-muted-foreground">Blank {i + 1}</span>
                <Select value={b.from || undefined}
                  onValueChange={(v) => set(i, v === 'LITERAL' ? { from: v, value: b.value ?? '' } : { from: v })}>
                  <SelectTrigger className="h-8 min-w-0 flex-1"><SelectValue placeholder="Choose what goes here" /></SelectTrigger>
                  <SelectContent>
                    {GROUP_ORDER.map((g) => {
                      const inGroup = fields.filter((f) => f.group === g);
                      if (inGroup.length === 0) return null;
                      return (
                        <SelectGroup key={g}>
                          <SelectLabel>{g}</SelectLabel>
                          {inGroup.map((f) => (
                            <SelectItem key={f.from} value={f.from} disabled={f.needsOffer && !journeyHasOffer}>
                              {f.label} — <span className="text-muted-foreground">{f.example}</span>
                              {f.needsOffer && !journeyHasOffer && ' (add an offer to this journey first)'}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      );
                    })}
                  </SelectContent>
                </Select>
                {b.from === 'LITERAL' && (
                  <Input className="h-8 w-full" placeholder="Type the text — never a test name or result"
                    value={b.value ?? ''} onChange={(e) => set(i, { from: 'LITERAL', value: e.target.value })} />
                )}
              </div>
            ))}
          </div>
          {params.length !== blanks.length && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              This template has {template.paramCount} blank{template.paramCount === 1 ? '' : 's'}; the list above matches it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Who gets it ─────────────────────────────────────────────────────────────

const ROLES: { value: 'owner' | 'lab_incharge' | 'staff' | 'sales'; label: string }[] = [
  { value: 'owner', label: 'Owners' },
  { value: 'lab_incharge', label: 'Lab in-charges' },
  { value: 'staff', label: 'Front-desk staff' },
  { value: 'sales', label: 'Sales team' },
];

type Who = 'PATIENT' | 'ROLE' | 'PEOPLE' | 'DOCTOR';

export function RecipientsPicker({ to, onChange }: {
  to?: Recipients;
  onChange: (to: Recipients | undefined) => void;
}) {
  const { data } = useQuery({ queryKey: ['recipients'], queryFn: listRecipients });
  const people = data?.recipients ?? [];
  const who: Who = !to || to.kind === 'RUN_PATIENT' ? 'PATIENT'
    : to.kind === 'REFERRING_DOCTOR' ? 'DOCTOR'
    : to.userIds && to.userIds.length > 0 ? 'PEOPLE' : 'ROLE';
  const chosen = to?.kind === 'USERS' ? (to.userIds ?? []) : [];

  return (
    <div>
      <Label className="text-xs">Who gets it</Label>
      <Select value={who} onValueChange={(v) => onChange(
        v === 'PATIENT' ? undefined
          : v === 'DOCTOR' ? { kind: 'REFERRING_DOCTOR' }
          : v === 'ROLE' ? { kind: 'USERS', role: 'owner' }
          : { kind: 'USERS', userIds: [] },
      )}>
        <SelectTrigger className="mt-1.5 h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="PATIENT">The patient</SelectItem>
          <SelectItem value="DOCTOR">The doctor who referred them</SelectItem>
          <SelectItem value="ROLE">Everyone on my team with a role</SelectItem>
          <SelectItem value="PEOPLE">Specific people on my team</SelectItem>
        </SelectContent>
      </Select>

      {who === 'ROLE' && to?.kind === 'USERS' && (
        <Select value={to.role ?? 'owner'} onValueChange={(v) => onChange({ kind: 'USERS', role: v as typeof ROLES[number]['value'] })}>
          <SelectTrigger className="mt-2 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      {who === 'PEOPLE' && (
        people.length === 0 ? (
          <p className="mt-2 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
            Nobody on your team has a phone number yet. Add one in Roles.
          </p>
        ) : (
          <div className="mt-2 max-h-48 divide-y overflow-y-auto rounded-lg border">
            {people.map((r) => (
              <label key={r.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                <input type="checkbox" checked={chosen.includes(r.id)}
                  onChange={() => onChange({
                    kind: 'USERS',
                    userIds: chosen.includes(r.id) ? chosen.filter((x) => x !== r.id) : [...chosen, r.id],
                  })} />
                <span className="min-w-0 flex-1">
                  <span className="block">{r.name}</span>
                  <span className="block text-xs text-muted-foreground">{r.role} · {r.phone}</span>
                </span>
              </label>
            ))}
          </div>
        )
      )}

      <p className="mt-1.5 text-xs text-muted-foreground">
        {who === 'PATIENT'
          ? 'Consent, sending hours (8 AM–9 PM) and the weekly limit apply.'
          : who === 'DOCTOR'
            ? 'Only visits referred by a doctor with a phone number get this — a self visit is skipped.'
            : 'Goes straight away: patient rules like sending hours do not apply to your own team.'}
      </p>
    </div>
  );
}

// ── What starts it, and how often ───────────────────────────────────────────

export function WhenDrawer({ open, definition, onClose, onSave }: {
  open: boolean;
  definition: AutomationDefinition;
  onClose: () => void;
  onSave: (patch: Pick<AutomationDefinition, 'trigger' | 'reentry' | 'past' | 'dailyLimit'>) => void;
}) {
  const { data } = useQuery({ queryKey: ['triggers'], queryFn: listTriggers, enabled: open });
  const triggers = data?.triggers ?? [];
  const [trigger, setTrigger] = useState<Record<string, unknown>>(definition.trigger as Record<string, unknown>);
  const [reentry, setReentry] = useState(definition.reentry);
  const [past, setPast] = useState(definition.past);
  const [dailyLimit, setDailyLimit] = useState(definition.dailyLimit);
  const [seen, setSeen] = useState('');
  // Reopening shows what is saved, not what was abandoned last time.
  const key = JSON.stringify([definition.trigger, definition.reentry, definition.past, definition.dailyLimit]);
  if (open && seen !== key) {
    setSeen(key); setTrigger(definition.trigger as Record<string, unknown>); setReentry(definition.reentry);
    setPast(definition.past); setDailyLimit(definition.dailyLimit);
  }
  // The last day a past window may end on: anything from today is a new one.
  const yesterday = new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  // The server's own words, said here before Done rather than at Activate.
  const pastProblem = !past ? null
    : !past.from || !past.to ? 'Choose the first and the last day.'
      : past.from > past.to ? 'The first day is after the last day.'
        : past.to > yesterday ? 'The last day has to be before today.'
          : null;

  const picked = triggers.find((t) => t.kind === trigger.kind);
  const choose = (t: TriggerMeta) => {
    const next: Record<string, unknown> = { kind: t.kind };
    for (const f of t.fields) next[f.key] = trigger.kind === t.kind ? (trigger[f.key] ?? f.default) : f.default;
    setTrigger(next);
  };
  const groups = [...new Set(triggers.map((t) => t.group))];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="pb-4">
          <SheetTitle className="text-[15px]">What starts it</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
              <div className="divide-y rounded-lg border">
                {triggers.filter((t) => t.group === g).map((t) => (
                  <button key={t.kind} type="button" onClick={() => choose(t)}
                    className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 ${trigger.kind === t.kind ? 'bg-muted' : ''}`}>
                    <span aria-hidden className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-[3px] ${trigger.kind === t.kind ? 'border-foreground' : 'border-muted-foreground/40'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{t.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{t.help}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {picked && picked.fields.length > 0 && (
            <div className="space-y-3 rounded-lg border p-3">
              {picked.fields.map((f) => (
                <div key={f.key}>
                  <Label className="text-xs">{f.label}</Label>
                  {f.type === 'CHOICE' ? (
                    <div className="mt-1.5 divide-y rounded-lg border">
                      {(f.options ?? []).map((o) => (
                        <button key={o.value} type="button" onClick={() => setTrigger({ ...trigger, [f.key]: o.value })}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50">
                          <span aria-hidden className={`h-3.5 w-3.5 shrink-0 rounded-full border-[3px] ${trigger[f.key] === o.value ? 'border-foreground' : 'border-muted-foreground/40'}`} />
                          {o.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Input className="mt-1.5 w-28" value={String(trigger[f.key] ?? '')}
                      onChange={(e) => setTrigger({ ...trigger, [f.key]: e.target.value === '' ? '' : Number(e.target.value) })} />
                  )}
                </div>
              ))}
            </div>
          )}

          {picked && !picked.periodic && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Which ones</p>
              <div className="space-y-2 rounded-lg border p-3 text-sm">
                <label className="flex items-center gap-2.5">
                  <input type="radio" checked={!past} onChange={() => setPast(undefined)} />
                  <span>New ones, from when it is switched on</span>
                </label>
                <label className="flex items-start gap-2.5">
                  <input type="radio" className="mt-1" checked={!!past} onChange={() => setPast(past ?? { from: '', to: '' })} />
                  <span className="min-w-0 flex-1">
                    Past ones only, once
                    <span className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Input type="date" className="h-7 w-36" max={past?.to || yesterday} value={past?.from ?? ''} disabled={!past}
                        onChange={(e) => setPast({ from: e.target.value, to: past?.to ?? '' })} />
                      <span>to</span>
                      <Input type="date" className="h-7 w-36" min={past?.from || undefined} max={yesterday} value={past?.to ?? ''} disabled={!past}
                        onChange={(e) => setPast({ from: past?.from ?? '', to: e.target.value })} />
                    </span>
                    {pastProblem
                      ? <span className="mt-1 block text-xs text-destructive">{pastProblem}</span>
                      : (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Each one is reached as if it happened today, so day 0 is the day they hear from you.
                          Nothing new is picked up.
                        </span>
                      )}
                  </span>
                </label>
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">How often</p>
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              {([['PER_EVENT', 'Every time it happens'], ['ONCE', 'Only once per patient, ever'], ['EVERY_N_DAYS', 'At most once per patient every']] as const).map(([mode, label]) => (
                <label key={mode} className="flex items-center gap-2.5">
                  <input type="radio" checked={reentry.mode === mode}
                    onChange={() => setReentry({ ...reentry, mode, days: mode === 'EVERY_N_DAYS' ? (reentry.days ?? 90) : undefined })} />
                  <span>{label}</span>
                  {mode === 'EVERY_N_DAYS' && (
                    <>
                      <Input className="h-7 w-16" value={reentry.days ?? 90} disabled={reentry.mode !== 'EVERY_N_DAYS'}
                        onChange={(e) => setReentry({ ...reentry, mode: 'EVERY_N_DAYS', days: Number(e.target.value) || 1 })} />
                      <span>days</span>
                    </>
                  )}
                </label>
              ))}
              <label className="flex items-center gap-2.5 border-t pt-2">
                <input type="checkbox" checked={reentry.concurrency === 'ONE_ACTIVE_PER_PATIENT'}
                  onChange={(e) => setReentry({ ...reentry, concurrency: e.target.checked ? 'ONE_ACTIVE_PER_PATIENT' : 'ALLOW_PARALLEL' })} />
                <span>Only one running per patient at a time</span>
              </label>
              <label className="flex items-center gap-2.5">
                <input type="checkbox" checked={!!dailyLimit} onChange={(e) => setDailyLimit(e.target.checked ? 100 : undefined)} />
                <span>Start at most</span>
                <Input className="h-7 w-16" value={dailyLimit ?? 100} disabled={!dailyLimit}
                  onChange={(e) => setDailyLimit(Number(e.target.value) || 1)} />
                <span>journeys a day — the rest start the next day</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!picked || !!pastProblem}
              onClick={() => onSave({
                trigger: trigger as AutomationDefinition['trigger'], reentry,
                past: picked?.periodic ? undefined : past, dailyLimit,
              })}>Done</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── When it stops ───────────────────────────────────────────────────────────

export function GoalDrawer({ open, goal, onClose, onSave }: {
  open: boolean;
  goal: AutomationDefinition['goal'];
  onClose: () => void;
  onSave: (goal: AutomationDefinition['goal']) => void;
}) {
  const { data } = useQuery({ queryKey: ['predicates'], queryFn: listPredicates, enabled: open });
  const catalog = data?.predicates ?? [];
  const [on, setOn] = useState(!!goal);
  const [condition, setCondition] = useState<Condition>(goal?.condition ?? { fn: 'testDoneSinceThisVisit' });
  const [days, setDays] = useState(goal?.windowDays ?? 14);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState('');
  const key = JSON.stringify(goal ?? null);
  if (open && seen !== key) {
    setSeen(key); setOn(!!goal);
    setCondition(goal?.condition ?? { fn: 'testDoneSinceThisVisit' }); setDays(goal?.windowDays ?? 14);
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="pb-4">
          <SheetTitle className="text-[15px]">When it stops</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-2.5 rounded-lg border p-3">
            <input type="radio" className="mt-1" checked={!on} onChange={() => setOn(false)} />
            <span>
              After the last step
              <span className="mt-0.5 block text-xs text-muted-foreground">Every step runs. Right for alerts to your team.</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 rounded-lg border p-3">
            <input type="radio" className="mt-1" checked={on} onChange={() => setOn(true)} />
            <span className="min-w-0 flex-1">
              As soon as something happens
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Checked before every step — e.g. stop reminding once they have come back. This is also what
                Results counts as the journey working.
              </span>
              {on && (
                <span className="mt-2 block space-y-2">
                  <button type="button" onClick={() => setEditing(true)}
                    className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-muted/50">
                    <span className="min-w-0 flex-1 first-letter:uppercase">{describeCondition(condition, catalog)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">Change</span>
                  </button>
                  <span className="flex items-center gap-2">
                    Keep checking for
                    <Input className="h-7 w-16" value={days} onChange={(e) => setDays(Number(e.target.value) || 1)} />
                    days after it starts
                  </span>
                </span>
              )}
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => onSave(on ? { condition, windowDays: days, stopReason: 'STOPPED_GOAL_MET' } : undefined)}>Done</Button>
          </div>
        </div>

        <ConditionBuilder open={editing} condition={condition} title="Stop as soon as"
          subtitle="All of these must be true."
          onClose={() => setEditing(false)}
          onSave={(c) => { setCondition(c); setEditing(false); }} />
      </SheetContent>
    </Sheet>
  );
}
