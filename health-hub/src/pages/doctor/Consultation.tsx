/**
 * The consultation — where the prescription is written.
 *
 * Patient context left, prescription right, one commit bar. The microphone is a
 * CONTROL IN THE COMPOSER, not a chat window: dictation fills the same fields the
 * doctor would have typed, and every field stays editable afterwards.
 *
 * Signing is a separate screen (see the `review` state) because it is the one
 * irreversible act, and because FDA's own test for whether clinical software
 * counts as "independently reviewable" explicitly disqualifies time-critical
 * flows. Fast here comes from typing less, never from reviewing less.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import {
  Mic, Square, Loader2, ArrowLeft, RotateCcw, AlertTriangle, Printer, Check, Send,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { RxItemEditor } from '@/components/doctor/RxItemEditor';
import { MedicineTypeahead } from '@/components/doctor/MedicineTypeahead';
import { RxQuestionQueue } from '@/components/doctor/RxQuestionQueue';
import { RxLetterpad, type RxProfile } from '@/components/doctor/RxLetterpad';
import {
  doctorApi, DoctorApiError, itemSig, itemTitle, openQuestions,
  type Prescription, type RxItem, type Finding, type Capabilities, type ExtractedItem,
  type VisitContext,
} from '@/lib/doctorApi';

/** Turn an extracted item into an editable row. */
const fromExtracted = (e: ExtractedItem): RxItem => ({
  spokenText: e.spokenText,
  medicationId: null,
  canonicalName: e.name || e.spokenText,
  genericName: null, brandName: null,
  strength: e.strength, strengthUnit: e.strengthUnit, dosageForm: e.dosageForm,
  doseQty: e.doseQty, doseUnit: e.doseUnit,
  frequencyCode: e.frequencyCode, frequencyText: e.frequencyText,
  route: e.route, timing: e.timing,
  durationValue: e.durationValue, durationUnit: e.durationUnit,
  instructions: e.instructions,
  resolution: 'MANUAL',
  candidates: null,
  fieldStates: { ...e.fieldStates, isAlternative: e.isAlternative },
  sourceText: e.sourceText, sourceStart: e.sourceStart, sourceEnd: e.sourceEnd,
});

const blankItem = (): RxItem => ({
  spokenText: null, medicationId: null, canonicalName: '', genericName: null, brandName: null,
  strength: null, strengthUnit: null, dosageForm: null, doseQty: '1', doseUnit: null,
  frequencyCode: null, frequencyText: null, route: null, timing: null,
  durationValue: null, durationUnit: 'days', instructions: null,
  resolution: 'MANUAL', candidates: null, fieldStates: null,
  sourceText: null, sourceStart: null, sourceEnd: null,
});

