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

/**
 * Standalone print view for a clinic visit's prescription (blank Rx sheet on the
 * clinic letterhead). Opened in a new tab from Patient 360 / Finalized OP-IP via
 * `/prescription/print/:visitId`. Mirrors BillPrintPage: fetch by id → render
 * the existing ClinicPrescriptionPrint in `rx` mode → window.print().
 */
export default function PrescriptionPrintPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const { token } = useAuthStore();
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  const activeBranch = getActiveBranch();
  const [visitView, setVisitView] = useState<ClinicVisitView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        const data = await res.json();
        setVisitView(buildClinicVisitView(data));
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
