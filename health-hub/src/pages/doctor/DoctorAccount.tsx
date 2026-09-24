/**
 * My account — the answer to "can a doctor have admin".
 *
 * No. No Config, no roles, no catalogue, no branch settings. What they get is the
 * small set of things that are THEIRS and that nobody else can reasonably
 * maintain for them: their signature and the clinic line under their name.
 *
 * Name, qualification, specialty and registration number are shown READ-ONLY.
 * They print on a legal document and drive payouts, so the owner owns them — a
 * doctor who changes clinic must not be able to retype their own registration
 * number.
 *
 * The signature runs through `cleanSignature` — the SAME background-removal
 * pipeline the owner's signing-doctor screen uses. Third caller, no new code.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Loader2, Upload, Trash2, KeyRound } from 'lucide-react';
import { cleanSignature, type CleanedSignature } from '@/lib/signatureImage';
import { SignatureEditor } from '@/components/owner/SignatureEditor';
import { ChangePasswordDialog } from '@/components/account/ChangePasswordDialog';
import { doctorApi, type DoctorMe } from '@/lib/doctorApi';

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(file);
  });

export default function DoctorAccount() {
  const [me, setMe] = useState<DoctorMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  // Same two steps as Config → Signing: clean at the default strength, then the
  // SAME SignatureEditor (strength / erase / undo) before anything is saved.
  const [sigEdit, setSigEdit] = useState<{ source: File; cleaned: File; reveal: CleanedSignature['reveal'] } | null>(null);
  const [pwOpen, setPwOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await doctorApi.me();
      setMe(data);
      setNote(data.doctor?.letterheadNote ?? '');
    } catch {
      toast.error('Could not load your account');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onPick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const cleaned = await cleanSignature(file);
      setSigEdit({ source: file, cleaned: cleaned.file, reveal: cleaned.reveal });
    } catch {
      toast.error('Could not process that image');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, []);

  const applySignature = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const updated = await doctorApi.updateMe({ signatureImageBase64: await fileToDataUrl(file) });
      setMe((m) => (m ? { ...m, doctor: updated } : m));
      setSigEdit(null);
      toast.success('Signature saved');
    } catch {
      toast.error('Could not save the signature');
    } finally {
      setBusy(false);
    }
  }, []);

  const saveNote = useCallback(async () => {
    setBusy(true);
    try {
      const updated = await doctorApi.updateMe({ letterheadNote: note });
      setMe((m) => (m ? { ...m, doctor: updated } : m));
      toast.success('Saved');
    } catch {
      toast.error('Could not save');
    } finally {
      setBusy(false);
    }
  }, [note]);

  const removeSignature = useCallback(async () => {
    setBusy(true);
    try {
      const updated = await doctorApi.updateMe({ signatureImageBase64: null });
      setMe((m) => (m ? { ...m, doctor: updated } : m));
      toast.success('Signature removed');
    } catch {
      toast.error('Could not remove the signature');
    } finally {
      setBusy(false);
    }
  }, []);

  const doctor = me?.doctor;

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-2xl space-y-5 p-4 sm:p-6">
        <div className="border-b pb-4">
          <h1 className="text-xl font-semibold tracking-tight">My account</h1>
          {loading ? (
            <Skeleton className="mt-2 h-4 w-64" />
          ) : (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {doctor
                ? `${doctor.name} · ${doctor.qualification} · Reg. ${doctor.registrationNumber}`
                : 'This login is not linked to a consulting doctor yet.'}
            </p>
          )}
        </div>

        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : !doctor ? (
          <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
            Ask the owner to link this login to your consulting-doctor record in Config → Signing.
          </p>
        ) : (
          <>
            <section className="space-y-2 border-b pb-5">
              <h2 className="text-sm font-semibold">Signature</h2>
              <p className="text-xs text-muted-foreground">
                Appears on every prescription you sign. The background is removed automatically.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <div className="flex h-16 w-40 items-center justify-center rounded-md border bg-white">
                  {doctor.signatureImageBase64 ? (
                    <img src={doctor.signatureImageBase64} alt="Your signature" className="max-h-14 w-auto object-contain" />
                  ) : (
                    <span className="text-xs italic text-muted-foreground">none uploaded</span>
                  )}
                </div>
                <input
                  ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                  onChange={(e) => void onPick(e.target.files?.[0])} aria-label="Upload signature image"
                />
                <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="mr-2 h-4 w-4" aria-hidden="true" />}
                  {doctor.signatureImageBase64 ? 'Replace' : 'Upload'}
                </Button>
                {doctor.signatureImageBase64 && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeSignature()}>
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    Remove
                  </Button>
                )}
              </div>
              {!doctor.signatureImageBase64 && (
                <p className="text-xs text-amber-700">
                  You cannot sign a prescription until you add one — it goes out under your registration number and signature.
                </p>
              )}
            </section>

            <section className="space-y-2 border-b pb-5">
              <h2 className="text-sm font-semibold">Letterhead note</h2>
              <p className="text-xs text-muted-foreground">Timings or a clinic line printed under your name.</p>
              <div className="flex gap-2 pt-1">
                <Input
                  value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Mon–Sat 10 a.m. – 1 p.m." className="h-9" aria-label="Letterhead note"
                />
                <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => void saveNote()}>Save</Button>
              </div>
            </section>

            <section className="space-y-2 border-b pb-5">
              <h2 className="text-sm font-semibold">Password</h2>
              <p className="text-xs text-muted-foreground">Change the password you were given when your login was set up.</p>
              <Button variant="outline" size="sm" onClick={() => setPwOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                Change password
              </Button>
            </section>

            <section className="space-y-1.5">
              <h2 className="text-sm font-semibold">Your details</h2>
              <p className="text-xs text-muted-foreground">
                These print on a legal document, so the owner maintains them. Ask them if anything is wrong.
              </p>
              <dl className="mt-2 divide-y rounded-lg border bg-card text-sm">
                {[
                  ['Name', doctor.name],
                  ['Qualification', doctor.qualification],
                  ['Specialty', doctor.specialty],
                  ['Registration number', doctor.registrationNumber],
                  ['Doctor number', doctor.doctorNumber],
                  ['HPR / ABDM id', doctor.hprId || 'not linked'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-4 px-3 py-2">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        )}
      </div>
      {sigEdit && (
        <SignatureEditor
          source={sigEdit.source}
          initial={sigEdit.cleaned}
          reveal={sigEdit.reveal}
          busy={busy}
          onApply={(f) => void applySignature(f)}
          onCancel={() => setSigEdit(null)}
        />
      )}
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </AppLayout>
  );
}
