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
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import {
  Mic, Square, Loader2, ArrowLeft, RotateCcw, AlertTriangle, Printer, Check, Send, PenLine, Trash2,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/hooks/use-confirm';
import { useAuthStore } from '@/store/authStore';
import { rxRecords } from '@/lib/rxRecords';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RxItemEditor } from '@/components/doctor/RxItemEditor';
import { MedicineTypeahead } from '@/components/doctor/MedicineTypeahead';
import { RxQuestionQueue } from '@/components/doctor/RxQuestionQueue';
import { RxLetterpad, type RxProfile } from '@/components/doctor/RxLetterpad';
import {
  doctorApi, DoctorApiError, itemSig, itemTitle, openQuestions,
  type Prescription, type RxItem, type Finding, type Capabilities, type ExtractedItem,
  type VisitContext, type ExtractionResponse,
  type DictationLanguage, DICTATION_OPTIONS,
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
  // Placeholder only, for the instant before the save returns: the dictated
  // line is sent WITHOUT a resolution and the server decides (see startRecording).
  resolution: 'UNRESOLVED',
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

const isAlt = (it: RxItem) => it.fieldStates?.isAlternative === true;
/** Once one option of an "either X or Y" is left, it is simply prescribed. */
const settleChoice = (list: RxItem[]) =>
  list.filter(isAlt).length === 1
    ? list.map((it) => (isAlt(it) ? { ...it, fieldStates: { ...(it.fieldStates ?? {}), isAlternative: false } } : it))
    : list;

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
  /** What was heard (or written) — editable, so a mishearing is fixed at the source. */
  const [heard, setHeard] = useState('');
  const [recSeconds, setRecSeconds] = useState(0);
  /** This session's recording, in memory only, for play-back. */
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [profile, setProfile] = useState<RxProfile>('digital');
  const [attested, setAttested] = useState(false);
  /** The line clicked on the review sheet, open for editing beside it. */
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const silenceTimer = useRef<number | undefined>(undefined);

  const signed = rx?.status === 'SIGNED';
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const isDoctor = useAuthStore((st) => st.user?.role === 'doctor');
  const { confirm, ConfirmDialog } = useConfirm();
  /** "Correct…" on a signed prescription: the reason being typed, or null. */
  const [correctReason, setCorrectReason] = useState<string | null>(null);
  /** "Done, no prescription" pressed while a draft exists. */
  const [closingWithDraft, setClosingWithDraft] = useState(false);
  /** What the doctor speaks — sent with every recording, saved to their profile. */
  const [speech, setSpeech] = useState<DictationLanguage>('auto');
  // The recorder's stop handler is created when recording starts; it reads this.
  const speechRef = useRef(speech);
  speechRef.current = speech;

  /** Send the patient their link. Never fired automatically — see the button. */
  const doSend = useCallback(async () => {
    if (!rx) return;
    setSending(true);
    try {
      const r = await rxRecords.send(rx.id);
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
      if (context.dictationLanguage) setSpeech(context.dictationLanguage);
      const open = existing.find((p) => p.status === 'DRAFT') ?? existing[0] ?? null;
      if (open) {
        setRx(open);
        setHeard(open.transcript ?? '');
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

  // A visible clock while the mic is open — "Listening…" alone gives no sense of
  // how long you have been talking, and the hard stop is at three minutes.
  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setRecSeconds((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

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
  /**
   * Turn an extraction into saved lines. ONE path for the microphone and for
   * written text, so the two cannot drift into saving different things.
   *
   * `replaceDictated`: "Read again" after correcting the heard text replaces the
   * lines that CAME from dictation (they carry sourceText) and keeps anything
   * added by hand. Otherwise new lines are ADDED — a doctor who typed two
   * medicines and then spoke a third means three.
   *
   * New lines go up WITHOUT a resolution so the server checks each against the
   * catalogue and asks where it must. Stamping them MANUAL here — as this used
   * to — marked every spoken drug as the doctor's own verified choice.
   */
  const applyExtraction = useCallback(
    async (
      extraction: ExtractionResponse['extraction'],
      opts: { replaceDictated: boolean; meta?: Record<string, unknown> },
    ) => {
      const extracted = extraction.items.map(fromExtracted);
      const base = items.filter((i) => i.canonicalName.trim() && !(opts.replaceDictated && i.sourceText));
      const merged = [...base, ...extracted];
      setMissing(extraction.missing);
      if (extraction.diagnosis && !diagnosis) setDiagnosis(extraction.diagnosis);
      if (extraction.followUpDays != null && !followUpDays) setFollowUpDays(String(extraction.followUpDays));
      const draft = await ensureDraft(opts.meta ?? {});
      const fresh = new Set(extracted);
      const updated = await doctorApi.update(draft.id, {
        items: merged.map((i) => (fresh.has(i)
          ? { ...i, resolution: undefined, candidates: undefined }
          : { ...i })),
      });
      setRx(updated);
      setItems(updated.items);
      const v = await doctorApi.validate(updated.id);
      setFindings(v.findings);
      return extraction.items.length;
    },
    [items, diagnosis, followUpDays, ensureDraft],
  );

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
        // Play-back of what was JUST said, from memory — nothing is uploaded or
        // kept. Re-listening is how a doctor checks a word the recogniser got
        // wrong before correcting it below.
        setAudioUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
        setThinking(true);
        try {
          const result = await doctorApi.transcribe(blob, { dictation: speechRef.current });
          setHeard(result.transcript.text);
          const n = await applyExtraction(result.extraction, {
            replaceDictated: false,
            meta: {
              transcript: result.transcript.text,
              transcriptSegments: result.transcript.segments,
              asrProvider: result.transcript.provider,
              asrModel: result.transcript.model,
              asrLanguage: result.transcript.language,
              extractionModel: result.extraction.model,
            },
          });
          toast.success(`Heard ${n} medicine${n === 1 ? '' : 's'}`);
        } catch (err) {
          // Never a dead end: the typed editor is always the fallback.
          toast.error(err instanceof DoctorApiError ? err.message : 'Could not transcribe — please type instead');
        } finally {
          setThinking(false);
        }
      };
      mr.start();
      recorder.current = mr;
      setRecSeconds(0);
      setRecording(true);
      // Hard stop at 3 minutes. An open mic left running is billed by the second
      // and, past a long pause, is where Whisper fabricates sentences.
      silenceTimer.current = window.setTimeout(() => stopRecording(), 180_000);
    } catch {
      toast.error('Microphone permission denied');
    }
  }, [applyExtraction, stopRecording]);

  /**
   * "Type midway": structure WRITTEN words — the heard text after correcting a
   * word the recogniser got wrong, or a line typed with no microphone at all.
   */
  const readText = useCallback(async () => {
    const text = heard.trim();
    if (!text) return;
    const dictated = items.filter((i) => i.sourceText).length;
    setThinking(true);
    try {
      const { extraction } = await doctorApi.extractText(text);
      const n = await applyExtraction(extraction, { replaceDictated: dictated > 0 });
      toast.success(`Read ${n} medicine${n === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(err instanceof DoctorApiError ? err.message : 'Could not read that — add the medicines one by one below');
    } finally {
      setThinking(false);
    }
  }, [heard, items, applyExtraction]);

  // --- item editing --------------------------------------------------------
  const patchItem = useCallback((idx: number, patch: Partial<RxItem>) => {
    setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }, []);

  const removeItem = useCallback((idx: number) => {
    setItems((cur) => settleChoice(cur.filter((_, i) => i !== idx)));
  }, []);

  // "Prescribe this one" on an either/or: keep it, drop the other options. Until
  // then the choice blocks signing (ALTERNATIVES_UNRESOLVED) — it used to block
  // it for good, because nothing on screen could clear the flag.
  const chooseAlternative = useCallback((idx: number) => {
    setItems((cur) => settleChoice(cur.filter((it, i) => i === idx || !isAlt(it))));
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
        // Sign what is ON SCREEN. The review sheet is editable in place now, and
        // sign() works on the server's copy of the draft — without this save, an
        // edit made here would be silently left out of what gets signed.
        const saved = await save();
        if (!saved) return;
        const result = await doctorApi.sign(saved.id, true);
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
    [rx, navigate, save],
  );

  const closeVisit = useCallback(async (message: string) => {
    if (!visitId) return;
    try {
      await doctorApi.setVisitStatus(visitId, 'COMPLETED');
      toast.success(message);
      navigate('/doctor');
    } catch {
      toast.error('Could not close the visit');
    }
  }, [visitId, navigate]);

  // "Done, no prescription" with a draft already written asks what to do with it
  // — signing it, throwing it away, and keeping it are all reasonable, and only
  // the doctor knows which.
  const finishWithout = useCallback(async () => {
    if (rx?.status === 'DRAFT') { setClosingWithDraft(true); return; }
    await closeVisit('Consultation closed without a prescription');
  }, [rx, closeVisit]);

  /** Start over on this visit after a draft is thrown away. */
  const resetComposer = useCallback(() => {
    setRx(null); setItems([]); setHeard(''); setDiagnosis(''); setNotes(''); setFollowUpDays('');
    setFindings([]); setMissing([]); setReview(false); setAttested(false); setInspectId(null);
  }, []);

  const discard = useCallback(async (opts: { ask: boolean }) => {
    if (!rx || rx.status !== 'DRAFT') return false;
    const correction = !!rx.previousVersionId;
    if (opts.ask) {
      const ok = await confirm({
        title: correction ? 'Discard this correction?' : 'Discard this draft?',
        description: correction
          ? 'The correction is thrown away. The version you signed before stays exactly as it is.'
          : 'This prescription and its recording are thrown away. It cannot be undone.',
        confirmText: 'Discard',
        destructive: true,
      });
      if (!ok) return false;
    }
    try {
      await doctorApi.discard(rx.id);
      toast.success(correction ? 'Correction discarded' : 'Draft discarded');
      resetComposer();
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not discard the draft');
      return false;
    }
  }, [rx, confirm, resetComposer, load]);

  // A signed prescription is corrected by a new version, never edited. The old
  // one stays the patient's until this one is signed.
  const openCorrection = useCallback(async () => {
    if (!rx || !correctReason || correctReason.trim().length < 3) return;
    try {
      const next = await doctorApi.amend(rx.id, correctReason.trim());
      setCorrectReason(null);
      setRx(next);
      setItems(next.items);
      setDiagnosis(next.diagnosis ?? '');
      setNotes(next.notes ?? '');
      setFollowUpDays(next.followUpDays != null ? String(next.followUpDays) : '');
      setReview(false);
      setAttested(false);
      toast.success(`Correcting v${next.version - 1}. The patient keeps it until you sign this one.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open a correction');
    }
  }, [rx, correctReason]);

  const blocking = useMemo(() => findings.filter((f) => f.severity !== 'NOTE'), [findings]);
  // Gate on the QUEUE, not only on the validator: the point of the queue is that
  // the refusal arrives while the doctor is still writing, not at the last step.
  const unanswered = useMemo(() => openQuestions(items).length, [items]);
  const notesOnly = useMemo(() => findings.filter((f) => f.severity === 'NOTE'), [findings]);
  const canSign = blocking.length === 0 && items.length > 0;
  // Who may sign, as the server decides it. An owner can open and edit any
  // consultation, but only the visit's own doctor signs — the sheet carries their
  // registration number and signature.
  const signBlock = ctx?.signing && !ctx.signing.ok ? (ctx.signing.reason ?? 'You cannot sign this prescription') : null;

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
  const inspectIdx = inspectId ? items.findIndex((i) => i.id === inspectId) : -1;

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
                <Button
                  variant="outline" size="sm"
                  onClick={() => { if (rx) void rxRecords.markPrinted(rx.id).catch(() => {}); window.print(); }}
                >
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

          {/* The sheet IS the editor: click a line and it opens beside the sheet,
              so what the doctor attests to is literally what they were just
              looking at — no trip back to the form and no second screen to keep
              in step. Clicking the line again closes it. */}
          <div className={cn('grid gap-4', inspectIdx >= 0 && 'lg:grid-cols-[minmax(0,1fr)_24rem]')}>
            <div className="rounded-lg bg-muted/40 p-3 sm:p-5">
              <RxLetterpad
                profile={profile}
                items={items}
                diagnosis={diagnosis || null}
                notes={notes || null}
                followUpDays={followUpDays ? Number(followUpDays) : null}
                snapshot={rx?.snapshot ?? null}
                live={live}
                selectedItemId={signed ? null : inspectId}
                onSelectItem={signed ? undefined : (id) => setInspectId(id ?? null)}
              />
              {!signed && inspectIdx < 0 && (
                <p className="mt-2 text-center text-xs text-muted-foreground">Click any medicine on the sheet to change it here.</p>
              )}
            </div>
            {!signed && inspectIdx >= 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Editing line {inspectIdx + 1} — the sheet updates as you type
                </p>
                <RxItemEditor
                  item={items[inspectIdx]}
                  index={inspectIdx}
                  findings={findings}
                  onChange={(patch) => {
                    patchItem(inspectIdx, patch);
                    // They attested to the sheet as it WAS. A change after the tick
                    // needs a fresh one.
                    setAttested(false);
                  }}
                  onRemove={() => { removeItem(inspectIdx); setInspectId(null); setAttested(false); }}
                  onChoose={() => { chooseAlternative(inspectIdx); setInspectId(null); setAttested(false); }}
                />
                <Button variant="ghost" size="sm" onClick={() => setInspectId(null)}>Done</Button>
              </div>
            )}
          </div>

          {!signed && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 sm:p-4">
              {/* The attestation is the prescriber's to make. Anyone else sees why
                  they cannot sign instead of a box that says "I am prescribing". */}
              {signBlock && isDoctor && ctx.signing?.code === 'NO_SIGNATURE' ? (
                <p className="max-w-md text-sm text-amber-700">
                  You haven&apos;t added your signature yet, so this can&apos;t be signed. It&apos;s saved as a draft.{' '}
                  <Link to="/doctor/account" className="font-medium underline underline-offset-2">Add it in My profile →</Link>
                </p>
              ) : signBlock ? (
                <p className="max-w-md text-sm text-amber-700">{signBlock}</p>
              ) : (
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
              )}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" onClick={() => setReview(false)}>Back to edit</Button>
                <Button onClick={() => void doSign(false)} disabled={!!signBlock || !attested || !canSign || signing}>
                  {signing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Sign
                </Button>
                <Button onClick={() => void doSign(true)} disabled={!!signBlock || !attested || !canSign || signing}>
                  Sign &amp; next
                </Button>
              </div>
            </div>
          )}

          {signed && (
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
              <span>This prescription is final. A correction is a new version, with a reason.</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setCorrectReason('')}>
                <PenLine className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Correct…
              </Button>
            </div>
          )}
        </div>
        <Dialog open={correctReason !== null} onOpenChange={(o) => { if (!o) setCorrectReason(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Correct this prescription</DialogTitle>
              <DialogDescription>
                A new version opens for you to edit and sign. Until you sign it, the patient&apos;s link and every
                printout stay on this one.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={correctReason ?? ''}
              onChange={(e) => setCorrectReason(e.target.value)}
              rows={3}
              placeholder="Why — e.g. wrong dose on Augmentin"
              aria-label="Reason for the correction"
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setCorrectReason(null)}>Cancel</Button>
              <Button disabled={(correctReason ?? '').trim().length < 3} onClick={() => void openCorrection()}>Open correction</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
        {rx?.status === 'DRAFT' && rx.previousVersionId && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Correcting v{rx.version - 1}{rx.revisionReason ? ` — “${rx.revisionReason}”` : ''}. The patient keeps v{rx.version - 1} until you sign this one.
          </p>
        )}

        {/* Patient context narrow on the left, the prescription wide on the right —
            the wireframe's proportions. At 0.9fr / 1.1fr the history panel took
            half the screen and the medicine card got one field per row. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(15rem,1fr)_minmax(0,2fr)]">
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
            {/* Dictate OR write — the same card. Always shown: with no microphone
                (or no speech key on the server) a doctor can still write
                "Augmentin 625 three times daily for five days" and have it
                structured, and after dictation what was heard is right here to
                correct and read again, instead of a truncated quote. */}
            <section className="space-y-2.5 rounded-lg border bg-card p-3">
              <div className="flex items-center gap-3">
                {caps?.voiceEnabled && (
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
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {thinking
                      ? 'Structuring…'
                      : recording
                        ? `Listening… ${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, '0')}`
                        : caps?.voiceEnabled ? 'Dictate or write the prescription' : 'Write the prescription'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {recording
                      ? 'Speak naturally — medicine names as you say them, the rest in any language. Press stop when done.'
                      : 'Every line stays editable afterwards.'}
                  </p>
                </div>
                {caps?.voiceEnabled && !recording && (
                  <Select
                    value={speech}
                    onValueChange={(v) => {
                      const next = v as DictationLanguage;
                      setSpeech(next);
                      // Remembered for next time. An owner has no profile to save it to.
                      if (isDoctor) void doctorApi.updateMe({ dictationLanguage: next === 'auto' ? null : next }).catch(() => {});
                    }}
                  >
                    <SelectTrigger className="h-8 w-auto gap-1.5 text-xs" aria-label="Language you speak">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {DICTATION_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {thinking && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
              </div>

              {!recording && (
                <>
                  <Textarea
                    value={heard}
                    onChange={(e) => setHeard(e.target.value)}
                    disabled={thinking || signed}
                    rows={heard ? 3 : 2}
                    placeholder="Augmentin 625 three times daily for five days, Pan 40 once before breakfast…"
                    aria-label={rx?.transcript ? 'What was heard — correct it and read again' : 'Write the prescription'}
                    className="resize-y text-sm"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button" size="sm" variant="outline"
                      disabled={thinking || signed || !heard.trim()}
                      onClick={() => void readText()}
                    >
                      {items.some((i) => i.sourceText) ? 'Read again' : 'Read'}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {items.some((i) => i.sourceText)
                        ? 'Replaces the dictated lines; medicines added by hand stay.'
                        : 'Adds what you wrote as medicines below.'}
                    </span>
                    {audioUrl && (
                      // What was just said, from memory — nothing is uploaded or kept.
                      <audio controls src={audioUrl} className="ml-auto h-8 max-w-[16rem]" aria-label="Play back what you said" />
                    )}
                  </div>
                </>
              )}
            </section>

            {items.map((it, idx) => (
              <RxItemEditor
                key={it.id ?? `new-${idx}`}
                item={it}
                index={idx}
                findings={findings}
                onChange={(patch) => patchItem(idx, patch)}
                onRemove={() => removeItem(idx)}
                onChoose={() => chooseAlternative(idx)}
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
              {rx?.status === 'DRAFT' && (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void discard({ ask: true })}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {rx.previousVersionId ? 'Discard correction' : 'Discard draft'}
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2">
                {/* Said out loud, not hidden in a tooltip on a disabled button:
                    how many answers stand between this draft and a signature. */}
                {unanswered > 0 && (
                  <span className="text-sm font-medium text-amber-700">
                    {unanswered} need{unanswered === 1 ? 's' : ''} confirming
                  </span>
                )}
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
      <Dialog open={closingWithDraft} onOpenChange={setClosingWithDraft}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>You have an unsigned prescription for this patient</DialogTitle>
            <DialogDescription>
              {items.length} medicine{items.length === 1 ? '' : 's'} written but not signed. What should happen to it?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => { setClosingWithDraft(false); void closeVisit('Visit closed — the draft is kept'); }}>
              Keep the draft and close
            </Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={async () => {
                setClosingWithDraft(false);
                if (await discard({ ask: false })) await closeVisit('Consultation closed without a prescription');
              }}
            >
              Discard and close
            </Button>
            <Button onClick={() => { setClosingWithDraft(false); void openReview(); }}>Review &amp; sign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ConfirmDialog}
    </AppLayout>
  );
}
