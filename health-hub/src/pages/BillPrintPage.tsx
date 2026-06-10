import { useState, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/api";
import { BillReceipt } from "@/components/print/BillReceipt";
import type { BillReceiptData } from "@/types";
import { useReactToPrint } from "react-to-print";
import {
  mapApiBillToReceiptData,
  type ApiBillData,
} from "@/lib/billReceiptMappers";

export default function BillPrintPage() {
  const { domain, visitId } = useParams<{ domain: string; visitId: string }>();
  const { token } = useAuthStore();
  const [billData, setBillData] = useState<ApiBillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({ contentRef });
  const printLabel =
    billData?.visit.hasBill === false ? "Print Visit Slip" : "Print Bill";

  useEffect(() => {
    if (domain && visitId) {
      fetchBillData();
    }
  }, [domain, visitId]);

  const fetchBillData = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/bills/${domain}/${visitId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Bill not found");
        }
        throw new Error("Failed to fetch bill data");
      }

      const data = await response.json();
      setBillData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const receiptData: BillReceiptData | null = useMemo(() => {
    if (!billData) return null;
    try {
      return mapApiBillToReceiptData(billData);
    } catch (err: any) {
      setError(`Rendering error: ${err.message || String(err)}`);
      return null;
    }
  }, [billData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !billData || !receiptData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">Failed to load print document</p>
        <p className="text-sm text-muted-foreground">{error || "Could not prepare bill data"}</p>
        <Button variant="outline" onClick={() => window.close()}>
          Close Window
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="no-print fixed top-4 right-4 z-50">
        <Button onClick={() => handlePrint()} disabled={!logoLoaded}>
          {logoLoaded ? printLabel : "Preparing Print..."}
        </Button>
      </div>

      <div ref={contentRef} id="bill-receipt-container" className="bg-white">
        <BillReceipt
          data={receiptData}
          onLogoLoadedChange={setLogoLoaded}
        />
      </div>
    </>
  );
}
