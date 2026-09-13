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
import { getResults, reasonLabel, rupees, type ScheduledResults } from './api';

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

  if (isLoading) return <LoadingState />;
  if (!data) return null;

  // A report to your own team has no funnel. The only questions are whether last night
  // went out and whether any night has failed.
  if ('kind' in data && data.kind === 'SCHEDULE') return <Nights data={data} />;

  const { counts, converted, rates, skipped, money, branchSplit, windowDays } = data;
  const base = Math.max(1, counts.runs);
  const pct = (n: number) => (n / base) * 100;
  const couldBeMessaged = counts.treated - skipped.reduce((n, s) => n + s.count, 0);

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
          { n: counts.delivered.toLocaleString('en-IN'), label: 'Delivered' },
          { n: `${rates.treatedPct}%`, label: 'Came in' },
          { n: `+${rates.liftPts} pts`, label: `Lift vs control · ±${rates.liftMarginPts}`, good: true },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border p-3.5">
            <p className={`text-xl font-semibold tabular-nums ${k.good ? 'text-emerald-600' : ''}`}>{k.n}</p>
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
          <Stage label="Could be messaged" n={Math.max(0, couldBeMessaged)} pct={pct(couldBeMessaged)}
            note={`−${counts.runs - couldBeMessaged}`} />
          <Stage label="Message sent" n={counts.sent} pct={pct(counts.sent)} />
          <Stage label="Delivered" n={counts.delivered} pct={pct(counts.delivered)} />
          <Stage label="Read" sub="undercounts — receipts can be switched off"
            n={counts.read} pct={pct(counts.read)} note="at least" />
          <Stage label="Came in for tests" sub={`within ${windowDays} days, any branch`}
            n={converted.treated} pct={pct(converted.treated)} note={`${rates.treatedPct}%`} />
          <Stage label="Held back, came anyway" n={converted.held}
            pct={pct(converted.held)} note={`${rates.heldPct}%`} muted />
        </div>
      </section>

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
        <div className="divide-y rounded-lg border bg-card">
          <Row title="Messaged — came in" sub={`${counts.delivered.toLocaleString('en-IN')} delivered`}
            value={`${rates.treatedPct}%`} />
          <Row title="Held back — came anyway" sub={`${counts.held.toLocaleString('en-IN')} patients`}
            value={`${rates.heldPct}%`} />
          <Row strong title="Patients who came because of this"
            sub={counts.held === 0
              ? 'No control group — this is a count, not a lift'
              : `Between ${Math.max(0, Math.round((rates.liftPts - rates.liftMarginPts) / 100 * counts.treated))} and ${Math.round((rates.liftPts + rates.liftMarginPts) / 100 * counts.treated)}`}
            value={money.incrementalPatients.toLocaleString('en-IN')} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          ±{rates.liftMarginPts} points is the honest width at these numbers: this design can detect a
          lift of about {Math.max(2, Math.ceil(rates.liftMarginPts))} points and cannot detect a smaller one.
        </p>
      </section>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Money</p>
        <div className="divide-y rounded-lg border bg-card">
          <Row title="Discount given" sub={`${money.couponsRedeemed} offers used`}
            value={`− ${rupees(money.discountGivenInPaise)}`} />
          <Row title="WhatsApp cost" sub={money.messageCostNote} value="—" />
        </div>
      </section>

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
