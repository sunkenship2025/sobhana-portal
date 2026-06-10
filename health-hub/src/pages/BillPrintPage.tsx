import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/api";
import { BillReceipt } from "@/components/print/BillReceipt";
import type { BillReceiptData } from "@/types";
import {
  mapApiBillToReceiptData,
  type ApiBillData,
} from "@/lib/billReceiptMappers";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { Download, Share2 } from "lucide-react";

export default function BillPrintPage() {
  const { domain, visitId } = useParams<{ domain: string; visitId: string }>();
  const { token } = useAuthStore();
  const [billData, setBillData] = useState<ApiBillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
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

  const handlePrint = () => {
    window.focus();
    setTimeout(() => {
      window.print();
    }, 100);
  };

  const handleSharePdf = async () => {
    try {
      setIsGeneratingPdf(true);
      const element = document.getElementById("bill-receipt-container");
      if (!element) throw new Error("Receipt container not found");

      // Hide the print buttons while capturing
      const buttonsDiv = document.getElementById("print-actions-container");
      if (buttonsDiv) buttonsDiv.style.display = 'none';

      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const imgData = canvas.toDataURL("image/jpeg", 1.0);
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

      pdf.addImage(imgData, "JPEG", 0, 0, pdfWidth, pdfHeight);
      
      const fileName = `Bill_${receiptData.billNumber || receiptData.visitRef || "Receipt"}.pdf`;

      // Use Web Share API if supported
      if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
        const blob = pdf.output("blob");
        const file = new File([blob], fileName, { type: "application/pdf" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: "Bill Receipt",
            files: [file],
          });
        } else {
          pdf.save(fileName);
        }
      } else {
        // Fallback: direct download
        pdf.save(fileName);
      }
    } catch (err: any) {
      console.error("Failed to generate PDF", err);
      alert("Failed to generate PDF. Make sure your connection is stable. Error: " + err.message);
    } finally {
      setIsGeneratingPdf(false);
      const buttonsDiv = document.getElementById("print-actions-container");
      if (buttonsDiv) buttonsDiv.style.display = 'flex';
    }
  };

  return (
    <>
      <div id="print-actions-container" className="no-print fixed top-4 right-4 z-50 flex gap-2 flex-col sm:flex-row">
        <Button onClick={handlePrint} disabled={!logoLoaded || isGeneratingPdf}>
          {logoLoaded ? printLabel : "Preparing Print..."}
        </Button>
        <Button variant="outline" onClick={handleSharePdf} disabled={!logoLoaded || isGeneratingPdf} className="bg-white">
          {isGeneratingPdf ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : /mobile|android|iphone|ipad/i.test(navigator.userAgent) ? (
            <Share2 className="h-4 w-4 mr-2" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          {isGeneratingPdf ? "Generating..." : "Share PDF"}
        </Button>
      </div>

      <div id="bill-receipt-container" className="bg-white">
        <BillReceipt
          data={receiptData}
          onLogoLoadedChange={setLogoLoaded}
        />
      </div>
    </>
  );
}
