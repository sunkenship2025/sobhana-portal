/**
 * Creating one: what, then when. Two short steps before the builder opens.
 *
 * The first question is phrased as an OUTCOME, not as a category — an operator thinks
 * "they consulted but never did the tests", not "patient follow-up". Asking them to
 * learn our taxonomy first is a classification problem we invented for ourselves.
 *
 * Whatever they pick, the automation is created DISABLED with no watermark. The first
 * message this system sends needs a deliberate Activate, not a save.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { useBranchStore } from '@/store/branchStore';
import { createAutomation, listTemplates, type AutomationDefinition } from './api';

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 1350;
};

interface Kind {
  id: string;
  title: string;
  sub: string;
  group: string;
  /** A nightly report to your own team, not a patient journey. */
  scheduled?: boolean;
  build: (template: string, opts: { minutes: number; domain: 'DIAGNOSTICS' | 'CLINIC' }) => AutomationDefinition;
}

/** A follow-up that stops the moment the thing it is chasing actually happens. */
const recovery = (domain: 'CLINIC' | 'DIAGNOSTICS') => (template: string): AutomationDefinition => ({
  trigger: { kind: 'VISIT_COMPLETED', domain },
  reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
  audience: { all: [{ fn: 'patientAgeYears', op: 'gte', value: 18 }] },
  goal: { condition: { fn: 'testDoneSinceThisVisit' }, windowDays: 14, stopReason: 'STOPPED_GOAL_MET' },
  steps: [
    { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template, intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] },
    { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
  ],
});

/** The day sheet: a schedule and one action. No audience, no goal, nothing to convert. */
const report = (template: string, opts: { minutes: number; domain: 'DIAGNOSTICS' | 'CLINIC' }): AutomationDefinition => ({
  trigger: { kind: 'SCHEDULE', everyDayAtMinutes: opts.minutes },
  reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
  audience: { fn: 'always' },
  goal: { condition: { fn: 'always' }, windowDays: 1 },
  steps: [{
    kind: 'DAY_SHEET',
    domain: opts.domain,
    // Absent recipients means every active owner with a phone, which is what this has
    // always done. Narrow it afterwards on the step if someone else should get it.
    ...(template ? { template } : {}),
  }],
});

