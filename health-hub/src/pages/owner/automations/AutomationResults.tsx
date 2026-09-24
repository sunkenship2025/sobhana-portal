/**
 * Results — the tab an operator lives in once a journey is running.
 *
 * Three kinds of number, kept visibly different because they are not equally true:
 * the funnel is counted, the lift is measured against a held-back group, and the
 * revenue is estimated. Message cost is absent — Meta bills per conversation and we
 * ingest no pricing data, and an invented cost inside a profit total is worse than no
 * total.
 */
import { useQuery } from '@tanstack/react-query';
import { LoadingState } from '@/components/ui/loading-state';
import { Badge } from '@/components/ui/badge';
import { getResults, listPredicates, reasonLabel, rupees, type ScheduledResults } from './api';
import { describeCondition, describeStep, dayOf } from './describe';

function Bar({ pct, muted }: { pct: number; muted?: boolean }) {
  return (
    <span className="h-5 flex-1 overflow-hidden rounded bg-muted">
      <span
        className={`block h-full rounded ${muted ? 'bg-muted-foreground/40' : 'bg-foreground/80'}`}
        style={{ width: `${Math.max(1, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

function Stage({ label, sub, n, pct, note, muted }: {
  label: string; sub?: string; n: number; pct: number; note?: string; muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0">
      <span className="w-48 shrink-0 text-sm font-medium">
        {label}
        {sub && <span className="block text-xs font-normal text-muted-foreground">{sub}</span>}
      </span>
      <Bar pct={pct} muted={muted} />
      <span className="w-36 shrink-0 text-right text-sm tabular-nums">
        {n.toLocaleString('en-IN')}
        {note && <span className="ml-2 text-xs text-muted-foreground">{note}</span>}
      </span>
    </div>
  );
}

function Row({ title, sub, value, strong }: {
  title: string; sub?: string; value: string; strong?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${strong ? 'bg-muted/40' : ''}`}>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${strong ? 'font-semibold' : 'font-medium'}`}>{title}</span>
        {sub && <span className="mt-0.5 block text-xs text-muted-foreground">{sub}</span>}
      </span>
      <span className={`shrink-0 text-sm tabular-nums ${strong ? 'font-semibold' : 'text-muted-foreground'}`}>
        {value}
      </span>
    </div>
  );
}

export function AutomationResults({ automationId }: { automationId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['automation-results', automationId],
    queryFn: () => getResults(automationId),
  });
  const { data: predicateData } = useQuery({ queryKey: ['predicates'], queryFn: listPredicates });

  if (isLoading) return <LoadingState />;
  if (!data) return null;

  // A report to your own team has no funnel. The only questions are whether last night
  // went out and whether any night has failed.
  if ('kind' in data && data.kind === 'SCHEDULE') return <Nights data={data} />;

  const { counts, converted, rates, skipped, money, branchSplit, windowDays, goal, steps, asks, offer } = data;
  const base = Math.max(1, counts.runs);
  const pct = (n: number) => (n / base) * 100;
  // The goal in the same words the builder uses. This page used to say "came in for
  // tests" whatever the journey was chasing.
  const catalog = predicateData?.predicates ?? [];
  const goalWords = describeCondition(goal.condition, catalog);
  const controlled = counts.held > 0;
  const hasOffer = offer.sent > 0 || steps.some((s) => s.kind === 'SEND' && s.issueOffer);
  const share = (n: number, of: number) => `${Math.round((n / Math.max(1, of)) * 100)}%`;

  if (counts.runs === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        Nothing has run yet. Numbers appear here once patients start entering the journey.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { n: counts.runs.toLocaleString('en-IN'), label: `Runs · ${counts.uniquePatients.toLocaleString('en-IN')} patients` },
          { n: counts.messaged.toLocaleString('en-IN'), label: `Messaged · ${counts.delivered.toLocaleString('en-IN')} delivered` },
          { n: rates.afterMessagePct === null ? '—' : `${rates.afterMessagePct}%`, label: 'Goal met after a message' },
          controlled
            ? { n: `${rates.liftPts! >= 0 ? '+' : ''}${rates.liftPts} pts`, label: `Lift vs control · ±${rates.liftMarginPts}`, good: true }
            : { n: '—', label: 'Lift · no control group' },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border p-3.5">
            <p className={`text-xl font-semibold tabular-nums ${'good' in k && k.good ? 'text-emerald-600' : ''}`}>{k.n}</p>
            <p className="text-xs text-muted-foreground">{k.label}</p>
          </div>
        ))}
      </div>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Where everyone got to
        </p>
        <div className="rounded-lg border bg-card">
          <Stage label="Visits that qualified" n={counts.runs} pct={100} />
          {controlled && (
            <Stage label="Held back on purpose" sub="the control group, never messaged"
              n={counts.held} pct={pct(counts.held)} muted />
          )}
          {/* Not a stage the messages reached — the journey stood aside for them. */}
          <Stage label="Goal met before any message" sub={`${goalWords}, so none was needed`}
            n={converted.beforeMessage} pct={pct(converted.beforeMessage)} muted />
          {counts.waiting > 0 && (
            <Stage label="Waiting for a first message" sub="not due yet"
              n={counts.waiting} pct={pct(counts.waiting)} muted />
          )}
          <Stage label="Messaged" n={counts.messaged} pct={pct(counts.messaged)} />
          <Stage label="Delivered" n={counts.delivered} pct={pct(counts.delivered)} />
          <Stage label="Read" sub="undercounts — receipts can be switched off"
            n={counts.read} pct={pct(counts.read)} note="at least" />
          <Stage label="Goal met after a message" sub={`${goalWords}, within ${windowDays} days`}
            n={converted.afterMessage} pct={pct(converted.afterMessage)}
            note={rates.afterMessagePct === null ? undefined : `${rates.afterMessagePct}% of messaged`} />
          {controlled && (
            <Stage label="Held back, goal met anyway" n={converted.held}
              pct={pct(converted.held)} note={`${rates.heldPct}%`} muted />
          )}
        </div>
      </section>

      {/* Every question the journey asks, read from its own buttons — whatever they say. */}
      {asks.map((q) => {
        const answered = q.answers.reduce((n, a) => n + a.count, 0) + q.typed;
        const waiting = Math.max(0, q.asked - answered - q.noReply);
        const of = (n: number) => (n / Math.max(1, q.asked)) * 100;
        return (
          <section key={q.stepIndex}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Answers · {dayOf(steps, q.stepIndex)}
            </p>
            <div className="rounded-lg border bg-card">
              <Stage label="Asked" sub={describeStep(steps[q.stepIndex], catalog)} n={q.asked} pct={q.asked ? 100 : 0} />
              {q.answers.map((a) => (
                <Stage key={a.label} label={`Tapped “${a.label}”`} n={a.count} pct={of(a.count)}
                  note={share(a.count, q.asked)} />
              ))}
              {q.typed > 0 && (
                <Stage label="Replied with something else" sub="matched no button"
                  n={q.typed} pct={of(q.typed)} note={share(q.typed, q.asked)} />
              )}
              <Stage label="Never answered" n={q.noReply} pct={of(q.noReply)} muted />
              {waiting > 0 && (
                <Stage label="Waiting for an answer" sub="the question is still open" n={waiting} pct={of(waiting)} muted />
              )}
            </div>
          </section>
        );
      })}

      {hasOffer && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Offer</p>
          <div className="rounded-lg border bg-card">
            <Stage label="Codes sent" n={offer.sent} pct={offer.sent ? 100 : 0} />
            <Stage label="Used at a bill" sub={`− ${rupees(money.discountGivenInPaise)} discount`}
              n={offer.used} pct={(offer.used / Math.max(1, offer.sent)) * 100} note={share(offer.used, offer.sent)} />
            {offer.refunded > 0 && (
              <Stage label="Used, then refunded" sub="the discount came back"
                n={offer.refunded} pct={(offer.refunded / Math.max(1, offer.sent)) * 100} muted />
            )}
            <Stage label="Expired unused" n={offer.expiredUnused}
              pct={(offer.expiredUnused / Math.max(1, offer.sent)) * 100} muted />
            <Stage label="Still usable" n={offer.stillUsable}
              pct={(offer.stillUsable / Math.max(1, offer.sent)) * 100} muted />
          </div>
        </section>
      )}

      {skipped.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Who was not messaged, and why
          </p>
          <div className="divide-y rounded-lg border bg-card">
            {skipped.sort((a, b) => b.count - a.count).map((s) => (
              <Row key={s.reason} title={reasonLabel(s.reason)} value={s.count.toLocaleString('en-IN')} />
            ))}
          </div>
        </section>
      )}

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Running right now
        </p>
        <div className="divide-y rounded-lg border bg-card">
          <Row title={`${counts.live.toLocaleString('en-IN')} journeys still going`} value="" />
          <Row title={`${counts.ended.toLocaleString('en-IN')} have ended`} value="" />
        </div>
      </section>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Did it actually cause anything
        </p>
        {controlled ? (
          <>
            <div className="divide-y rounded-lg border bg-card">
              <Row title="Not held back — goal met" sub={`${counts.treated.toLocaleString('en-IN')} patients, messaged or not`}
                value={`${rates.treatedPct}%`} />
              <Row title="Held back — goal met anyway" sub={`${counts.held.toLocaleString('en-IN')} patients`}
                value={`${rates.heldPct}%`} />
              <Row strong title="Goal met because of this"
                sub={`Between ${Math.max(0, Math.round((rates.liftPts! - rates.liftMarginPts!) / 100 * counts.treated))} and ${Math.round((rates.liftPts! + rates.liftMarginPts!) / 100 * counts.treated)}`}
                value={(money.incrementalPatients ?? 0).toLocaleString('en-IN')} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              ±{rates.liftMarginPts} points is the honest width at these numbers: this design can detect a
              lift of about {Math.max(2, Math.ceil(rates.liftMarginPts!))} points and cannot detect a smaller one.
            </p>
          </>
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            <Row strong title="Nothing to compare against"
              sub="Nobody is held back on this journey, so someone it brought in and someone who would have come anyway look the same. Hold back a control group to measure it."
              value="—" />
          </div>
        )}
      </section>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Money</p>
        <div className="divide-y rounded-lg border bg-card">
          <Row title="Discount given" sub={`${money.couponsRedeemed} offers used`}
            value={`− ${rupees(money.discountGivenInPaise)}`} />
          <Row title="WhatsApp cost" sub={money.messageCostNote} value="—" />
        </div>
      </section>

      {branchSplit.sameBranch + branchSplit.otherBranch > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Where they came
          </p>
          <div className="divide-y rounded-lg border bg-card">
            <Row title="Same branch as the visit" value={branchSplit.sameBranch.toLocaleString('en-IN')} />
            <Row title="A different branch" sub="Counted — revenue is revenue"
              value={branchSplit.otherBranch.toLocaleString('en-IN')} />
          </div>
        </section>
      )}
    </div>
  );
}

/** Every night this report has been responsible for, newest first. */
function Nights({ data }: { data: ScheduledResults }) {
  const { nights, totals } = data;

  if (nights.length === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
        No nights recorded yet. The first one appears after tonight's send.
      </p>
    );
  }

  const tone = (outcome: string) =>
    outcome === 'SENT' ? 'border-emerald-200 text-emerald-700'
    : outcome === 'ALREADY_SENT_BY_OLD_TICKER' ? 'text-muted-foreground'
    : 'border-destructive/30 text-destructive';

  const label = (outcome: string) =>
    outcome === 'SENT' ? 'Sent'
    : outcome === 'ALREADY_SENT_BY_OLD_TICKER' ? 'Older sender got there first'
    : reasonLabel(outcome);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          { n: totals.nightsRecorded, label: 'Nights recorded' },
          { n: totals.sent, label: 'Messages sent' },
          { n: totals.failed, label: 'Failed' },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border p-3.5">
            <p className={`text-xl font-semibold tabular-nums ${
              k.label === 'Failed' && k.n > 0 ? 'text-destructive' : ''}`}>{k.n}</p>
            <p className="text-xs text-muted-foreground">{k.label}</p>
          </div>
        ))}
      </div>

      {totals.handedOver > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3 text-sm">
          <b>{totals.handedOver}</b> branch-night{totals.handedOver === 1 ? '' : 's'} went out on the
          older sender. That should not happen now that this automation owns them — the old schedule
          stands aside for any branch covered here. If it keeps appearing, this automation was not
          enabled at the time, or its branch list does not cover that branch.
        </p>
      )}

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Night by night
        </p>
        <div className="divide-y rounded-lg border bg-card">
          {nights.map((n) => (
            <div key={n.night} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium tabular-nums">{n.night}</span>
                <span className="flex-1" />
                {n.failed > 0 && (
                  <Badge variant="outline" className="border-destructive/30 text-[11px] font-normal text-destructive">
                    {n.failed} failed
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {n.sent} sent{n.handedOver > 0 && ` · ${n.handedOver} on the older sender`}
                </span>
              </div>
              <div className="mt-1.5 space-y-1">
                {n.branches.map((b, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className={`shrink-0 text-[11px] font-normal ${tone(b.outcome)}`}>
                      {label(b.outcome)}
                    </Badge>
                    <span className="text-muted-foreground">{b.branch}</span>
                    <span className="text-muted-foreground">
                      {new Date(b.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
