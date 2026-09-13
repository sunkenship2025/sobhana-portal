/**
 * One automation: Setup and Results, with the step drawers, the dry run and the
 * "try it out" simulation.
 *
 * Pause and Stop are separate controls with separate consequences, and Stop asks —
 * they are one careless click apart and every live run different.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingState } from '@/components/ui/loading-state';
import { toast } from 'sonner';
import { AutomationBuilder } from './AutomationBuilder';
import { ConditionBuilder } from './ConditionBuilder';
import { SimulateDialog } from './SimulateDialog';
import { AutomationResults } from './AutomationResults';
import { ActivityTab } from './ActivityTab';
import { useQuery as useRQ } from '@tanstack/react-query';
import {
  getAutomation, listTemplates, saveAutomation, activateAutomation, pauseAutomation,
  stopAutomation, previewAutomation, simulateAutomation, reasonLabel, listRecipients,
  type Automation, type AutomationDefinition, type Step, type TemplateSummary,
} from './api';

export function AutomationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState('setup');
  const [draft, setDraft] = useState<Partial<Automation>>({});
  const [editStep, setEditStep] = useState<number | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showAudience, setShowAudience] = useState(false);
  const [showSimulate, setShowSimulate] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);

  const { data: saved, isLoading } = useQuery({
    queryKey: ['automation', id], queryFn: () => getAutomation(id),
  });
  const { data: templates } = useQuery({ queryKey: ['templates'], queryFn: listTemplates });

  const automation = useMemo(
    () => (saved ? { ...saved, ...draft } : null),
    [saved, draft],
  );
  const dirty = Object.keys(draft).length > 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['automation', id] });
    qc.invalidateQueries({ queryKey: ['automations'] });
  };

  const save = useMutation({
    mutationFn: () => saveAutomation(id, {
      definition: automation!.definition,
      holdoutPct: automation!.holdoutPct,
      priority: automation!.priority,
    }),
    onSuccess: () => { toast.success('Saved'); setDraft({}); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const activate = useMutation({
    mutationFn: () => activateAutomation(id),
    onSuccess: () => {
      toast.success('Active. Only visits from now on will enrol.');
      setConfirmActivate(false); invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const pause = useMutation({
    mutationFn: () => pauseAutomation(id),
    onSuccess: () => { toast.success('Paused. Journeys already running will finish.'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const stop = useMutation({
    mutationFn: () => stopAutomation(id),
    onSuccess: (r) => {
      toast.success(`Stopped. ${r.runsCancelled} running journeys were cancelled.`);
      setConfirmStop(false); invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !automation) return <LoadingState />;

  // A scheduled report has no patient to simulate and no SEND step to count.
  const isScheduled = automation.definition.trigger.kind === 'SCHEDULE';
  const dayLabels = automation.definition.steps
    .filter((s): s is Extract<Step, { kind: 'WAIT' }> => s.kind === 'WAIT' && s.anchor === 'TRIGGER')
    .map((s) => `Day ${s.days ?? 0}`);
  const sends = isScheduled
    ? automation.definition.steps.filter((s) => s.kind === 'DAY_SHEET').length *
      Math.max(1, automation.branchIds.length)
    : automation.definition.steps.filter((s) => s.kind === 'SEND').length;

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Automations
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{automation.name}</h2>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className={`h-2 w-2 rounded-full ${
              automation.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
            {automation.enabled ? 'Active' : automation.activatedAt ? 'Paused' : 'Draft'} · v{automation.version}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isScheduled
              ? `${sends} message${sends === 1 ? '' : 's'} a night, one per branch`
              : `${sends} message${sends === 1 ? '' : 's'}${dayLabels.length > 0 ? ` on ${dayLabels.join(', ')}` : ''}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="results">Results</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
          </Tabs>
          {automation.enabled ? (
            <>
              <Button variant="outline" size="sm" disabled={pause.isPending} onClick={() => pause.mutate()}>
                Pause
              </Button>
              {!isScheduled && (
                <Button variant="outline" size="sm" onClick={() => setShowSimulate(true)}>Try it out</Button>
              )}
              <Button variant="outline" size="sm" className="text-destructive"
                onClick={() => setConfirmStop(true)}>Stop</Button>
            </>
          ) : (
            <>
              {!isScheduled && (
                <Button variant="outline" size="sm" onClick={() => setShowSimulate(true)}>Try it out</Button>
              )}
              <Button size="sm" onClick={() => setConfirmActivate(true)}>Activate</Button>
            </>
          )}
        </div>
      </div>

      {tab === 'setup' && <BrokenTemplateNotice automation={automation} templates={templates?.templates ?? []} />}

      {tab === 'setup' && (
        <>
          <AutomationBuilder
            automation={automation}
            templates={templates?.templates ?? []}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
            onEditStep={setEditStep}
            onPreview={() => setShowPreview(true)}
            onEditAudience={() => setShowAudience(true)}
          />
          {dirty && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft({})}>Discard</Button>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          )}
        </>
      )}

      {tab === 'results' && <AutomationResults automationId={id} />}
      {tab === 'activity' && <ActivityTab automationId={id} />}

      <StepDrawer
        automation={automation}
        index={editStep}
        templates={templates?.templates ?? []}
        onClose={() => setEditStep(null)}
        onChange={(steps) => {
          setDraft({ ...draft, definition: { ...automation.definition, steps } });
          setEditStep(null);
        }}
      />

      <PreviewDialog id={id} open={showPreview} onClose={() => setShowPreview(false)} />

      <ConditionBuilder
        open={showAudience}
        condition={automation.definition.audience}
        onClose={() => setShowAudience(false)}
        onSave={(audience) => {
          setDraft({ ...draft, definition: { ...automation.definition, audience } });
          setShowAudience(false);
        }}
      />

      <SimulateDialog id={id} open={showSimulate} onClose={() => setShowSimulate(false)} />

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this automation?</AlertDialogTitle>
            <AlertDialogDescription>
              Pausing stops new patients entering and lets journeys already running finish.
              Stopping also cancels every journey in flight — patients waiting for a reminder
              will never get it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline" onClick={() => { setConfirmStop(false); pause.mutate(); }}>
              Just pause
            </Button>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => stop.mutate()}>
              Stop everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ActivateDialog
        id={id} automation={automation} open={confirmActivate}
        onClose={() => setConfirmActivate(false)}
        onConfirm={() => activate.mutate()} pending={activate.isPending}
      />
    </div>
  );
}

/**
 * "Paused — template rejected" is a diagnosis, not a next action. This answers the
 * three questions in order: what happened, who is stuck, and what do I press.
 */
