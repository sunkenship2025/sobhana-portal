/**
 * ReportPreviewFrame — the Report Builder's live, pixel-accurate preview.
 *
 * It does NOT re-draw the report. It POSTs the in-progress (unsaved) panel +
 * items + a mock patient to `POST /clinical-panels/preview-html`, which runs the
 * EXACT production renderer (buildDraftPanelSnapshot → renderReportHtml) and
 * returns self-contained HTML. So the preview is byte-identical to the finalized
 * report — `digital` uses the screen profile, `letterhead` uses pdf-physical.
 *
 * Debounced + AbortController so keystrokes don't pile up requests.
 */
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { Loader2 } from 'lucide-react';

export interface PreviewPayload {
  panel: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  patient?: Record<string, unknown>;
}

interface Props {
  payload: PreviewPayload;
  profile: 'digital' | 'letterhead';
  /** ~450ms default; passed through so tests can shorten it. */
  debounceMs?: number;
}

export function ReportPreviewFrame({ payload, profile, debounceMs = 450 }: Props) {
  const { token } = useAuthStore();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const key = JSON.stringify(payload);

  useEffect(() => {
    if (!payload.items || payload.items.length === 0) {
      setHtml('');
      setError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        };
        if (activeBranchId) headers['X-Branch-Id'] = activeBranchId;
        const res = await fetch(`${API_BASE}/clinical-panels/preview-html`, {
          method: 'POST',
          headers,
          signal: ctrl.signal,
          body: JSON.stringify({ ...payload, profile }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { message?: string }).message || `Preview failed (${res.status})`);
        }
        setHtml(await res.text());
      } catch (e) {
        const err = e as Error;
        if (err.name !== 'AbortError') setError(err.message || 'Preview failed');
      } finally {
        setLoading(false);
      }
    }, debounceMs);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, profile, token, activeBranchId, debounceMs]);

  return (
    <div className="relative w-full h-full bg-white rounded-md border overflow-hidden">
      {loading && (
        <div className="absolute top-2 right-2 z-10 rounded-full bg-white/90 p-1 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-destructive">
          {error}
        </div>
      )}
      {!error && html && (
        <iframe
          title="Report preview"
          srcDoc={html}
          sandbox="allow-same-origin"
          className="w-full h-full border-0 bg-white"
        />
      )}
      {!error && !html && !loading && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Add a test to see the live report preview.
        </div>
      )}
    </div>
  );
}
