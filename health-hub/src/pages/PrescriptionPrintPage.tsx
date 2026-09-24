import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/api";
import { ClinicPrescriptionPrint } from "@/components/print/ClinicPrescriptionPrint";
import { buildClinicVisitView } from "@/lib/clinicVisitView";
import type { ClinicVisitView } from "@/types";
import { RxLetterpad, type RxProfile } from "@/components/doctor/RxLetterpad";
import { doctorApi, type Prescription } from "@/lib/doctorApi";
import { cn } from "@/lib/utils";

/**
 * Standalone print view for a clinic visit's prescription (blank Rx sheet on the
 * clinic letterhead). Opened in a new tab from Patient 360 / Finalized OP-IP via
 * `/prescription/print/:visitId`. Mirrors BillPrintPage: fetch by id → render
 * the existing ClinicPrescriptionPrint in `rx` mode → window.print().
 *
 * When the doctor signed a digital prescription for the visit, THAT is the
 * prescription, so it prints instead — the same frozen sheet the patient's link
 * shows. Physical letterhead by default (reception prints onto pre-printed
 * paper). With digital prescriptions off, the lookup fails and the blank sheet
 * prints exactly as before.
 */
export default function PrescriptionPrintPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const { token } = useAuthStore();
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  const activeBranch = getActiveBranch();
  const [visitView, setVisitView] = useState<ClinicVisitView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signedRx, setSignedRx] = useState<Prescription | null>(null);
  const [profile, setProfile] = useState<RxProfile>("physical");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visitId) return;
    const fetchVisit = async () => {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/visits/clinic/${visitId}`, {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (!res.ok) {
          throw new Error(res.status === 404 ? "Visit not found" : "Failed to fetch visit");
        }
        const [data, rxs] = await Promise.all([
          res.json(),
          doctorApi.forVisit(visitId).catch(() => [] as Prescription[]),
        ]);
        setVisitView(buildClinicVisitView(data));
        setSignedRx(rxs.find((r) => r.status === "SIGNED" && r.snapshot) ?? null);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchVisit();
  }, [visitId, token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !visitView) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">Failed to load prescription</p>
        <p className="text-sm text-muted-foreground">{error || "Could not prepare prescription data"}</p>
        <Button variant="outline" onClick={() => window.close()}>Close Window</Button>
      </div>
    );
  }

  if (signedRx) {
    return (
      <div className="min-h-screen bg-slate-100 py-6 print:bg-white print:py-0">
        <div className="no-print fixed top-4 right-4 z-50 flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border bg-white p-0.5">
            {(["physical", "digital"] as RxProfile[]).map((p) => (
              <button
                key={p} type="button" onClick={() => setProfile(p)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs transition-colors",
                  profile === p ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {p === "physical" ? "Physical letterhead" : "Digital"}
              </button>
            ))}
          </div>
          <Button onClick={() => window.print()}>Print Prescription</Button>
        </div>
        <RxLetterpad
          profile={profile}
          items={signedRx.items}
          diagnosis={signedRx.diagnosis}
          notes={signedRx.notes}
          followUpDays={signedRx.followUpDays}
          snapshot={signedRx.snapshot}
        />
      </div>
    );
  }

  return (
    <>
      <div className="no-print fixed top-4 right-4 z-50">
        {/* The Rx sheet prints onto pre-printed letterhead and renders no logo,
            so there is nothing to wait for before enabling the button. */}
        <Button onClick={() => window.print()}>Print Prescription</Button>
      </div>

      <div ref={contentRef}>
        <ClinicPrescriptionPrint
          visitView={visitView}
          branchName={activeBranch?.name}
          printMode="rx"
        />
      </div>
    </>
  );
}