function BrokenTemplateNotice({ automation, templates }: {
  automation: Automation;
  templates: TemplateSummary[];
}) {
  const broken = automation.definition.steps
    .filter((s): s is Extract<Step, { kind: 'SEND' }> => s.kind === 'SEND')
    .map((s) => ({ step: s, t: templates.find((x) => x.name === s.template) }))
    .filter(({ t }) => !t || t.status !== 'APPROVED');

  if (broken.length === 0 || templates.length === 0) return null;

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
      <p className="text-sm font-semibold">
        {broken.length === 1 ? 'A message in this journey cannot be sent' : 'Messages in this journey cannot be sent'}
      </p>
      <ul className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
        {broken.map(({ step, t }) => (
          <li key={step.template}>
            <code className="rounded bg-background px-1 text-xs">{step.template}</code>
            {' — '}
            {t ? `Meta says ${t.status.toLowerCase()}` : 'not found in your templates'}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Journeys already running keep their place and nothing expires while this is unresolved.
        Pick an approved template on the step, or fix it with Meta and refresh — a journey that
        kept firing into a rejected template would burn the number's quality rating for every
        message the centre sends, report-ready included.
      </p>
    </div>
  );
}

// ── The step drawer ─────────────────────────────────────────────────────────

function StepDrawer({ automation, index, templates, onClose, onChange }: {
  automation: Automation; index: number | null;
  templates: { name: string; status: string; paramCount: number; bodyText: string; category: string }[];
  onClose: () => void; onChange: (steps: Step[]) => void;
}) {
  const step = index !== null ? automation.definition.steps[index] : null;
  const [local, setLocal] = useState<Step | null>(null);
  const current = local ?? step;

  const commit = () => {
    if (index === null || !current) return;
    const steps = [...automation.definition.steps];
    steps[index] = current;
    setLocal(null);
    onChange(steps);
  };

  return (
    <Sheet open={index !== null} onOpenChange={(o) => { if (!o) { setLocal(null); onClose(); } }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {current && (
          <>
            <SheetHeader className="pb-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {current.kind === 'WAIT' ? 'Timing'
                  : current.kind === 'CHECK' ? 'Check before acting'
                  : current.kind === 'DAY_SHEET' ? 'The nightly report'
                  : 'Message'}
              </p>
              <SheetTitle className="text-[15px]">
                {current.kind === 'WAIT' && current.anchor === 'TRIGGER'
                  ? `Day ${current.days ?? 0}`
                  : current.kind === 'DAY_SHEET'
                    ? `${current.domain === 'CLINIC' ? 'OP' : 'Diagnostic'} day sheet`
                    : `Step ${(index ?? 0) + 1}`}
              </SheetTitle>
            </SheetHeader>

            {current.kind === 'WAIT' && (
              <div className="space-y-4">
                <div className="space-y-2 rounded-lg border p-3">
                  <label className="flex items-start gap-2.5 text-sm">
                    <input type="radio" className="mt-1" checked={current.anchor === 'TRIGGER'}
                      onChange={() => setLocal({ ...current, anchor: 'TRIGGER' })} />
                    <span>
                      On day
                      <Input type="number" className="mx-2 inline-block h-7 w-16"
                        value={current.days ?? 0}
                        onChange={(e) => setLocal({ ...current, anchor: 'TRIGGER', days: Number(e.target.value) })} />
                      after the trigger
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Anchored — a delay earlier in the journey never moves this day.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 text-sm">
                    <input type="radio" className="mt-1" checked={current.anchor === 'PREVIOUS'}
                      onChange={() => setLocal({ ...current, anchor: 'PREVIOUS' })} />
                    <span>
                      <Input type="number" className="mr-2 inline-block h-7 w-16"
                        value={current.days ?? 0}
                        onChange={(e) => setLocal({ ...current, anchor: 'PREVIOUS', days: Number(e.target.value) })} />
                      days after the step before
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Relative — this one shifts if an earlier step is delayed.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            )}

            {current.kind === 'CHECK' && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                  <b>Checked live, the moment this step runs.</b> Never what was true when the
                  patient enrolled.
                </div>
                <div className="divide-y rounded-lg border">
                  <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <span className="flex-1">If yes</span>
                    <Select value={current.onTrue}
                      onValueChange={(v) => setLocal({ ...current, onTrue: v as 'STOP' | 'CONTINUE' })}>
                      <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="STOP">Stop — came in</SelectItem>
                        <SelectItem value="CONTINUE">Continue anyway</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <span className="flex-1">If no</span>
                    <span className="text-muted-foreground">Continue</span>
                  </div>
                </div>
              </div>
            )}

            {current.kind === 'DAY_SHEET' && (
              <DaySheetStepFields
                step={current}
                templates={templates}
                onChange={(patch) => setLocal({ ...current, ...patch })}
              />
            )}

            {current.kind === 'SEND' && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs">Template</Label>
                  <Select value={current.template}
                    onValueChange={(v) => setLocal({ ...current, template: v })}>
                    <SelectTrigger className="mt-1.5 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.name} value={t.name} disabled={t.status !== 'APPROVED'}>
                          {t.name}{t.status !== 'APPROVED' ? ` — ${t.status.toLowerCase()}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {(() => {
                  const t = templates.find((x) => x.name === current.template);
                  if (!t) return null;
                  const mismatch = t.paramCount !== current.params.length;
                  return (
                    <>
                      <div>
                        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          What the patient sees
                        </p>
                        <div className="rounded-lg bg-[#e6ded5] p-3">
                          <div className="rounded-lg rounded-bl-sm bg-white px-3 py-2 text-[13px] leading-relaxed shadow-sm">
                            {t.bodyText}
                          </div>
                        </div>
                      </div>
                      {mismatch && (
                        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                          This template expects <b>{t.paramCount}</b> blanks and <b>{current.params.length}</b>
                          {' '}are filled. Saving is refused — a mismatch caught here is a dialog, and caught
                          at send time it fails for every patient in the run.
                        </p>
                      )}
                    </>
                  );
                })()}

                <div>
                  <Label className="text-xs">Kind</Label>
                  <Select value={current.intent}
                    onValueChange={(v) => setLocal({ ...current, intent: v as 'REACTIVE' | 'PROACTIVE' })}>
                    <SelectTrigger className="mt-1.5 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PROACTIVE">We started it — offers, nudges</SelectItem>
                      <SelectItem value="REACTIVE">Answering something they did</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Only the ones we start are capped, held for quiet hours, or made to wait
                    behind a more important journey.
                  </p>
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setLocal(null); onClose(); }}>Cancel</Button>
              <Button size="sm" onClick={commit}>Save</Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Dry run ─────────────────────────────────────────────────────────────────

function PreviewDialog({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['preview', id], queryFn: () => previewAutomation(id), enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Who matches right now</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.qualifyingVisits.toLocaleString('en-IN')} qualifying visits · ${data.uniquePatients.toLocaleString('en-IN')} patients · ${data.wouldSendToday.toLocaleString('en-IN')} would be messaged today`
              : 'Counting…'}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
          <b>Nothing is sent from this screen.</b> The journey starts only when you activate it.
        </div>

        {isLoading ? <LoadingState /> : data && (
          <>
            <div className="divide-y rounded-lg border">
              {data.rows.map((r) => (
                <div key={r.visitId} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{r.patientName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.patientNumber} · {r.branchName} ·{' '}
                      {new Date(r.visitAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
                    {r.todayOutcome === 'WOULD_SEND' ? 'Will send' : reasonLabel(r.todayOutcome)}
                  </Badge>
                </div>
              ))}
              {data.rows.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nobody matches yet.
                </p>
              )}
            </div>

            {Object.keys(data.breakdown).length > 0 && (
              <div className="rounded-lg bg-muted px-3 py-2.5 text-sm">
                <b>Who would not be messaged today</b>
                <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                  {Object.entries(data.breakdown)
                    .filter(([k]) => k !== 'WOULD_SEND')
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => <div key={k}>{reasonLabel(k)} — {n}</div>)}
                </div>
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Activation summary ──────────────────────────────────────────────────────

function ActivateDialog({ id, automation, open, onClose, onConfirm, pending }: {
  id: string; automation: Automation; open: boolean;
  onClose: () => void; onConfirm: () => void; pending: boolean;
}) {
  const { data } = useQuery({
    queryKey: ['preview', id], queryFn: () => previewAutomation(id, 5), enabled: open,
  });
  const sends = automation.definition.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === 'SEND');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ready to activate</DialogTitle>
          <DialogDescription>{automation.name}</DialogDescription>
        </DialogHeader>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            The journey
          </p>
          <div className="divide-y rounded-lg border text-sm">
            <div className="px-3 py-2.5">
              <b>Starts</b> when a visit is completed —{' '}
              <span className="text-muted-foreground">from today onward. Past visits never enrol.</span>
            </div>
            {sends.map(({ s, i }) => {
              const wait = automation.definition.steps
                .slice(0, i).reverse()
                .find((x): x is Extract<Step, { kind: 'WAIT' }> => x.kind === 'WAIT');
              return (
                <div key={i} className="px-3 py-2.5">
                  <b>{wait?.anchor === 'TRIGGER' ? `Day ${wait.days}` : 'Later'}</b>{' '}
                  <code className="rounded bg-muted px-1 text-xs">
                    {s.kind === 'SEND' ? s.template : ''}
                  </code>
                  {s.kind === 'SEND' && s.issueOffer && (
                    <span className="text-muted-foreground"> · issues an offer</span>
                  )}
                </div>
              );
            })}
            <div className="bg-muted/40 px-3 py-2.5">
              <b>Stops</b> the moment diagnostics happen for that visit.
            </div>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Safety</p>
          <div className="divide-y rounded-lg border text-sm">
            <div className="px-3 py-2.5">{automation.holdoutPct}% held back as a control group</div>
            <div className="px-3 py-2.5">Sends only between 8:00 AM and 9:00 PM</div>
            {data && (
              <div className="px-3 py-2.5">
                About {data.wouldSendToday} would be messaged today
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? 'Activating…' : 'Activate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The day sheet's settings — all of which were constants in the source until now.
 *
 * The template mattered most: with it hardcoded, the day Meta paused or rejected it,
 * recovering meant editing code and shipping a deploy, for a message carrying a day's
 * takings. The rest are the same shape of problem, smaller.
 */
function DaySheetStepFields({ step, templates, onChange }: {
  step: Extract<Step, { kind: 'DAY_SHEET' }>;
  templates: TemplateSummary[];
  onChange: (patch: Partial<Extract<Step, { kind: 'DAY_SHEET' }>>) => void;
}) {
  const { data } = useRQ({ queryKey: ['recipients'], queryFn: listRecipients });
  const recipients = data?.recipients ?? [];
  const chosen = step.recipientUserIds ?? [];

  const toggle = (id: string) =>
    onChange({
      recipientUserIds: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id],
    });

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">Template</Label>
        <Select
          value={step.template ?? '__default__'}
          onValueChange={(v) => onChange({ template: v === '__default__' ? undefined : v })}
        >
          <SelectTrigger className="mt-1.5 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">owner_day_sheet_v2 (default)</SelectItem>
            {templates.filter((t) => t.status === 'APPROVED').map((t) => (
              <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          If Meta ever pauses the one you are using, switch it here rather than waiting for
          a code change.
        </p>
      </div>

      <div>
        <Label className="text-xs">Who gets it</Label>
        {recipients.length === 0 ? (
          <p className="mt-1.5 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
            Nobody has a phone number in Roles yet, so nothing can send.
          </p>
        ) : (
          <>
            <div className="mt-1.5 max-h-48 divide-y overflow-y-auto rounded-lg border">
              {recipients.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chosen.includes(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.role} · {r.phone}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {chosen.length === 0
                ? 'Nobody chosen — it goes to every active owner with a phone, as it always has.'
                : `${chosen.length} chosen. Only these people get it.`}
            </p>
          </>
        )}
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <Label className="text-xs">Link works for</Label>
          <Input
            className="mt-1.5" placeholder="72"
            value={step.linkExpiryHours ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              onChange({ linkExpiryHours: v === '' ? undefined : Math.max(1, Number(v)) });
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">Hours. Blank = 72.</p>
        </div>
        <div className="flex-1">
          <Label className="text-xs">Send late up to</Label>
          <Input
            className="mt-1.5" placeholder="8"
            value={step.graceHours ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              onChange({ graceHours: v === '' ? undefined : Math.max(0, Number(v)) });
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Hours. If the server was down at the send time, it still goes out inside this
            window rather than being lost. Blank = 8.
          </p>
        </div>
      </div>
    </div>
  );
}
