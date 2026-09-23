/**
 * The patient's prescription, opened from a link. PUBLIC — no login.
 *
 * Renders the SAME RxLetterpad the doctor signed, from the frozen snapshot the
 * token resolves to. That is the whole reason the backend route returns JSON
 * instead of HTML: a second server-rendered copy of this sheet would drift from
 * this one, and the thing that drifted would be a document carrying a doctor's
 * registration number.
 *
 * Always the `digital` profile — there is no pre-printed paper behind a phone.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { RxLetterpad } from '@/components/doctor/RxLetterpad';
import type { PrescriptionSnapshot, RxItem } from '@/lib/doctorApi';
import { API_BASE } from '@/lib/api';
import { Loader2 } from 'lucide-react';

interface Payload {
  prescription: {
    version: number;
    signedAt: string | null;
    diagnosis: string | null;
    notes: string | null;
    followUpDays: number | null;
    snapshot: PrescriptionSnapshot | null;
    items: RxItem[];
  };
}

export default function PublicPrescription() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Payload['prescription'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Same origin as the API, and NOT the authenticated apiCall helper: this
        // page has no token and must not send an Authorization header.
        const res = await fetch(`${API_BASE.replace(/\/api$/, '')}/rx/view/${token}`);
        const body = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok) {
          setError(body?.message ?? 'This prescription link is not valid any more.');
          return;
        }
        setData(body.prescription);
      } catch {
        if (alive) setError('Could not load the prescription. Please check your connection.');
      }
    })();
    return () => { alive = false; };
  }, [token]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-sm rounded-lg border bg-white p-6 text-center">
          <p className="text-sm font-medium text-slate-900">Prescription unavailable</p>
          <p className="mt-1 text-xs text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden="true" />
      </div>
    );
  }

  // A signed prescription always carries its snapshot; the backend refuses to
  // resolve an unsigned one, so this only fires on a malformed row.
  const snap = data.snapshot;
  if (!snap) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-sm rounded-lg border bg-white p-6 text-center">
          <p className="text-sm font-medium text-slate-900">Prescription unavailable</p>
          <p className="mt-1 text-xs text-slate-600">Please contact the clinic.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 py-6 print:bg-white print:py-0">
      <RxLetterpad
        profile="digital"
        items={data.items ?? []}
        diagnosis={data.diagnosis}
        notes={data.notes}
        followUpDays={data.followUpDays}
        snapshot={snap}
      />
    </div>
  );
}