const KINDS: Kind[] = [
  {
    id: 'report',
    title: 'Send your team a regular report',
    sub: "The day's collections, every night",
    group: 'Reports to your team',
    scheduled: true,
    build: report,
  },
  {
    id: 'followup',
    title: "Follow up when something hasn't happened",
    sub: 'They consulted but never did the tests',
    group: 'Patient journeys',
    build: recovery('CLINIC'),
  },
  {
    id: 'due',
    title: 'Remind them about something due',
    sub: 'A bill still outstanding',
    group: 'Patient journeys',
    build: (template) => ({
      trigger: { kind: 'VISIT_COMPLETED', domain: 'DIAGNOSTICS' },
      reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
      audience: { all: [{ fn: 'outstandingDueInPaise', op: 'gt', value: 0 }] },
      goal: { condition: { fn: 'outstandingDueInPaise', op: 'lte', value: 0 }, windowDays: 30 },
      steps: [
        { kind: 'WAIT', anchor: 'TRIGGER', days: 7 },
        { kind: 'CHECK', condition: { fn: 'outstandingDueInPaise', op: 'lte', value: 0 },
          onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
        { kind: 'SEND', template, intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] },
        { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
      ],
    }),
  },
  {
    id: 'unopened',
    title: 'Nudge a report nobody opened',
    sub: 'The link was sent and never touched',
    group: 'Patient journeys',
    build: (template) => ({
      trigger: { kind: 'VISIT_COMPLETED', domain: 'DIAGNOSTICS' },
      reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
      audience: { all: [{ fn: 'patientAgeYears', op: 'gte', value: 18 }] },
      goal: { condition: { fn: 'reportOpened' }, windowDays: 14 },
      steps: [
        { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
        { kind: 'CHECK', condition: { fn: 'reportOpened' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
        { kind: 'SEND', template, intent: 'REACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] },
        { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
      ],
    }),
  },
];

export function CreateAutomation({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<Kind>(KINDS[0]);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [sendAt, setSendAt] = useState('22:30');
  const [domain, setDomain] = useState<'DIAGNOSTICS' | 'CLINIC'>('DIAGNOSTICS');
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const branches = useBranchStore((st) => st.branches);

  const { data } = useQuery({ queryKey: ['templates'], queryFn: listTemplates, enabled: open });
  const approved = (data?.templates ?? []).filter((t) => t.status === 'APPROVED');

  const create = useMutation({
    mutationFn: () => createAutomation({
      key: `${kind.id.toUpperCase()}_${Date.now().toString(36).toUpperCase()}`,
      name: name.trim() || kind.title,
      group: kind.group,
      definition: kind.build(template, { minutes: toMinutes(sendAt), domain }),
      // A report to your own team has nobody to hold back.
      holdoutPct: kind.scheduled ? 0 : 10,
      branchIds: kind.scheduled ? branchIds : [],
    }),
    onSuccess: (a) => {
      toast.success('Created as a draft. Nothing sends until you activate it.');
      reset();
      onCreated(a.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = () => {
    setStep(1); setName(''); setTemplate(''); setKind(KINDS[0]);
    setSendAt('22:30'); setDomain('DIAGNOSTICS'); setBranchIds([]);
  };

  const toggleBranch = (id: string) =>
    setBranchIds((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === 1 ? 'Create automation' : 'Name it and pick the message'}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? 'What do you want to automate?'
              : 'It is created as a draft — you can change every step before activating.'}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="divide-y rounded-lg border">
            {KINDS.map((k) => (
              <button key={k.id} onClick={() => { setKind(k); setStep(2); }}
                className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-muted/50">
                <span aria-hidden className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-[3px] ${
                  kind.id === k.id ? 'border-foreground' : 'border-muted-foreground/40'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{k.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{k.sub}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input className="mt-1.5" placeholder={kind.title}
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {kind.scheduled && (
              <>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <Label className="text-xs">Which report</Label>
                    <div className="mt-1.5 divide-y rounded-lg border">
                      {([
                        { v: 'DIAGNOSTICS' as const, l: 'Diagnostic takings' },
                        { v: 'CLINIC' as const, l: 'OP takings' },
                      ]).map((d) => (
                        <button key={d.v} onClick={() => setDomain(d.v)}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50">
                          <span aria-hidden className={`h-3.5 w-3.5 shrink-0 rounded-full border-[3px] ${
                            domain === d.v ? 'border-foreground' : 'border-muted-foreground/40'}`} />
                          {d.l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="w-32">
                    <Label className="text-xs">Every day at</Label>
                    <Input type="time" className="mt-1.5"
                      value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
                  </div>
                </div>

                <div>
                  <Label className="text-xs">Which branches</Label>
                  {branches.length === 0 ? (
                    <p className="mt-1.5 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
                      No branches loaded.
                    </p>
                  ) : (
                    <>
                      <div className="mt-1.5 max-h-40 divide-y overflow-y-auto rounded-lg border">
                        {branches.map((b) => (
                          <label key={b.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                            <Checkbox checked={branchIds.includes(b.id)}
                              onCheckedChange={() => toggleBranch(b.id)} />
                            <span>{b.name}</span>
                          </label>
                        ))}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        One message per branch, each with its own link. Pick none and nothing sends —
                        a report with no branch has nothing to report on.
                      </p>
                    </>
                  )}
                </div>
              </>
            )}
            <div>
              <Label className="text-xs">{kind.scheduled ? 'Template' : 'First message'}</Label>
              {kind.scheduled ? (
                <p className="mt-1.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  Leave this and it uses <code className="rounded bg-background px-1">owner_day_sheet_v2</code>,
                  the template these reports have always used. You can change it on the step afterwards —
                  which is what you would reach for the day Meta pauses one.
                </p>
              ) : approved.length === 0 ? (
                <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2.5 text-xs">
                  No approved templates yet. You can still create the draft — a SEND step naming an
                  unapproved template is refused at save, so nothing can go out by accident.
                </p>
              ) : (
                <div className="mt-1.5 max-h-44 divide-y overflow-y-auto rounded-lg border">
                  {approved.map((t) => (
                    <button key={t.name} onClick={() => setTemplate(t.name)}
                      className={`block w-full px-3 py-2 text-left hover:bg-muted/50 ${
                        template === t.name ? 'bg-muted' : ''}`}>
                      <span className="block font-mono text-sm">{t.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {t.bodyText.slice(0, 90)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 2 && <Button variant="outline" onClick={() => setStep(1)}>Back</Button>}
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          {step === 2 && (
            <Button
              disabled={create.isPending || (kind.scheduled && branchIds.length === 0)}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating…' : 'Create draft'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
