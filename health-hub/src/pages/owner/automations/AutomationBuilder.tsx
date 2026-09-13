/**
 * The builder, read as a sentence: WHEN → FOR → [Day n: CHECK → DO] → STOP.
 *
 * Waits are folded into the day header they govern, so a fifteen-step journey is five
 * blocks rather than fifteen rows. Steps open in a right-side SHEET, not a dialog, so
 * the journey stays on screen while you edit one part of it — the question you are
 * answering is almost always "where does this sit relative to the others".
 */
import { useMemo, useState } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import type { Automation, AutomationDefinition, Step, TemplateSummary } from './api';

/** Contiguous CHECK/SEND steps that follow a WAIT, shown as one dated block. */
interface DayBlock {
  label: string;
  sub: string;
  waitIndex: number | null;
  steps: { step: Step; index: number }[];
}

function groupIntoDays(def: AutomationDefinition): { blocks: DayBlock[]; tail: { step: Step; index: number }[] } {
  const blocks: DayBlock[] = [];
  const tail: { step: Step; index: number }[] = [];
  let current: DayBlock | null = null;

  def.steps.forEach((step, index) => {
    if (step.kind === 'WAIT') {
      const label = step.anchor === 'TRIGGER'
        ? `Day ${step.days ?? 0}`
        : `${step.days ?? 0} day${(step.days ?? 0) === 1 ? '' : 's'} later`;
      const sub = step.anchor === 'TRIGGER'
        ? `due ${step.days ?? 0} days after the trigger`
        : 'counted from the step before — this one can drift';
      current = { label, sub, waitIndex: index, steps: [] };
      blocks.push(current);
      return;
    }
    if (step.kind === 'STOP') { tail.push({ step, index }); return; }
    if (step.kind === 'DAY_SHEET') {
      if (!current) {
        current = { label: 'Every night', sub: 'at the time set above', waitIndex: null, steps: [] };
        blocks.push(current);
      }
      current.steps.push({ step, index });
      return;
    }
    if (!current) {
      current = { label: 'Straight away', sub: 'no wait before this', waitIndex: null, steps: [] };
      blocks.push(current);
    }
    current.steps.push({ step, index });
  });

  return { blocks, tail };
}

const VERB = 'w-16 shrink-0 pt-0.5 text-[13px] font-semibold text-foreground/70';

