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

export async function fetchFinalizedReportHtml(
  request: StaffReportRequest & { autoPrint?: boolean }
): Promise<string> {
  const query = request.autoPrint ? '?print=true' : '';
  const response = await fetch(`${API_BASE}/visits/diagnostic/${request.visitId}/finalized-report${query}`, {
    headers: buildReportHeaders(request.token, request.branchId),
  });

  if (!response.ok) {
    throw new Error('Failed to load finalized report');
  }

  return response.text();
}

export async function openFinalizedReportWindow(
  request: StaffReportRequest & { autoPrint?: boolean }
): Promise<void> {
  const html = await fetchFinalizedReportHtml(request);
  const blob = new Blob([html], { type: 'text/html' });
  const blobUrl = URL.createObjectURL(blob);
  const opened = window.open(blobUrl, '_blank', 'noopener,noreferrer');

  if (!opened) {
    URL.revokeObjectURL(blobUrl);
    throw new Error('Unable to open report window');
  }

  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
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
