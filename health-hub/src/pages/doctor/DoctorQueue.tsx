/**
 * The doctor's landing screen: the existing OP/IP queue, scoped and de-monetised.
 *
 * This is deliberately the SAME shape as ClinicVisitQueue rather than a new
 * concept — same grouping, same Start / Mark Done, same token numbers the
 * waiting-room display already calls. Two things differ: it is filtered to this
 * doctor's own consultations, and the payment badge is gone.
 *
 * Unsigned prescriptions are a strip on this page, not a separate destination.
 * A draft belongs to a visit that is in or has just left this queue, so a "Drafts"
 * page would have been a concept with no home.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from 'sonner';
import { Mic, Search, ChevronRight, AlertTriangle, Stethoscope } from 'lucide-react';
import { doctorApi, type QueueRow, type DraftRow, DoctorApiError } from '@/lib/doctorApi';

/** "18 min" / "2 h 10 m" — how long they have been waiting, in words. */
function waitedFor(since: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} m`;
}

function ageOfDraft(created: string): { label: string; stale: boolean } {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(created).getTime()) / 60000));
  if (mins < 60) return { label: `${mins} min ago`, stale: false };
  const h = Math.floor(mins / 60);
  // Past a few hours the patient has left and the doctor believes they prescribed.
  // That is the dangerous state this strip exists to make loud.
  return { label: `${h} h ago`, stale: h >= 3 };
}

export default function DoctorQueue() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [q, d] = await Promise.all([doctorApi.queue(), doctorApi.drafts()]);
      setRows(q.queue);
      setDrafts(d);
    } catch (err) {
      const msg = err instanceof DoctorApiError && err.body?.error === 'NO_CLINIC_DOCTOR'
        ? err.message
        : 'Could not load your queue.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The queue moves while the doctor is looking at it — staff register walk-ins
    // and mark people done. Poll rather than leave a stale list on screen.
    const t = setInterval(() => void load(), 20000);
    return () => clearInterval(t);
  }, [load]);

  const { waiting, inProgress, done } = useMemo(
    () => ({
      waiting: rows.filter((r) => r.status === 'WAITING'),
      inProgress: rows.filter((r) => r.status === 'IN_PROGRESS'),
      done: rows.filter((r) => r.status === 'COMPLETED'),
    }),
    [rows],
  );

  const open = useCallback(
    async (row: QueueRow, start: boolean) => {
      setBusy(row.visitId);
      try {
        if (start && row.status === 'WAITING') {
          await doctorApi.setVisitStatus(row.visitId, 'IN_PROGRESS');
        }
        navigate(`/doctor/consult/${row.visitId}`);
      } catch {
        toast.error('Could not open the consultation');
      } finally {
        setBusy(null);
      }
    },
    [navigate],
  );

  const callNext = useCallback(async () => {
    setBusy('next');
    try {
      const { visitId } = await doctorApi.callNext();
      navigate(`/doctor/consult/${visitId}`);
    } catch (err) {
      toast.error(err instanceof DoctorApiError && err.status === 404 ? 'Nobody is waiting' : 'Could not call the next patient');
    } finally {
      setBusy(null);
    }
  }, [navigate]);

  const Row = ({ row }: { row: QueueRow }) => (
    <button
      type="button"
      onClick={() => void open(row, true)}
      disabled={busy === row.visitId}
      className="group flex w-full items-center gap-3 border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:gap-4 sm:px-4"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold tabular-nums"
        aria-label={row.tokenNumber ? `Token ${row.tokenNumber}` : 'No token'}
      >
        {row.tokenNumber ?? '—'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[15px] font-semibold">{row.patient.name}</span>
          {row.patient.deceased && <Badge variant="destructive" className="h-5">Deceased</Badge>}
          {row.isRevisit && <Badge variant="secondary" className="h-5">Revisit</Badge>}
          {row.prescription?.status === 'DRAFT' && (
            <Badge className="h-5 border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-50">Draft open</Badge>
          )}
          {row.prescription?.status === 'SIGNED' && (
            <Badge className="h-5 border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">Signed</Badge>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {row.patient.ageLabel} · {row.patient.gender} · {row.patient.patientNumber}
          {row.ward ? ` · ${row.ward}` : ''}
        </span>
      </span>

      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
        <Badge variant="outline" className="mr-2 h-5">{row.visitType}</Badge>
        {row.status === 'WAITING' ? waitedFor(row.waitingSince) : row.status === 'IN_PROGRESS' ? 'in progress' : 'done'}
      </span>

      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );

  const Section = ({ title, items }: { title: string; items: QueueRow[] }) =>
    items.length === 0 ? null : (
      <div>
        <h2 className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-4">
          {title} · {items.length}
        </h2>
        <div className="rounded-lg border bg-card">
          {items.map((r) => <Row key={r.clinicVisitId} row={r} />)}
        </div>
      </div>
    );

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-4xl space-y-1 p-4 sm:p-6">
        <div className="flex flex-wrap items-end gap-3 border-b pb-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">OP / IP queue</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
              {' · '}
              <span className="tabular-nums">{waiting.length}</span> waiting ·{' '}
              <span className="tabular-nums">{inProgress.length}</span> in progress ·{' '}
              <span className="tabular-nums">{done.length}</span> done
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate('/doctor/patients')}>
              <Search className="mr-2 h-4 w-4" aria-hidden="true" />
              Find patient
            </Button>
            <Button size="sm" onClick={() => void callNext()} disabled={busy === 'next' || waiting.length === 0}>
              <Mic className="mr-2 h-4 w-4" aria-hidden="true" />
              Call next
            </Button>
          </div>
        </div>

        {/* Unsigned prescriptions. Ageing is the whole point of this strip: 20
            minutes is a live consultation, 17 hours is a mistake. */}
        {drafts.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 sm:p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-amber-900">
                  {drafts.length} prescription{drafts.length > 1 ? 's' : ''} not signed
                </p>
                <p className="mt-0.5 text-xs text-amber-800">Nothing here has been issued to a patient.</p>
                <ul className="mt-2 space-y-1">
                  {drafts.map((d) => {
                    const age = ageOfDraft(d.createdAt);
                    return (
                      <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <button
                          type="button"
                          className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950"
                          onClick={() => navigate(`/doctor/consult/${d.visitId}`)}
                        >
                          {d.visit.patient.name}
                        </button>
                        <span className={age.stale ? 'text-xs font-semibold text-red-700' : 'text-xs text-amber-700'}>
                          {age.label}
                        </span>
                        <span className="text-xs text-amber-700">
                          {d.items.length} medicine{d.items.length === 1 ? '' : 's'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="mt-4 space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
          </div>
        ) : error ? (
          <div className="mt-6 rounded-lg border bg-card p-6 text-center">
            <p className="text-sm font-medium">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>Try again</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={Stethoscope}
              title="Nobody in your queue"
              description="Patients appear here the moment the front desk registers them for your consultation."
            />
          </div>
        ) : (
          <>
            <Section title="In progress" items={inProgress} />
            <Section title="Waiting" items={waiting} />
            <Section title="Done today" items={done} />
          </>
        )}
      </div>
    </AppLayout>
  );
}
