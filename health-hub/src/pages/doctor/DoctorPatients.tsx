/**
 * Patient search + the clinical patient view.
 *
 * Deliberately the SAME skeleton as the staff Patient 360 — header, glance strip,
 * timeline left, detail right — because it is that page with panels withheld.
 * Money is absent by construction (the endpoint never returns it), and tests are
 * absent unless the clinic has turned diagnostics on.
 *
 * Searching for a patient this doctor has never treated returns the patient and
 * asks WHY before opening it. Every documented clinical-privacy incident on
 * record was standing access misused, so the default starts narrow.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Search, ArrowLeft, ShieldAlert, Users, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { doctorApi, DoctorApiError, type DoctorPatient } from '@/lib/doctorApi';

type SearchRow = Awaited<ReturnType<typeof doctorApi.searchPatients>>[number];

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function DoctorPatients() {
  const { patientId } = useParams<{ patientId?: string }>();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<number | undefined>(undefined);

  const [data, setData] = useState<DoctorPatient | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsReason, setNeedsReason] = useState<{ name: string } | null>(null);
  const [reason, setReason] = useState('');
  const [selectedVisit, setSelectedVisit] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      setSearching(true);
      try { setRows(await doctorApi.searchPatients(q.trim())); }
      catch { setRows([]); }
      finally { setSearching(false); }
    }, 250);
    return () => window.clearTimeout(debounce.current);
  }, [q]);

  const open = useCallback(async (id: string, why?: string) => {
    setLoading(true);
    try {
      const d = await doctorApi.patient(id, why);
      setData(d);
      setNeedsReason(null);
      setReason('');
      setSelectedVisit(d.timeline[0]?.visitId ?? null);
    } catch (err) {
      if (err instanceof DoctorApiError && err.status === 428) {
        setNeedsReason({ name: err.body?.patient?.name ?? 'this patient' });
        setData(null);
      } else {
        toast.error('Could not open the patient');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (patientId) void open(patientId);
    else { setData(null); setNeedsReason(null); }
  }, [patientId, open]);

  // ---- SEARCH -------------------------------------------------------------
  if (!patientId) {
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
          <div className="border-b pb-4">
            <h1 className="text-xl font-semibold tracking-tight">Patients</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Search by name, patient number or phone.</p>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)} autoFocus
              placeholder="Name, P-number or phone…" className="h-11 pl-9" aria-label="Search patients"
            />
            {searching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>

          {rows.length > 0 ? (
            <ul className="divide-y rounded-lg border bg-card">
              {rows.map((p) => (
                <li key={p.id}>
                  <button
                    type="button" onClick={() => navigate(`/doctor/patients/${p.id}`)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        {p.deceased && <Badge variant="destructive" className="h-5">Deceased</Badge>}
                        {!p.myPatient && <Badge variant="outline" className="h-5">Not your patient</Badge>}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {p.ageLabel} · {p.gender} · {p.patientNumber}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : q.trim().length >= 2 && !searching ? (
            <EmptyState icon={Users} title="No patients found" description="Try a phone number or the P-number from their card." />
          ) : null}
        </div>
      </AppLayout>
    );
  }

  // ---- BREAK THE GLASS ----------------------------------------------------
  if (needsReason) {
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-lg p-6">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-5">
            <ShieldAlert className="h-6 w-6 text-amber-700" aria-hidden="true" />
            <h1 className="mt-2 text-lg font-semibold text-amber-950">You have not treated {needsReason.name}</h1>
            <p className="mt-1 text-sm text-amber-900">
              You can still open this record, but the reason is logged and the owner can read it.
            </p>
            <Textarea
              value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
              className="mt-3 bg-white" placeholder="Why do you need this record? e.g. covering for Dr Anitha today"
              aria-label="Reason for access"
            />
            <div className="mt-3 flex gap-2">
              <Button variant="outline" onClick={() => navigate('/doctor/patients')}>Cancel</Button>
              <Button onClick={() => void open(patientId, reason.trim())} disabled={reason.trim().length < 5}>
                Open record
              </Button>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (loading || !data) {
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-5xl space-y-3 p-4 sm:p-6">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppLayout>
    );
  }

  const visit = data.timeline.find((t) => t.visitId === selectedVisit) ?? null;
  const visitRx = visit?.prescriptionId ? data.prescriptions.find((p) => p.id === visit.prescriptionId) : null;

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 border-b pb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/doctor/patients')}>
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Search
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">{data.patient.name}</h1>
            <p className="text-xs text-muted-foreground">
              {data.patient.ageLabel} · {data.patient.gender} · {data.patient.patientNumber}
              {data.patient.phone ? ` · ${data.patient.phone}` : ''}
            </p>
          </div>
          {data.patient.deceased && <Badge variant="destructive">Deceased</Badge>}
          {data.breakGlass && <Badge className="border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-50">Access logged</Badge>}
        </div>

        {/* Glance strip — entirely about medication now. No outstanding due. */}
        <div className="grid grid-cols-2 divide-x divide-y rounded-lg border bg-card sm:grid-cols-4 sm:divide-y-0">
          {[
            { label: 'Last consultation', value: fmt(data.glance.lastConsultation), sub: data.glance.lastConsultationDoctor },
            { label: 'Consultations', value: String(data.glance.consultations) },
            { label: 'Prescriptions', value: String(data.glance.prescriptions), sub: 'signed' },
            { label: 'Currently on', value: String(data.glance.currentlyOn), sub: 'medicines' },
          ].map((c) => (
            <div key={c.label} className="p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</p>
              <p className="mt-0.5 text-base font-semibold tabular-nums">{c.value}</p>
              {c.sub && <p className="text-xs text-muted-foreground">{c.sub}</p>}
            </div>
          ))}
        </div>

        {data.currentMedications.length > 0 && (
          <section className="rounded-lg border bg-card p-3 sm:p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Currently on</h2>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {data.currentMedications.map((m) => (
                <li key={m.name} className="text-sm font-medium">{m.name}</li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <section className="rounded-lg border bg-card">
            <h2 className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Timeline</h2>
            <ul className="divide-y">
              {data.timeline.map((t) => (
                <li key={t.visitId}>
                  <button
                    type="button" onClick={() => setSelectedVisit(t.visitId)}
                    className={cn(
                      'flex w-full gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50',
                      selectedVisit === t.visitId && 'bg-muted',
                      // Cancelled visits STAY visible, dimmed and badged. A doctor
                      // reading history must see a cancellation, not a hole.
                      t.status === 'CANCELLED' && 'opacity-60',
                    )}
                  >
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">{fmt(t.date)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">
                          {t.visitType ? `${t.visitType} consultation` : t.domain === 'DIAGNOSTICS' ? 'Diagnostics' : 'Visit'}
                        </span>
                        {t.status === 'CANCELLED' && <Badge variant="secondary" className="h-5">Cancelled</Badge>}
                        {t.prescriptionId && <Badge className="h-5 border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">Rx</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[t.doctorName, t.branchName, t.ward].filter(Boolean).join(' · ')}
                        {t.tests?.length ? ` · ${t.tests.join(', ')}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border bg-card p-3 sm:p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {visit ? `${fmt(visit.date)} · ${visit.visitType ?? visit.domain}` : 'Select a visit'}
            </h2>
            {visitRx ? (
              <ul className="mt-2 divide-y">
                {visitRx.items.map((i, n) => (
                  <li key={n} className="py-2 first:pt-0">
                    <p className="text-sm font-medium">
                      {i.canonicalName}{i.strength && !i.canonicalName.includes(i.strength) ? ` ${i.strength}${i.strengthUnit ?? ''}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[i.doseQty ? `${i.doseQty} ${i.doseUnit ?? ''}`.trim() : null, i.frequencyText, i.timing,
                        i.durationValue ? `${i.durationValue} ${i.durationUnit}` : null].filter(Boolean).join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {visit ? 'No prescription recorded on this visit.' : 'Pick a visit on the left.'}
              </p>
            )}

            {!data.diagnosticsVisible && (
              <p className="mt-4 rounded-md border border-dashed bg-muted/30 p-2.5 text-xs text-muted-foreground">
                Test results are not shown in the doctor portal. The owner can enable them.
              </p>
            )}
          </section>
        </div>
      </div>
    </AppLayout>
  );
}
