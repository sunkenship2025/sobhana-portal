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
import { createAutomation, listTemplates, type AutomationDefinition } from './api';

interface Kind {
  id: string;
  title: string;
  sub: string;
  group: string;
  build: (template: string) => AutomationDefinition;
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

const KINDS: Kind[] = [
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

  const { data } = useQuery({ queryKey: ['templates'], queryFn: listTemplates, enabled: open });
  const approved = (data?.templates ?? []).filter((t) => t.status === 'APPROVED');

  const create = useMutation({
    mutationFn: () => createAutomation({
      key: `${kind.id.toUpperCase()}_${Date.now().toString(36).toUpperCase()}`,
      name: name.trim() || kind.title,
      group: kind.group,
      definition: kind.build(template),
      holdoutPct: 10,
    }),
    onSuccess: (a) => {
      toast.success('Created as a draft. Nothing sends until you activate it.');
      reset();
      onCreated(a.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = () => { setStep(1); setName(''); setTemplate(''); setKind(KINDS[0]); };

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
            <div>
              <Label className="text-xs">First message</Label>
              {approved.length === 0 ? (
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
            <Button disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating…' : 'Create draft'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