export default function Consultation() {
  const { visitId } = useParams<{ visitId: string }>();
  const navigate = useNavigate();

  const [ctx, setCtx] = useState<VisitContext | null>(null);
  const [rx, setRx] = useState<Prescription | null>(null);
  const [items, setItems] = useState<RxItem[]>([]);
  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [followUpDays, setFollowUpDays] = useState<string>('');
  const [missing, setMissing] = useState<string[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [review, setReview] = useState(false);
  const [profile, setProfile] = useState<RxProfile>('digital');
  const [attested, setAttested] = useState(false);
  const [signing, setSigning] = useState(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const silenceTimer = useRef<number | undefined>(undefined);

  const signed = rx?.status === 'SIGNED';
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);

  /** Send the patient their link. Never fired automatically — see the button. */
  const doSend = useCallback(async () => {
    if (!rx) return;
    setSending(true);
    try {
      const r = await doctorApi.send(rx.id);
      if (r.sent?.success) {
        setSentAt(Date.now());
        toast.success('Prescription sent to the patient on WhatsApp');
      } else {
        // The server's reason, verbatim: "not opted in", "no phone on file",
        // "online access is switched off for this visit" are all different
        // problems with different fixes, and a generic failure helps nobody.
        toast.error(r.sent?.error || 'Could not send the prescription');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the prescription');
    } finally {
      setSending(false);
    }
  }, [rx]);

  // --- load ----------------------------------------------------------------
  const load = useCallback(async () => {
    if (!visitId) return;
    try {
      setLoadError(null);
      const [context, existing, capabilities] = await Promise.all([
        // Through doctorApi like every other call: a hand-rolled fetch here used
        // VITE_API_URL, which is not this app's variable (it is VITE_API_BASE_URL,
        // read once in lib/api). The request 404'd and the page sat in its
        // loading skeleton forever — invisible to typecheck, build and lint, and
        // caught only by loading the page in a browser.
        doctorApi.visitContext(visitId),
        doctorApi.forVisit(visitId).catch(() => [] as Prescription[]),
        doctorApi.capabilities().catch(() => null),
      ]);
      setCtx(context);
      setCaps(capabilities);
      const open = existing.find((p) => p.status === 'DRAFT') ?? existing[0] ?? null;
      if (open) {
        setRx(open);
        setItems(open.items);
        setDiagnosis(open.diagnosis ?? '');
        setNotes(open.notes ?? '');
        setFollowUpDays(open.followUpDays != null ? String(open.followUpDays) : '');
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the consultation');
    } finally {
      setLoading(false);
    }
  }, [visitId]);

  useEffect(() => { void load(); }, [load]);

  // Release the microphone on unmount — an open mic is both a cost and, per the
  // Whisper research, a hallucination risk during long pauses.
  useEffect(() => () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    window.clearTimeout(silenceTimer.current);
  }, []);

  // --- persistence ---------------------------------------------------------
  const ensureDraft = useCallback(
    async (seed?: Partial<Parameters<typeof doctorApi.create>[0]>): Promise<Prescription> => {
      if (rx && rx.status === 'DRAFT') return rx;
      const created = await doctorApi.create({ visitId, ...(seed ?? {}) });
      setRx(created);
      return created;
    },
    [rx, visitId],
  );

  const save = useCallback(
    async (nextItems: RxItem[] = items): Promise<Prescription | null> => {
      if (!visitId) return null;
      setSaving(true);
      try {
        const draft = await ensureDraft();
        const updated = await doctorApi.update(draft.id, {
          diagnosis: diagnosis || null,
          notes: notes || null,
          followUpDays: followUpDays ? Number(followUpDays) : null,
          items: nextItems.map((i) => ({ ...i })),
        });
        setRx(updated);
        setItems(updated.items);
        const v = await doctorApi.validate(updated.id);
        setFindings(v.findings);
        return updated;
      } catch (err) {
        toast.error(err instanceof DoctorApiError ? err.message : 'Could not save');
        return null;
      } finally {
        setSaving(false);
      }
    },
    [items, diagnosis, notes, followUpDays, ensureDraft, visitId],
  );

  // --- dictation -----------------------------------------------------------
  const stopRecording = useCallback(() => {
    window.clearTimeout(silenceTimer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    setRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      const mr = new MediaRecorder(s, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' });
      chunks.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      mr.onstop = async () => {
        s.getTracks().forEach((t) => t.stop());
        stream.current = null;
        const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' });
        if (blob.size < 2000) { toast.error('Nothing was recorded'); return; }
        setThinking(true);
        try {
          const result = await doctorApi.transcribe(blob);
          const extracted = result.extraction.items.map(fromExtracted);
          // Dictation ADDS to what is already there rather than replacing it —
          // a doctor who typed two medicines and then spoke a third means three.
          const merged = [...items.filter((i) => i.canonicalName.trim()), ...extracted];
          setMissing(result.extraction.missing);
          if (result.extraction.diagnosis && !diagnosis) setDiagnosis(result.extraction.diagnosis);
          if (result.extraction.followUpDays != null && !followUpDays) setFollowUpDays(String(result.extraction.followUpDays));
          const draft = await ensureDraft({
            transcript: result.transcript.text,
            transcriptSegments: result.transcript.segments,
            asrProvider: result.transcript.provider,
            asrModel: result.transcript.model,
            asrLanguage: result.transcript.language,
            extractionModel: result.extraction.model,
          });
          const updated = await doctorApi.update(draft.id, { items: merged.map((i) => ({ ...i })) });
          setRx(updated);
          setItems(updated.items);
          const v = await doctorApi.validate(updated.id);
          setFindings(v.findings);
          toast.success(`Heard ${result.extraction.items.length} medicine${result.extraction.items.length === 1 ? '' : 's'}`);
        } catch (err) {
          // Never a dead end: the typed editor is always the fallback.
          toast.error(err instanceof DoctorApiError ? err.message : 'Could not transcribe — please type instead');
        } finally {
          setThinking(false);
        }
      };
      mr.start();
      recorder.current = mr;
      setRecording(true);
      // Hard stop at 3 minutes. An open mic left running is billed by the second
      // and, past a long pause, is where Whisper fabricates sentences.
      silenceTimer.current = window.setTimeout(() => stopRecording(), 180_000);
    } catch {
      toast.error('Microphone permission denied');
    }
  }, [items, diagnosis, followUpDays, ensureDraft, stopRecording]);

  // --- item editing --------------------------------------------------------
  const patchItem = useCallback((idx: number, patch: Partial<RxItem>) => {
    setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }, []);

  const removeItem = useCallback((idx: number) => {
    setItems((cur) => cur.filter((_, i) => i !== idx));
  }, []);

  const repeatLast = useCallback(() => {
    const last = ctx?.previousPrescriptions?.[0];
    if (!last) return;
    setItems((cur) => [
      ...cur,
      ...last.items.map((i) => ({
        ...blankItem(),
        canonicalName: i.canonicalName, strength: i.strength, strengthUnit: i.strengthUnit,
        doseQty: i.doseQty, doseUnit: i.doseUnit,
        frequencyCode: i.frequencyCode, frequencyText: i.frequencyText,
        timing: i.timing, durationValue: i.durationValue, durationUnit: i.durationUnit,
      })),
    ]);
    toast.success('Previous prescription copied — edit before signing');
  }, [ctx]);

  // --- sign ----------------------------------------------------------------
  const openReview = useCallback(async () => {
    const saved = await save();
    if (!saved) return;
    const v = await doctorApi.validate(saved.id);
    setFindings(v.findings);
    setReview(true);
    setAttested(false);
  }, [save]);

  const doSign = useCallback(
    async (andNext: boolean) => {
      if (!rx) return;
      setSigning(true);
      try {
        const result = await doctorApi.sign(rx.id, true);
        setRx(result);
        setItems(result.items);
        toast.success('Prescription signed');
        if (andNext) {
          try {
            const { visitId: nextId } = await doctorApi.callNext();
            navigate(`/doctor/consult/${nextId}`);
            return;
          } catch {
            navigate('/doctor');
            return;
          }
        }
        setReview(false);
      } catch (err) {
        toast.error(err instanceof DoctorApiError ? err.message : 'Could not sign');
      } finally {
        setSigning(false);
      }
    },
    [rx, navigate],
  );

  const finishWithout = useCallback(async () => {
    if (!visitId) return;
    try {
      await doctorApi.setVisitStatus(visitId, 'COMPLETED');
      toast.success('Consultation closed without a prescription');
      navigate('/doctor');
    } catch {
      toast.error('Could not close the visit');
    }
  }, [visitId, navigate]);

  const blocking = useMemo(() => findings.filter((f) => f.severity !== 'NOTE'), [findings]);
  // Gate on the QUEUE, not only on the validator: the point of the queue is that
  // the refusal arrives while the doctor is still writing, not at the last step.
  const unanswered = useMemo(() => openQuestions(items).length, [items]);
  const notesOnly = useMemo(() => findings.filter((f) => f.severity === 'NOTE'), [findings]);
  const canSign = blocking.length === 0 && items.length > 0;

  // --- render --------------------------------------------------------------
  if (loading) {
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-6xl space-y-3 p-4 sm:p-6">
          <Skeleton className="h-10 w-72" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (loadError || !ctx) {
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-lg p-6 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-destructive" aria-hidden="true" />
          <p className="mt-3 font-medium">{loadError ?? 'Consultation not found'}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/doctor')}>Back to queue</Button>
        </div>
      </AppLayout>
    );
  }

  const live = {
    doctor: ctx.doctor,
    branch: ctx.branch,
    patient: ctx.patient,
    visit: { visitType: ctx.visit.visitType, tokenNumber: ctx.visit.tokenNumber, date: ctx.visit.date },
  };

  // ---- REVIEW & SIGN ------------------------------------------------------
  if (review || signed) {
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-center gap-3 border-b pb-3">
            <Button variant="ghost" size="sm" onClick={() => (signed ? navigate('/doctor') : setReview(false))}>
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {signed ? 'Queue' : 'Back to edit'}
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight">{signed ? 'Signed prescription' : 'Review & sign'}</h1>
              <p className="text-xs text-muted-foreground">
                {ctx.patient.name} · {ctx.patient.ageLabel} {ctx.patient.gender} · {ctx.patient.patientNumber}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
              {(['digital', 'physical'] as RxProfile[]).map((p) => (
                <button
                  key={p} type="button" onClick={() => setProfile(p)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs capitalize transition-colors',
                    profile === p ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {p === 'physical' ? 'Physical letterhead' : 'Digital'}
                </button>
              ))}
            </div>
            {signed && (
              <>
                <Button variant="outline" size="sm" onClick={() => window.print()}>
                  <Printer className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Print
                </Button>
                {/* Explicit, never automatic on signing: a prescription is
                    sometimes amended a minute later, and a patient who already
                    has the first one on their phone must work out which is
                    current. The link resolves to the latest signed version, so
                    sending once, when the doctor is ready, is both simpler and
                    safer than sending on every signature. */}
                <Button variant="outline" size="sm" disabled={sending} onClick={() => void doSend()}>
                  {sending
                    ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                    : <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />}
                  {sentAt ? 'Send again' : 'Send to patient'}
                </Button>
              </>
            )}
          </div>

          <div className="rounded-lg bg-muted/40 p-3 sm:p-5">
            <RxLetterpad
              profile={profile}
              items={items}
              diagnosis={diagnosis || null}
              notes={notes || null}
              followUpDays={followUpDays ? Number(followUpDays) : null}
              snapshot={rx?.snapshot ?? null}
              live={live}
            />
          </div>

          {!signed && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 sm:p-4">
              <label className="flex max-w-md items-start gap-2.5 text-sm">
                <Checkbox
                  checked={attested}
                  onCheckedChange={(v) => setAttested(v === true)}
                  aria-label="Confirm review"
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">
                  I have reviewed all <span className="font-semibold text-foreground">{items.length} medicine{items.length === 1 ? '' : 's'}</span> above and I am prescribing them.
                </span>
              </label>
              <div className="ml-auto flex gap-2">
                <Button variant="outline" onClick={() => setReview(false)}>Back to edit</Button>
                <Button onClick={() => void doSign(false)} disabled={!attested || !canSign || signing}>
                  {signing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Sign
                </Button>
                <Button onClick={() => void doSign(true)} disabled={!attested || !canSign || signing}>
                  Sign &amp; next
                </Button>
              </div>
            </div>
          )}

          {signed && (
            <p className="text-center text-xs text-muted-foreground">
              This prescription is final. Corrections create a new revision with a reason.
            </p>
          )}
        </div>
      </AppLayout>
    );
  }

  // ---- COMPOSER -----------------------------------------------------------
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 border-b pb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/doctor')}>
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Queue
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">
              {ctx.patient.name} <span className="text-sm font-normal text-muted-foreground">{ctx.patient.ageLabel} {ctx.patient.gender}</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              {ctx.patient.patientNumber} · {ctx.visit.visitType}
              {ctx.visit.tokenNumber ? ` · Token ${ctx.visit.tokenNumber}` : ''}
              {ctx.visit.ward ? ` · ${ctx.visit.ward}` : ''}
            </p>
          </div>
          <Badge className="ml-auto h-6 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-50">
            Draft — not signed
          </Badge>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {/* Context */}
          <div className="space-y-3">
            {ctx.currentMedications.length > 0 && (
              <section className="rounded-lg border bg-card p-3 sm:p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Currently on</h2>
                <ul className="mt-2 space-y-1">
                  {ctx.currentMedications.map((m) => (
                    <li key={m.name} className="text-sm">
                      <span className="font-medium">{m.name}</span>
                      <span className="text-xs text-muted-foreground"> · since {new Date(m.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="rounded-lg border bg-card p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Previous prescriptions</h2>
                {ctx.previousPrescriptions.length > 0 && (
                  <Button variant="outline" size="sm" className="h-7" onClick={repeatLast}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Repeat last
                  </Button>
                )}
              </div>
              {ctx.previousPrescriptions.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No prescriptions on record for this patient.</p>
              ) : (
                <ul className="mt-2 divide-y">
                  {ctx.previousPrescriptions.map((p) => (
                    <li key={p.id} className="py-2 first:pt-0 last:pb-0">
                      <p className="text-xs text-muted-foreground">
                        {p.signedAt ? new Date(p.signedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unsigned'} · {p.clinicDoctor.name}
                      </p>
                      {p.items.map((i, n) => (
                        <p key={n} className="text-sm">
                          {i.canonicalName}
                          <span className="text-muted-foreground"> · {[i.frequencyText, i.durationValue ? `${i.durationValue} ${i.durationUnit}` : null].filter(Boolean).join(' · ')}</span>
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 rounded-md border border-dashed bg-muted/30 p-2.5 text-xs text-muted-foreground">
                Allergies, problem list and vitals are not shown because this system does not record them. An empty
                box would read as “none known”, which is a claim it cannot make.
              </p>
            </section>
          </div>

          {/* Composer */}
          <div className="space-y-3">
            {caps?.voiceEnabled && (
              <section className="rounded-lg border bg-card p-3">
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant={recording ? 'destructive' : 'default'}
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-full"
                    onClick={() => (recording ? stopRecording() : void startRecording())}
                    disabled={thinking}
                    aria-label={recording ? 'Stop dictation' : 'Start dictation'}
                  >
                    {recording ? <Square className="h-4 w-4" aria-hidden="true" /> : <Mic className="h-5 w-5" aria-hidden="true" />}
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {thinking ? 'Structuring what you said…' : recording ? 'Listening…' : 'Dictate the prescription'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {recording
                        ? 'Speak naturally — English, Hindi or a mix. Press stop when done.'
                        : rx?.transcript
                          ? `“${rx.transcript.slice(0, 90)}${rx.transcript.length > 90 ? '…' : ''}”`
                          : 'Everything stays editable afterwards.'}
                    </p>
                  </div>
                  {thinking && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
                </div>
              </section>
            )}

            {items.map((it, idx) => (
              <RxItemEditor
                key={it.id ?? `new-${idx}`}
                item={it}
                index={idx}
                findings={findings}
                onChange={(patch) => patchItem(idx, patch)}
                onRemove={() => removeItem(idx)}
              />
            ))}

            <MedicineTypeahead
              onSelect={(c) => setItems((cur) => [...cur, {
                ...blankItem(),
                medicationId: c.medicationId, canonicalName: c.canonicalName,
                genericName: c.genericName, brandName: c.brandName,
                strength: c.strength, strengthUnit: c.strengthUnit,
                dosageForm: c.dosageForm, route: c.route,
                // Picked by a human: never re-resolved, never second-guessed.
                resolution: 'MANUAL',
              }])}
              onFreeText={(text) => setItems((cur) => [...cur, {
                ...blankItem(),
                canonicalName: text,
                // Flagged once so the validator asks, and "Keep as written"
                // clears it in a click. The doctor is still the prescriber.
                resolution: 'UNRESOLVED',
              }])}
            />

            <div className="grid gap-2.5 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Diagnosis</span>
                <Input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} className="h-9" placeholder="optional" aria-label="Diagnosis" />
              </div>
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Follow-up (days)</span>
                <Input value={followUpDays} onChange={(e) => setFollowUpDays(e.target.value)} className="h-9 tabular-nums" inputMode="numeric" placeholder="—" aria-label="Follow-up in days" />
              </div>
              <div className="sm:col-span-2">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Notes</span>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="optional" aria-label="Notes" />
              </div>
            </div>

            {/* What was expected and is ABSENT. Omissions are 54–86% of scribe
                errors and the class nobody catches, because an omission leaves
                no text to point at. So it is stated, not left to be noticed. */}
            {(missing.length > 0 || notesOnly.length > 0) && (
              <section className="rounded-lg border bg-muted/30 p-3">
                <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Not captured</h2>
                <ul className="mt-1.5 space-y-0.5">
                  {[...new Set([...missing, ...notesOnly.map((n) => n.message)])].map((m) => (
                    <li key={m} className="text-xs text-muted-foreground">{m}</li>
                  ))}
                </ul>
              </section>
            )}

            {/* One question at a time, at the commit bar. Amber borders on cards
                are skippable; this is not, and it carries the words that produced
                each question. */}
            <RxQuestionQueue items={items} onResolve={patchItem} />

            {/* Findings the queue cannot answer — duplicates, an either/or, a
                Schedule X block. Stated, never dismissible. */}
            {blocking.filter((f) => !f.itemId).length > 0 && (
              <section className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  Before signing
                </h2>
                <ul className="mt-1.5 space-y-0.5">
                  {blocking.filter((f) => !f.itemId).map((f) => (
                    <li key={f.code} className="text-xs text-amber-800">{f.message}</li>
                  ))}
                </ul>
              </section>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button variant="ghost" size="sm" onClick={() => void finishWithout()}>
                Done, no prescription
              </Button>
              <div className="ml-auto flex gap-2">
                <Button variant="outline" onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  Save draft
                </Button>
                <Button
                  onClick={() => void openReview()}
                  disabled={saving || items.length === 0 || unanswered > 0}
                  title={unanswered > 0 ? `${unanswered} question${unanswered === 1 ? '' : 's'} left` : undefined}
                >
                  Review &amp; sign
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
