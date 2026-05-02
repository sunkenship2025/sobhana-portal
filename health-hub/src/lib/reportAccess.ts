import { API_BASE } from '@/lib/api';

type StaffReportRequest = {
  visitId: string;
  token: string | null;
  branchId: string | null;
};

function buildReportHeaders(token: string | null, branchId: string | null): HeadersInit {
  if (!token) {
    throw new Error('Authentication required');
  }

  if (!branchId) {
    throw new Error('Active branch is required');
  }

  return {
    Authorization: `Bearer ${token}`,
    'X-Branch-Id': branchId,
  };
}

function extractFilename(contentDisposition: string | null, fallback: string): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return match?.[1] || fallback;
}

async function extractDownloadError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      return payload?.message || payload?.error || 'Failed to download finalized report';
    }

    const text = (await response.text()).trim();
    return text || 'Failed to download finalized report';
  } catch {
    return 'Failed to download finalized report';
  }
}

function shouldOpenPdfInNewTab(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|WhatsApp|FBAN|FBAV|Instagram/i.test(userAgent);
}

/**
 * Fetch the finalized report as a merged PDF and return a blob URL.
 * Caller is responsible for revoking the URL when done (or relying on the
 * 60s safety net in openFinalizedReportWindow).
 *
 * Uses the merged-PDF writer so external uploads are included with the
 * Sobhana band overlay. Replaces the legacy HTML view path which never
 * included appended uploads.
 */
export async function fetchFinalizedReportPdfBlobUrl(
  request: StaffReportRequest & { mode?: 'digital' | 'physical' }
): Promise<string> {
  const mode = request.mode === 'physical' ? 'physical' : 'digital';
  const response = await fetch(
    `${API_BASE}/visits/diagnostic/${request.visitId}/finalized-report/pdf?mode=${mode}`,
    { headers: buildReportHeaders(request.token, request.branchId) },
  );

  if (!response.ok) {
    throw new Error(await extractDownloadError(response));
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/pdf')) {
    throw new Error(await extractDownloadError(response));
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error('Generated report PDF was empty');
  }

  return URL.createObjectURL(blob);
}

/**
 * Open the finalized report in a new tab.
 *
 * When `autoPrint` is true, wraps the merged PDF in a thin HTML shell that
 * embeds the PDF and triggers `window.print()` on load — restoring the
 * one-click "open and print" behavior the staff had before, but now backed
 * by the merged PDF (which includes external upload pages) instead of HTML
 * (which never could).
 *
 * When `autoPrint` is false, opens the merged PDF directly so the user can
 * read/download/print at their leisure from the PDF viewer toolbar.
 */
export async function openFinalizedReportWindow(
  request: StaffReportRequest & { autoPrint?: boolean }
): Promise<void> {
  // Print goes on pre-printed Sobhana letterhead (logo + stripe + footer
  // already on the paper), so we use physical mode — no rendered/overlaid
  // header/footer. The non-print path uses digital mode for full Sobhana
  // branding because it's viewed on screen / shared digitally.
  const pdfUrl = await fetchFinalizedReportPdfBlobUrl({
    visitId: request.visitId,
    token: request.token,
    branchId: request.branchId,
    mode: request.autoPrint ? 'physical' : 'digital',
  });

  if (!request.autoPrint) {
    const opened = window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    if (!opened) {
      URL.revokeObjectURL(pdfUrl);
      throw new Error('Unable to open report window');
    }
    window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
    return;
  }

  // Auto-print path: wrapper HTML embeds the PDF in an <iframe> (NOT <embed>)
  // and calls iframe.contentWindow.print() — that's the cross-browser pattern
  // that actually triggers Chrome's PDF viewer to open the print dialog.
  // window.print() on the parent wrapper would just print the wrapper page
  // (blank) instead of the PDF content.
  const wrapperHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Print Report</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #525659; overflow: hidden; }
    iframe { width: 100vw; height: 100vh; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe id="pdf" src="${pdfUrl}"></iframe>
  <script>
    var iframe = document.getElementById('pdf');
    var fired = false;
    function tryPrint() {
      if (fired) return;
      fired = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        // Cross-origin or sandboxed PDF viewer — fall back to printing the
        // wrapper window. Worst case: user clicks Print in the PDF toolbar.
        try { window.print(); } catch (e2) { /* user can use toolbar */ }
      }
    }
    // iframe 'load' event fires reliably for blob: PDF URLs in Chrome.
    // Backup timer guards against rare timing issues.
    iframe.addEventListener('load', function() { setTimeout(tryPrint, 300); });
    setTimeout(tryPrint, 2500);
  </script>
</body>
</html>`;

  const wrapperBlob = new Blob([wrapperHtml], { type: 'text/html' });
  const wrapperUrl = URL.createObjectURL(wrapperBlob);
  const opened = window.open(wrapperUrl, '_blank');

  if (!opened) {
    URL.revokeObjectURL(pdfUrl);
    URL.revokeObjectURL(wrapperUrl);
    throw new Error('Pop-up was blocked — allow pop-ups and try again.');
  }

  // Revoke both after enough time for the print dialog to come up and close.
  window.setTimeout(() => {
    URL.revokeObjectURL(pdfUrl);
    URL.revokeObjectURL(wrapperUrl);
  }, 120_000);
}

export async function downloadFinalizedReportPdf(
  request: StaffReportRequest & { mode?: 'digital' | 'physical' }
): Promise<void> {
  const mode = request.mode === 'physical' ? 'physical' : 'digital';
  const openInNewTab = shouldOpenPdfInNewTab();
  const previewWindow = openInNewTab
    ? window.open('', '_blank', 'noopener,noreferrer')
    : null;

  try {
    const response = await fetch(
      `${API_BASE}/visits/diagnostic/${request.visitId}/finalized-report/pdf?mode=${mode}`,
      {
        headers: buildReportHeaders(request.token, request.branchId),
      }
    );

    if (!response.ok) {
      throw new Error(await extractDownloadError(response));
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/pdf')) {
      throw new Error(await extractDownloadError(response));
    }

    const pdfBlob = await response.blob();
    if (pdfBlob.size === 0) {
      throw new Error('Generated report PDF was empty');
    }

    const blobUrl = URL.createObjectURL(pdfBlob);
    const filename = extractFilename(
      response.headers.get('content-disposition'),
      `Report-${request.visitId}.pdf`
    );

    if (previewWindow) {
      previewWindow.location.href = blobUrl;
    } else {
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (error) {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
    throw error;
  }
}
