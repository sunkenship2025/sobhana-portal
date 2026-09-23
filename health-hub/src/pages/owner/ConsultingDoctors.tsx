/**
 * Owner → Consulting doctors: who can sign in, and whose signature we hold.
 *
 * A LIST, NOT A RULE EDITOR. There is no department column and no
 * most-specific-wins resolution, because a prescription's signer is not
 * configured — it is the doctor on the visit. Adding a rule layer would let
 * config name Dr A while Dr B actually signed, and that is the one failure worth
 * designing out of a document carrying a registration number.
 *
 * The password is shown ONCE, here, and never again: only the bcrypt hash is
 * kept. That is deliberate, and the UI says so rather than implying it can be
 * looked up later.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { KeyRound, Upload, Loader2, Copy, ShieldOff, Stethoscope, RotateCcw } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { cleanSignature } from '@/lib/signatureImage';
import { useQueryClient } from '@tanstack/react-query';
import { useDigitalRx } from '@/lib/digitalRx';

interface Row {
  id: string;
  doctorNumber: string;
  name: string;
  qualification: string;
  specialty: string;
  registrationNumber: string;
  phone: string | null;
  hprId: string | null;
  hasSignature: boolean;
  login: { id: string; email: string; isActive: boolean; role: string } | null;
}

function headers(json = true): Record<string, string> {
  const token = useAuthStore.getState().token;
  const branchId = useBranchStore.getState().getActiveBranch()?.id;
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (branchId) h['X-Branch-Id'] = branchId;
  return h;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', headers: headers(), ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? 'Request failed');
  return body as T;
}

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(file);
  });

export default function ConsultingDoctors() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ name: string; email: string; password: string } | null>(null);
  const [revoking, setRevoking] = useState<Row | null>(null);
  const uploadFor = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The module switch. Read through react-query rather than this page's own
  // fetch helper so the sidebar — which hides the doctor nav off the same
  // query — updates the instant this flips, instead of on the next reload.
  const qc = useQueryClient();
  const { enabled: moduleOn } = useDigitalRx();
  const [moduleBusy, setModuleBusy] = useState(false);
  const [confirmModule, setConfirmModule] = useState(false);

  const setModule = useCallback(async (next: boolean) => {
    setModuleBusy(true);
    try {
      await call<{ enabled: boolean }>('/app-settings/digital-prescriptions', {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
      await qc.invalidateQueries({ queryKey: ['digital-rx-enabled'] });
      toast.success(next ? 'Digital prescriptions are on' : 'Digital prescriptions are off — the clinic is on the paper flow');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change the setting');
    } finally { setModuleBusy(false); }
  }, [qc]);

  const load = useCallback(async () => {
    try { setRows(await call<Row[]>('/doctor-logins')); }
    catch { toast.error('Could not load consulting doctors'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createLogin = useCallback(async (row: Row) => {
    setBusy(row.id);
    try {
      const r = await call<{ login: { email: string }; password: string }>(`/doctor-logins/${row.id}`, { method: 'POST' });
      setCredential({ name: row.name, email: r.login.email, password: r.password });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the login');
    } finally { setBusy(null); }
  }, [load]);

  const resetPassword = useCallback(async (row: Row) => {
    setBusy(row.id);
    try {
      const r = await call<{ password: string }>(`/doctor-logins/${row.id}/reset`, { method: 'POST' });
      setCredential({ name: row.name, email: row.login?.email ?? '', password: r.password });
    } catch {
      toast.error('Could not reset the password');
    } finally { setBusy(null); }
  }, []);

  const revoke = useCallback(async (row: Row) => {
    setBusy(row.id);
    try {
      await call(`/doctor-logins/${row.id}`, { method: 'DELETE' });
      toast.success('Access revoked. Their signed prescriptions are unaffected.');
      await load();
    } catch {
      toast.error('Could not revoke access');
    } finally { setBusy(null); setRevoking(null); }
  }, [load]);

  const onSignature = useCallback(async (file: File | undefined) => {
    const id = uploadFor.current;
    if (!file || !id) return;
    setBusy(id);
    try {
      const { file: cleaned } = await cleanSignature(file);
      const dataUrl = await fileToDataUrl(cleaned);
      await call(`/doctor-logins/${id}/signature`, {
        method: 'PATCH',
        body: JSON.stringify({ signatureImageBase64: dataUrl }),
      });
      toast.success('Signature saved');
      await load();
    } catch {
      toast.error('Could not process that image');
    } finally {
      setBusy(null);
      uploadFor.current = null;
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [load]);

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="border-b pb-4">
          <h1 className="text-xl font-semibold tracking-tight">Consulting doctors</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Who can sign in to write prescriptions, and whose signature prints on them.
          </p>
        </div>

        {/* The master switch. Everything below it — and the whole doctor portal —
            is inert while this is off, and the clinic runs the paper flow it ran
            before any of this was built. Deliberately first on the page: it is
            the setting that decides whether the rest of the page means anything. */}
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Digital prescriptions</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {moduleOn
                ? 'Doctors sign in to the portal, write prescriptions on screen and sign them.'
                : 'Off. The clinic runs the paper flow: staff register the visit, the doctor writes on the pad. Doctor logins below stay set up, but the portal is closed.'}
            </p>
          </div>
          <Button
            variant={moduleOn ? 'outline' : 'default'}
            size="sm"
            className="shrink-0"
            disabled={moduleOn === undefined || moduleBusy}
            onClick={() => setConfirmModule(true)}
          >
            {moduleBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {moduleOn === undefined ? 'Checking…' : moduleOn ? 'Turn off' : 'Turn on'}
          </Button>
        </div>

        <input
          ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
          onChange={(e) => void onSignature(e.target.files?.[0])} aria-label="Upload signature"
        />

        {loading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Stethoscope} title="No consulting doctors" description="Add them in the clinic catalogue first." />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {rows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    {d.login ? (
                      <Badge className="h-5 border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
                        {d.login.isActive ? 'Active login' : 'Login disabled'}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="h-5">No login</Badge>
                    )}
                    {!d.hasSignature && <Badge variant="outline" className="h-5 text-amber-700">No signature</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {d.qualification} · {d.specialty} · Reg. {d.registrationNumber} · {d.doctorNumber}
                    {d.login ? ` · ${d.login.email}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <Button
                    variant="outline" size="sm" disabled={busy === d.id}
                    onClick={() => { uploadFor.current = d.id; fileInput.current?.click(); }}
                  >
                    {busy === d.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
                    {d.hasSignature ? 'Replace signature' : 'Add signature'}
                  </Button>

                  {d.login ? (
                    <>
                      <Button variant="outline" size="sm" disabled={busy === d.id} onClick={() => void resetPassword(d)}>
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Reset password
                      </Button>
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setRevoking(d)}>
                        <ShieldOff className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" disabled={busy === d.id} onClick={() => void createLogin(d)}>
                      <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Create login
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
          A doctor login sees only their own queue and their own patients. It never shows fees, dues, bills,
          discounts, commission or payouts — those fields are not sent to it at all. Test results are hidden by
          default and can be enabled org-wide.
        </p>
      </div>

      {/* Shown once. Only the hash is stored, so there is no "view password" later. */}
      <AlertDialog open={!!credential} onOpenChange={(o) => !o && setCredential(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign-in details for {credential?.name}</AlertDialogTitle>
            <AlertDialogDescription>
              This password is shown once and cannot be retrieved later — only its hash is stored. Send it to the
              doctor now, and ask them to change it after signing in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 rounded-md border bg-muted/40 p-3 font-mono text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Login</span>
              <span className="font-semibold">{credential?.email}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Password</span>
              <span className="font-semibold">{credential?.password}</span>
            </div>
          </div>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(`Login: ${credential?.email}\nPassword: ${credential?.password}`);
                toast.success('Copied');
              }}
            >
              <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              Copy
            </Button>
            <AlertDialogAction onClick={() => setCredential(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmModule} onOpenChange={(o) => !o && setConfirmModule(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {moduleOn ? 'Turn digital prescriptions off?' : 'Turn digital prescriptions on?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {moduleOn ? (
                <>
                  The doctor portal closes for everyone immediately and the clinic goes back to the paper
                  flow. Prescriptions already signed are untouched and links already sent to patients keep
                  working &mdash; revoking one of those is a clinical decision, not a settings change.
                  Any unsigned draft stays a draft until you turn this back on.
                </>
              ) : (
                <>
                  Doctors with a login will be able to open the portal, write prescriptions on screen and
                  sign them. Nothing about the existing clinic queue changes.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={moduleBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={moduleOn ? 'bg-destructive text-destructive-foreground' : undefined}
              disabled={moduleBusy}
              onClick={() => { void setModule(!moduleOn); setConfirmModule(false); }}
            >
              {moduleOn ? 'Turn off' : 'Turn on'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}&rsquo;s access?</AlertDialogTitle>
            <AlertDialogDescription>
              They will not be able to sign in. Every prescription they have already signed stays exactly as it is —
              those render from a frozen copy, so nothing in any patient&rsquo;s history changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revoking && void revoke(revoking)}>Revoke access</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
