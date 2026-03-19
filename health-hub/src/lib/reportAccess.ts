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
  const response = await fetch(
    `${API_BASE}/visits/diagnostic/${request.visitId}/finalized-report/pdf?mode=${mode}`,
    {
      headers: buildReportHeaders(request.token, request.branchId),
    }
  );

  if (!response.ok) {
    throw new Error('Failed to download finalized report');
  }

  const pdfBlob = await response.blob();
  const blobUrl = URL.createObjectURL(pdfBlob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = extractFilename(
    response.headers.get('content-disposition'),
    `Report-${request.visitId}.pdf`
  );
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}
