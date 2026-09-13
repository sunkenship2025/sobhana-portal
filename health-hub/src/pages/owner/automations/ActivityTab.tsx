/**
 * Activity, and one run's whole story.
 *
 * The filter that matters is Why: "show me everyone skipped because they already came"
 * is the question an operator actually has, and its options are the reason codes that
 * are genuinely present, never a hardcoded list that drifts from what the engine emits.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { LoadingState } from '@/components/ui/loading-state';
import { toast } from 'sonner';
import {
  getActivity, getActivityReasons, getRun, stopRun, listAutomations,
  reasonLabel, vocabOf, rupees, type ActivityRow,
} from './api';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });

function OutcomeBadge({ code }: { code: string }) {
  const vocab = vocabOf(code);
  const tone =
    code === 'SENT' || code === 'STOPPED_GOAL_MET' ? 'text-emerald-700 border-emerald-200'
    : code === 'SEND_FAILED' || code === 'UNIT_MISMATCH' ? 'text-destructive border-destructive/30'
    : code.startsWith('WAITING') || code === 'FREQUENCY_CAP' || code === 'QUIET_HOURS'
      ? 'text-amber-700 border-amber-200'
      : 'text-muted-foreground';
  return vocab === 'outcome'
    ? <Badge variant="secondary" className="shrink-0 text-[11px] font-normal">{reasonLabel(code)}</Badge>
    : <Badge variant="outline" className={`shrink-0 text-[11px] font-normal ${tone}`}>{reasonLabel(code)}</Badge>;
}

export function ActivityTab({ automationId }: { automationId?: string }) {
  const [outcome, setOutcome] = useState('all');
  const [days, setDays] = useState('7');
  const [autoId, setAutoId] = useState(automationId ?? 'all');
  const [q, setQ] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);

  const { data: reasons } = useQuery({ queryKey: ['activity-reasons'], queryFn: getActivityReasons });
  const { data: automations } = useQuery({ queryKey: ['automations'], queryFn: listAutomations });

  const { data, isLoading } = useQuery({
    queryKey: ['activity', autoId, outcome, days],
    queryFn: () => getActivity({
      automationId: autoId === 'all' ? undefined : autoId,
      outcome: outcome === 'all' ? undefined : outcome,
      days: Number(days),
      limit: 60,
    }),
  });

  const rows = (data?.rows ?? []).filter(
    (r) => q === '' || r.patient?.name.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Activity</h2>
        <p className="text-sm text-muted-foreground">
          What each journey did, and what it chose not to do.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!automationId && (
          <Select value={autoId} onValueChange={setAutoId}>
            <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All automations</SelectItem>
              {(automations?.automations ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="h-9 w-56"><SelectValue placeholder="Why" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Why: anything</SelectItem>
            {(reasons?.reasons ?? []).map((r) => (
              <SelectItem key={r.outcome} value={r.outcome}>
                {reasonLabel(r.outcome)} ({r.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Today</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="h-9 w-48 pl-8" placeholder="Search a patient…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {isLoading ? <LoadingState /> : rows.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing in this window. Activity appears as journeys run.
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setOpenRun(r.runId)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
              <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">{when(r.at)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {r.patient ? `${r.patient.name} · ` : ''}{r.automation}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  Step {r.stepIndex + 1} · v{r.version}
                </span>
              </span>
              <OutcomeBadge code={r.outcome} />
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      <RunSheet runId={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}

/** Why she entered · what happened · why it stopped · what is next. One step log. */
export function RunSheet({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: run, isLoading } = useQuery({
    queryKey: ['run', runId],
    queryFn: () => getRun(runId!),
    enabled: !!runId,
  });

  const stop = useMutation({
    mutationFn: () => stopRun(runId!),
    onSuccess: () => {
      toast.success('Stopped for this patient. The automation keeps running for everyone else.');
      qc.invalidateQueries({ queryKey: ['run', runId] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Sheet open={!!runId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {isLoading || !run ? <LoadingState /> : (
          <>
            <SheetHeader className="pb-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {run.automation.name} · v{run.version}
              </p>
              <SheetTitle className="text-base">
                {run.state === 'STOPPED' || run.state === 'DONE'
                  ? reasonLabel(run.stopReason ?? 'Finished')
                  : run.holdout ? 'Held back — never messaged' : 'Running'}
              </SheetTitle>
            </SheetHeader>

            <div className="space-y-5">
              {run.whyEntered && run.whyEntered.length > 0 && (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Why she entered
                  </p>
                  <div className="divide-y rounded-lg border">
                    {run.whyEntered.map((t, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2">
                        <Badge variant="outline" className={`shrink-0 text-[11px] font-normal ${
                          t.passed ? 'border-emerald-200 text-emerald-700' : 'border-destructive/30 text-destructive'}`}>
                          {t.passed ? '✓' : '×'}
                        </Badge>
                        <span className="min-w-0 flex-1 text-sm">{t.fn}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {String(t.fact)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    The values as they were read at the time — not recomputed now.
                  </p>
                </section>
              )}

              <section>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  What happened
                </p>
                <div className="divide-y rounded-lg border">
                  {run.timeline.map((t, i) => (
                    <div key={i} className="flex items-start gap-3 px-3 py-2.5">
                      <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {when(t.at)}
                      </span>
                      <span className="min-w-0 flex-1 text-sm">{reasonLabel(t.outcome)}</span>
                    </div>
                  ))}
                </div>
              </section>

              {run.next && (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    What happens next
                  </p>
                  <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                    {run.next.at ? when(run.next.at) : 'Soon'} — the stop condition is re-checked first.
                    If she has come in, nothing more is sent.
                  </div>
                </section>
              )}

              {run.convertedAt && (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Came in
                  </p>
                  <div className="rounded-lg border px-3 py-2.5 text-sm">
                    {when(run.convertedAt)}
                    {run.convertedValueInPaise != null && ` · ${rupees(run.convertedValueInPaise)}`}
                  </div>
                </section>
              )}

              {(run.state === 'PENDING' || run.state === 'RUNNING') && (
                <div>
                  <Button variant="outline" className="w-full text-destructive"
                    disabled={stop.isPending} onClick={() => stop.mutate()}>
                    Stop this journey for her
                  </Button>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Ends this one patient's journey. The automation keeps running for everyone else.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
