/**
 * Try it out — pick a patient, add events on a fake clock, watch the journey run.
 *
 * This is the offline test harness with a screen on it: the same predicates, the same
 * policy gate, the same step walk. That is the only reason its answer can be trusted to
 * match what production will do — a simulator built separately is a second
 * implementation, and a second implementation is a second set of bugs.
 *
 * Nothing is sent. Nothing is written.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, X, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  simulateAutomation, previewAutomation, reasonLabel,
  type SimulatedStep, type SimulatedEvent, type Automation,
} from './api';

/** The buttons this journey actually offers, so the picker is never a guess. */
function askButtons(automation?: Automation): { payload: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of automation?.definition.steps ?? []) {
    if (s.kind !== 'ASK') continue;
    for (const b of s.buttons) seen.set(b.payload, b.label);
  }
  return [...seen].map(([payload, label]) => ({ payload, label }));
}

export function SimulateDialog({ id, open, onClose, automation }: {
  id: string; open: boolean; onClose: () => void; automation?: Automation;
}) {
  const [visitId, setVisitId] = useState('');
  const [patientLabel, setPatientLabel] = useState('');
  const [events, setEvents] = useState<SimulatedEvent[]>([]);
  const buttons = askButtons(automation);
  const [steps, setSteps] = useState<SimulatedStep[] | null>(null);

  // Seed the picker from whoever actually qualifies, so the run is on a real shape of
  // patient rather than an id someone had to go and find.
  const { data: preview } = useQuery({
    queryKey: ['preview', id], queryFn: () => previewAutomation(id, 8), enabled: open,
  });

  const run = useMutation({
    mutationFn: () => simulateAutomation(id, { visitId, events }),
    onSuccess: (r) => setSteps(r.steps),
  });

  const reset = () => { setSteps(null); setEvents([]); setVisitId(''); setPatientLabel(''); };

  // An ASK is a message too — counting SENDs alone under-reported what she receives.
  const sent = (steps ?? []).filter(
    (s) => (s.kind === 'SEND' && s.outcome === 'SENT')
        || (s.kind === 'ASK' && s.outcome !== 'QUIET_HOURS' && s.outcome !== 'FREQUENCY_CAP'),
  ).length;
  const stopped = (steps ?? []).find((s) => s.kind === 'STOP');
  const offers = (steps ?? []).filter(
    (s) => s.kind === 'SEND' && s.outcome === 'SENT' && (s.detail as { offer?: string })?.offer,
  ).length;
  const handed = (steps ?? []).some((s) => s.kind === 'HANDOFF');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" /> Try it out
          </DialogTitle>
          <DialogDescription>
            Watch what would happen to one patient. Nothing is sent and nothing is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Start from</Label>
            {preview && preview.rows.length > 0 ? (
              <div className="mt-1.5 max-h-40 divide-y overflow-y-auto rounded-lg border">
                {preview.rows.map((r) => (
                  <button key={r.visitId}
                    onClick={() => {
                      setVisitId(r.visitId);
                      setPatientLabel(`${r.patientName} · ${r.branchName}`);
                      setSteps(null);
                    }}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50 ${
                      visitId === r.visitId ? 'bg-muted' : ''}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{r.patientName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {r.patientNumber} · {r.branchName} ·{' '}
                        {new Date(r.visitAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </span>
                    </span>
                    {visitId === r.visitId && <Badge variant="secondary" className="text-[11px]">Picked</Badge>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 rounded-lg border bg-muted/40 px-3 py-4 text-center text-sm text-muted-foreground">
                Nobody qualifies right now, so there is no real visit to try this on.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">What happens along the way</Label>
              <div className="flex items-center gap-3">
                {buttons.length > 0 && (
                  <button
                    onClick={() => {
                      setEvents([...events, { onDay: 2, kind: 'REPLIED', payload: buttons[0].payload }]);
                      setSteps(null);
                    }}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <Plus className="h-3 w-3" /> She replies
                  </button>
                )}
                <button
                  onClick={() => { setEvents([...events, { onDay: 6, kind: 'DIAGNOSTICS_DONE', valueInPaise: 240000 }]); setSteps(null); }}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <Plus className="h-3 w-3" /> She comes in
                </button>
              </div>
            </div>
            {events.length === 0 ? (
              <p className="mt-1.5 rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                Nothing added — she never answers and never comes in, which is the path most
                patients take. Add a reply to see the other half of the journey.
              </p>
            ) : (
              <div className="mt-1.5 divide-y rounded-lg border">
                {events.map((e, i) => {
                  const patch = (v: Partial<SimulatedEvent>) => {
                    const next = [...events];
                    next[i] = { ...e, ...v };
                    setEvents(next); setSteps(null);
                  };
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      {e.kind === 'REPLIED' ? (
                        <>
                          <span>She taps</span>
                          <Select
                            value={e.payload ?? '__other__'}
                            onValueChange={(v) => patch({ payload: v === '__other__' ? undefined : v })}>
                            <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {buttons.map((b) => (
                                <SelectItem key={b.payload} value={b.payload}>{b.label}</SelectItem>
                              ))}
                              <SelectItem value="__other__">types something else</SelectItem>
                            </SelectContent>
                          </Select>
                          <span>on day</span>
                        </>
                      ) : (
                        <span>She does her tests on day</span>
                      )}
                      <Input type="number" className="h-8 w-16"
                        value={e.onDay}
                        onChange={(ev) => patch({ onDay: Number(ev.target.value) })} />
                      <span className="flex-1 text-xs text-muted-foreground">not real — only for this run</span>
                      <button onClick={() => { setEvents(events.filter((_, j) => j !== i)); setSteps(null); }}
                        className="text-muted-foreground hover:text-destructive">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {steps && (
            <div>
              <Label className="text-xs">What would happen</Label>
              <div className="mt-1.5 divide-y rounded-lg border">
                {steps.map((s, i) => {
                  const skipped = s.kind === 'SEND' && s.outcome !== 'SENT';
                  return (
                    <div key={i}
                      className={`flex items-start gap-3 px-3 py-2.5 text-sm ${skipped ? 'opacity-55' : ''}`}>
                      <span className="w-16 shrink-0 text-xs font-semibold text-muted-foreground">
                        Day {s.day}
                      </span>
                      <span className="min-w-0 flex-1">
                        {s.kind === 'WAIT' && 'Waits'}
                        {s.kind === 'CHECK' && (s.outcome === 'CHECK_TRUE'
                          ? 'Checks — yes' : 'Checks — not yet')}
                        {s.kind === 'SEND' && (
                          <>
                            {s.outcome === 'SENT' ? 'Sends ' : 'Would send '}
                            <code className="rounded bg-muted px-1 text-xs">
                              {(s.detail as { template?: string })?.template}
                            </code>
                            {(s.detail as { offer?: string })?.offer && s.outcome === 'SENT' && ' and issues the offer'}
                            {(s.detail as { reusedExistingCoupon?: boolean })?.reusedExistingCoupon &&
                              ' with the code she already has'}
                          </>
                        )}
                        {s.kind === 'ASK' && (
                          <>
                            Asks{' '}
                            <code className="rounded bg-muted px-1 text-xs">
                              {(s.detail as { template?: string })?.template}
                            </code>
                            {(s.detail as { answered?: string })?.answered
                              ? ` — she taps "${(s.detail as { answered?: string }).answered}"`
                              : s.outcome === 'NO_REPLY'
                                ? ` — no answer in ${(s.detail as { waitHours?: number })?.waitHours ?? 24} hours`
                                : ''}
                          </>
                        )}
                        {s.kind === 'HANDOFF' && <b>Goes to a person — the journey ends here</b>}
                        {s.kind === 'DAY_SHEET' && 'Sends the day sheet'}
                        {s.kind === 'STOP' && <b>Journey stops — {reasonLabel(s.outcome)}</b>}
                      </span>
                      {(s.kind === 'SEND' || s.kind === 'ASK') && (
                        <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
                          {s.outcome === 'SENT' ? 'Sent' : reasonLabel(s.outcome)}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 rounded-lg bg-muted px-3 py-2.5 text-sm">
                <b>{sent} message{sent === 1 ? '' : 's'} sent</b>
                {offers === 0 ? ' · no discount given' : ` · ${offers} offer${offers === 1 ? '' : 's'} issued`}
                {handed && ' · a person picks it up'}
                {stopped && ` · ${reasonLabel(stopped.outcome).toLowerCase()}`}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Close</Button>
          <Button disabled={!visitId || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running…' : steps ? 'Run again' : 'Run it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