const toTimeValue = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const clockLabel = (m: number) => {
  const h = Math.floor(m / 60);
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${ampm}`;
};

export function AutomationBuilder({
  automation, templates, onChange, onEditStep, onPreview, onEditAudience,
}: {
  automation: Automation;
  templates: TemplateSummary[];
  onChange: (patch: Partial<Automation>) => void;
  onEditStep: (index: number) => void;
  onPreview: () => void;
  onEditAudience: () => void;
}) {
  const setSendTime = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    onChange({
      definition: {
        ...automation.definition,
        trigger: { kind: 'SCHEDULE', everyDayAtMinutes: h * 60 + m },
      },
    });
  };
  const def = automation.definition;
  const { blocks, tail } = useMemo(() => groupIntoDays(def), [def]);
  /** A day sheet has no patient, so audience, stop condition and holdout do not apply. */
  const isScheduled = def.trigger.kind === 'SCHEDULE';

  const templateOf = (name: string) => templates.find((t) => t.name === name);

  return (
    <div className="space-y-4">
      <div className="divide-y rounded-lg border">
        <div className="flex items-start gap-3 px-4 py-3">
          <span className={VERB}>When</span>
          <span className="min-w-0 flex-1">
            {isScheduled && (
              <>
                <span className="mb-1.5 flex items-center gap-2">
                  <span className="text-sm font-medium">Every day at</span>
                  <Input
                    type="time"
                    className="h-8 w-28"
                    value={toTimeValue((def.trigger as { everyDayAtMinutes: number }).everyDayAtMinutes)}
                    onChange={(e) => setSendTime(e.target.value)}
                  />
                </span>
                <span className="mb-1.5 flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Still send up to</span>
                  <Input
                    className="h-8 w-16"
                    placeholder="8"
                    value={(def.trigger as { graceHours?: number }).graceHours ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      onChange({
                        definition: {
                          ...def,
                          trigger: {
                            kind: 'SCHEDULE',
                            everyDayAtMinutes: (def.trigger as { everyDayAtMinutes: number }).everyDayAtMinutes,
                            graceHours: v === '' ? undefined : Math.max(0, Number(v)),
                          },
                        },
                      });
                    }}
                  />
                  <span className="text-sm text-muted-foreground">hours late if the server was down</span>
                </span>
              </>
            )}
            <span className={`block text-sm font-medium ${isScheduled ? 'hidden' : ''}`}>
              {def.trigger.kind === 'VISIT_COMPLETED'
                ? `A ${def.trigger.domain === 'CLINIC' ? 'clinic' : 'diagnostic'} visit is completed`
                : def.trigger.kind === 'REPORT_FINALIZED'
                  ? 'A report is finalized'
                  : `Every day at ${clockLabel(def.trigger.everyDayAtMinutes)}`}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {automation.branchIds.length === 0 ? 'All branches' : `${automation.branchIds.length} branches`}
              {isScheduled
                ? ' · one message each, every night'
                : automation.activatedAt
                  ? ` · visits from ${new Date(automation.activatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} onward`
                  : ' · nothing enrolled until you activate'}
            </span>
            {!isScheduled && (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {def.reentry.concurrency === 'ALLOW_PARALLEL'
                  ? 'Every qualifying visit starts its own journey — a patient can have two running at once'
                  : 'Only one journey per patient at a time'}
              </span>
            )}
          </span>
        </div>

        <div className={`flex items-start gap-3 px-4 py-3 ${isScheduled ? 'hidden' : ''}`}>
          <span className={VERB}>For</span>
          <button onClick={onEditAudience} className="min-w-0 flex-1 text-left">
            <span className="block text-sm font-medium hover:underline">
              {describeAudience(def)}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Click to change who qualifies
            </span>
          </button>
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={onPreview}>
            Preview
          </Button>
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </div>

      {blocks.map((b) => (
        <div key={`${b.label}-${b.waitIndex}`} className="overflow-hidden rounded-lg border">
          <button
            onClick={() => b.waitIndex !== null && onEditStep(b.waitIndex)}
            className="flex w-full items-center gap-3 border-b bg-muted px-4 py-2.5 text-left hover:bg-muted/70"
          >
            <span className="text-sm font-semibold">{b.label}</span>
            <span className="text-xs font-normal text-muted-foreground">{b.sub}</span>
            <span className="flex-1" />
            {b.waitIndex !== null && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </button>
          <div className="divide-y bg-card">
            {b.steps.map(({ step, index }) => (
              <button
                key={index}
                onClick={() => onEditStep(index)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50"
              >
                <span className={VERB}>{step.kind === 'CHECK' ? 'Check' : 'Do'}</span>
                <span className="min-w-0 flex-1">
                  {step.kind === 'CHECK' ? (
                    <>
                      <span className="block text-sm font-medium">Did this visit lead to diagnostics?</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Checked live · yes → stop · no → continue
                      </span>
                    </>
                  ) : step.kind === 'SEND' ? (
                    <>
                      <span className="block text-sm font-medium">
                        Send <code className="rounded bg-muted px-1 text-xs">{step.template}</code>
                        {step.issueOffer && ' and issue an offer'}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {step.params.length} blank{step.params.length === 1 ? '' : 's'} filled
                        {templateOf(step.template)
                          ? ` · ${templateOf(step.template)!.status.toLowerCase()}`
                          : ' · not found in your approved templates'}
                      </span>
                    </>
                  ) : step.kind === 'DAY_SHEET' ? (
                    <>
                      <span className="block text-sm font-medium">
                        Send the {step.domain === 'CLINIC' ? 'OP' : 'diagnostic'} day sheet to the owners
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        One message per branch, each with its own link that expires in 72 hours
                      </span>
                    </>
                  ) : (
                    <span className="block text-sm font-medium">Stop</span>
                  )}
                </span>
                {step.kind === 'SEND' && (
                  <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
                    {step.intent === 'REACTIVE' ? 'Reactive' : 'Proactive'}
                  </Badge>
                )}
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className={`divide-y rounded-lg border ${isScheduled ? 'hidden' : ''}`}>
        <div className="flex items-start gap-3 px-4 py-3">
          <span className={VERB}>Stop</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              When diagnostics happen for this visit
              {tail.length > 0 && ' — or after the last message'}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Counts as converted within {def.goal.windowDays} days of the visit, at any branch.
              No new step starts after the last day; one already due is still sent.
            </span>
          </span>
        </div>
      </div>

      <section className={`space-y-2 ${isScheduled ? 'hidden' : ''}`}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Experiment</p>
        <div className="divide-y rounded-lg border">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Hold back a control group</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Enrolled and checked, never messaged — so you can tell what this actually caused.
                The same patient stays in the same group across every visit.
              </span>
            </span>
            <Input
              type="number" min={0} max={20}
              className="h-9 w-20 text-right"
              value={automation.holdoutPct}
              onChange={(e) => onChange({ holdoutPct: Math.max(0, Math.min(20, Number(e.target.value))) })}
            />
          </div>
        </div>
      </section>

      {isScheduled && (
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Who gets it
          </p>
          <div className="divide-y rounded-lg border">
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Every owner with a phone number</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Set in Roles. No phone there means no message — never a guess at who to send to.
                </span>
              </span>
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">One message per branch, each with its own link</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  The link opens that branch's takings for that day and stops working after 72 hours —
                  a day's revenue is not something to leave reachable forever.
                </span>
              </span>
            </div>
            <div className="flex items-center gap-3 bg-muted/30 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Sending hours and message caps do not apply</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Those hold back offers to patients. This goes to your own team at the time you set,
                  which is usually after the quiet hours a patient message would respect.
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" /> Not a patient message
              </span>
            </div>
          </div>
        </section>
      )}

      <section className={`space-y-2 ${isScheduled ? 'hidden' : ''}`}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sending rules</p>
        <div className="divide-y rounded-lg border">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Importance</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                When two journeys want the same patient in the same moment, the more important
                one goes first and the other waits its turn.
              </span>
            </span>
            <Select
              value={String(automation.priority)}
              onValueChange={(v) => onChange({ priority: Number(v) })}
            >
              <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="5">Highest</SelectItem>
                <SelectItem value="4">High</SelectItem>
                <SelectItem value="3">Normal</SelectItem>
                <SelectItem value="2">Low</SelectItem>
                <SelectItem value="1">Lowest</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <LockedRow
            title="Only between 8:00 AM and 9:00 PM"
            sub="Set for the whole centre. Reports and bills are not held."
          />
          <LockedRow
            title="One offer message per patient per 7 days"
            sub="Across every journey. A capped message waits — it is never lost."
          />
        </div>
      </section>

      <section className={`space-y-2 ${isScheduled ? 'hidden' : ''}`}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Always on</p>
        <div className="divide-y rounded-lg border">
          <LockedRow
            title="Stop conditions are re-checked before every action"
            sub="A message, an offer, a task — a patient who comes in while waiting gets none of them."
            hard
          />
          <LockedRow
            title="A critical result never enters a journey"
            sub="The lab is alerted instead."
            hard
          />
          <LockedRow
            title="No test name or finding in a message"
            sub="Phones are shared between family members."
            hard
          />
        </div>
      </section>
    </div>
  );
}

function LockedRow({ title, sub, hard }: { title: string; sub: string; hard?: boolean }) {
  return (
    <div className="flex items-center gap-3 bg-muted/30 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{sub}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />
        {hard ? 'Cannot be turned off' : 'Set for all'}
      </span>
    </div>
  );
}

/** A one-line reading of the audience, so the sentence stays readable. */
function describeAudience(def: AutomationDefinition): string {
  const parts: string[] = [];
  const walk = (c: AutomationDefinition['audience']) => {
    if ('all' in c) { c.all.forEach(walk); return; }
    if ('any' in c) { c.any.forEach(walk); return; }
    if ('not' in c) { walk(c.not); return; }
    if (c.fn === 'patientAgeYears' && c.op === 'gte') parts.push(`${c.value}+ years old`);
    else if (c.fn === 'visitValueInPaise' && c.op === 'gte') parts.push(`visits of ₹${Math.round(Number(c.value) / 100)} or more`);
    else if (c.fn === 'agreedToOffers') parts.push('agreed to offers');
    else parts.push(c.fn);
  };
  walk(def.audience);
  return parts.length ? parts.join(', ') : 'Everyone the trigger catches';
}
