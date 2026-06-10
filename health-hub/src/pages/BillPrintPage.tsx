import { useState, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { Loader2, AlertTriangle, Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/api";
import { BillReceipt } from "@/components/print/BillReceipt";
import type { BillReceiptData } from "@/types";
import { useReactToPrint } from "react-to-print";
import {
  mapApiBillToReceiptData,
  type ApiBillData,
} from "@/lib/billReceiptMappers";

const isMobile = () =>
  /android|iphone|ipad|ipod|mobile|arc/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

export default function BillPrintPage() {
  const { domain, visitId } = useParams<{ domain: string; visitId: string }>();
  const { token } = useAuthStore();
  const [billData, setBillData] = useState<ApiBillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const reactToPrint = useReactToPrint({ contentRef });
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

  const handleDownloadPdf = async () => {
    if (!contentRef.current || !receiptData) return;
    try {
      setIsGenerating(true);
      const [html2canvasModule, jsPDFModule] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const html2canvas = html2canvasModule.default;
      const jsPDF = jsPDFModule.default;

      const canvas = await html2canvas(contentRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: "#ffffff",
      });

      const imgData = canvas.toDataURL("image/jpeg", 0.95);
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, "JPEG", 0, 0, pdfWidth, pdfHeight);

      const fileName = `Bill_${receiptData.billNumber || receiptData.visitRef || "Receipt"}.pdf`;

      // Try Web Share API first (works great on Android/iOS)
      const blob = pdf.output("blob");
      const file = new File([blob], fileName, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Bill Receipt" });
      } else {
        // Fallback: direct download
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      console.error("PDF generation failed:", err);
      alert("Could not generate PDF: " + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

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

  const mobile = isMobile();

  return (
    <>
      <div className="no-print fixed top-4 right-4 z-50 flex gap-2">
        {/* On mobile, show Download PDF as primary action since window.print() is often blocked */}
        {mobile ? (
          <Button onClick={handleDownloadPdf} disabled={!logoLoaded || isGenerating}>
            {isGenerating ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating...</>
            ) : (
              <><Download className="h-4 w-4 mr-2" />{printLabel}</>
            )}
          </Button>
        ) : (
          <>
            <Button onClick={() => reactToPrint()} disabled={!logoLoaded}>
              <Printer className="h-4 w-4 mr-2" />
              {logoLoaded ? printLabel : "Preparing..."}
            </Button>
            <Button variant="outline" onClick={handleDownloadPdf} disabled={!logoLoaded || isGenerating}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </Button>
          </>
        )}
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
