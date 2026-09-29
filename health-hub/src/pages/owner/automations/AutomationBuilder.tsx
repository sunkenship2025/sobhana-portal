/**
 * The builder, read as a sentence: WHEN → FOR → [Day n: CHECK → DO] → STOP.
 *
 * Waits are folded into the day header they govern, so a fifteen-step journey is five
 * blocks rather than fifteen rows. Steps open in a right-side SHEET, not a dialog, so
 * the journey stays on screen while you edit one part of it — the question you are
 * answering is almost always "where does this sit relative to the others".
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Lock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { listPredicates, type Automation, type AutomationDefinition, type Step, type TemplateSummary } from './api';
import { describeCondition, describeJump, describeReentry } from './describe';

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
  automation, templates, onChange, onEditStep, onAddStep, onPreview, onEditAudience,
  onEditWhen, onEditGoal,
}: {
  automation: Automation;
  templates: TemplateSummary[];
  onChange: (patch: Partial<Automation>) => void;
  onEditStep: (index: number) => void;
  /** Insert a new step at this position. */
  onAddStep: (at: number) => void;
  onPreview: () => void;
  onEditAudience: () => void;
  /** Change what starts it and how often. */
  onEditWhen: () => void;
  /** Change when it stops early, if ever. */
  onEditGoal: () => void;
}) {
  // The vocabulary, so nothing on this screen describes a predicate in words the engine
  // would not recognise.
  const { data: predicateData } = useQuery({ queryKey: ['predicates'], queryFn: listPredicates });
  const catalog = predicateData?.predicates ?? [];
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
            {!isScheduled && (
              // The server's sentence for the trigger, from the registry — this used to be
              // written here, and knew two triggers out of eleven.
              <button onClick={onEditWhen} className="block text-left text-sm font-medium hover:underline">
                {automation.triggerText ?? 'Choose what starts this'}
              </button>
            )}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {automation.branchIds.length === 0 ? 'All branches' : `${automation.branchIds.length} branches`}
              {isScheduled
                ? ' · one message each, every night'
                : automation.activatedAt
                  ? ` · visits from ${new Date(automation.activatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} onward`
                  : ' · nothing enrolled until you activate'}
            </span>
            {!isScheduled && (
              <span className="mt-0.5 block text-xs text-muted-foreground">{describeReentry(def.reentry)}</span>
            )}
          </span>
        </div>

        <div className={`flex items-start gap-3 px-4 py-3 ${isScheduled ? 'hidden' : ''}`}>
          <span className={VERB}>For</span>
          <button onClick={onEditAudience} className="min-w-0 flex-1 text-left">
            <span className="block text-sm font-medium hover:underline first-letter:uppercase">
              {def.audience && 'fn' in def.audience && def.audience.fn === 'always'
                ? 'Everyone the trigger catches'
                : describeCondition(def.audience, catalog)}
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
                <span className="w-6 shrink-0 pt-0.5 text-[13px] tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className={VERB}>{step.kind === 'CHECK' ? 'Check' : 'Do'}</span>
                <span className="min-w-0 flex-1">
                  {step.kind === 'CHECK' ? (
                    <>
                      <span className="block text-sm font-medium">
                        {describeCondition(step.condition, catalog)}?
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Checked live · yes → {describeJump(step.onTrue)}
                        {' · no → '}{describeJump(step.onFalse)}
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
                      {step.issueOffer && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          Issues an offer, one per journey however many steps ask for it
                          {step.issueOffer.expiry?.anchor === 'TRIGGER' &&
                            ` · expires end of day ${step.issueOffer.expiry.days} after the trigger, so claiming late means less time`}
                        </span>
                      )}
                    </>
                  ) : step.kind === 'ASK' ? (
                    <>
                      <span className="block text-sm font-medium">
                        Ask, using <code className="rounded bg-muted px-1 text-xs">{step.template}</code>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {step.buttons.map((b) => `"${b.label}"`).join(' · ')}
                        {' — '}
                        {step.onUnmatched === 'HANDOFF'
                          ? 'anything else goes to a person'
                          : step.onUnmatched === 'STOP' ? 'anything else ends the journey'
                          : 'anything else carries on'}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Holds this phone for {step.waitHours ?? 24} hours. No answer in that time and
                        the journey moves on.
                      </span>
                    </>
                  ) : step.kind === 'HANDOFF' ? (
                    <>
                      <span className="block text-sm font-medium">Hand the conversation to a person</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        The journey ends here — it does not resume when they are done
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
                  ) : step.kind === 'STOP' ? (
                    <span className="block text-sm font-medium">Stop</span>
                  ) : (
                    // The engine grew a step this screen has not learned to draw. Say so
                    // rather than render nothing — a step that silently disappears is
                    // worse than one that is ugly, because the journey still runs it.
                    <>
                      <span className="block text-sm font-medium text-destructive">
                        A “{(step as { kind: string }).kind}” step
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        This screen does not know how to show this yet, but the journey still
                        runs it. Update the app to edit it here.
                      </span>
                    </>
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
            <button
              onClick={() => onAddStep(
                (b.steps.length ? b.steps[b.steps.length - 1].index : b.waitIndex ?? -1) + 1,
              )}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
            >
              <span className="w-6 shrink-0" />
              <Plus className="h-3.5 w-3.5" /> Add a step here
            </button>
          </div>
        </div>
      ))}

      <button
        onClick={() => onAddStep(def.steps.length)}
        className="flex w-full items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground hover:bg-muted/40"
      >
        <Plus className="h-4 w-4" /> Add a step at the end
      </button>

      <div className={`divide-y rounded-lg border ${isScheduled ? 'hidden' : ''}`}>
        <div className="flex items-start gap-3 px-4 py-3">
          <span className={VERB}>Stop</span>
          <button onClick={onEditGoal} className="min-w-0 flex-1 text-left">
            {def.goal ? (
              <>
                <span className="block text-sm font-medium hover:underline first-letter:uppercase">
                  When {describeCondition(def.goal.condition, catalog)}
                  {tail.length > 0 && ' — or after the last step'}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Checked before every step, for {def.goal.windowDays} days after it starts. Nothing
                  promotional is sent after that.
                </span>
              </>
            ) : (
              <>
                <span className="block text-sm font-medium hover:underline">After the last step</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Nothing stops it early. Click to stop it as soon as something happens — like the
                  patient coming back.
                </span>
              </>
            )}
          </button>
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
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
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Who it can go to</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {def.policy?.skipMarketingConsent
                  ? 'A follow-up to care they were given, so it goes to patients who have not agreed to offers too. Anyone who replied STOP still gets nothing.'
                  : 'Only patients who agreed to receive offers.'}
              </span>
            </span>
            <Select
              value={def.policy?.skipMarketingConsent ? 'SERVICE' : 'OFFERS'}
              onValueChange={(v) => onChange({
                definition: { ...def, policy: { ...def.policy, skipMarketingConsent: v === 'SERVICE' || undefined } },
              })}
            >
              <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="OFFERS">Agreed to offers</SelectItem>
                <SelectItem value="SERVICE">Every patient (service follow-up)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">When a patient replies STOP</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {def.policy?.stopScope === 'THIS_JOURNEY'
                  ? "A STOP in reply to this journey's question ends only this journey. Reports, bills and other journeys still reach them."
                  : 'Nothing from any journey reaches that number again, until they reply START.'}
              </span>
            </span>
            <Select
              value={def.policy?.stopScope ?? 'GLOBAL'}
              onValueChange={(v) => onChange({
                definition: { ...def, policy: { ...def.policy, stopScope: v === 'THIS_JOURNEY' ? 'THIS_JOURNEY' : undefined } },
              })}
            >
              <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="GLOBAL">Stop everything</SelectItem>
                <SelectItem value="THIS_JOURNEY">Stop only this journey</SelectItem>
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
            title="No journey messages a patient about a visit with a critical result"
            sub="Staff alerts still go — a journey can tell the lab in charge."
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


