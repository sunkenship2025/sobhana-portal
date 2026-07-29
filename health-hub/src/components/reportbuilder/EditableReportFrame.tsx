/**
 * EditableReportFrame — the "type on the report" edit surface.
 *
 * It iframes the REAL server-rendered report in `editable` mode (the renderer is
 * untouched; the preview endpoint just appends a tiny in-place editor to its own
 * output). So the thing you edit IS the real render — no client reproduction.
 *
 * Text edits (title / method / test name / value) are applied by the injected
 * contenteditable and streamed back here via postMessage; we update config but do
 * NOT re-fetch, so typing never reloads the frame. Structural changes (add /
 * delete / reorder / settings / layout) bump `reloadKey`, which re-renders the
 * iframe from the (now-updated) config through the same real renderer.
 */
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { PreviewPayload } from './ReportPreviewFrame';

export type PanelEditField = 'label' | 'panelMethodText' | 'comments' | 'interpretation' | 'narrativeTemplateHtml';

interface Props {
  payload: PreviewPayload;
  profile: 'digital' | 'letterhead';
  reloadKey: number;
  headers: Record<string, string>;
  onPanelEdit: (field: PanelEditField, value: string) => void;
  onItemEdit: (index: number, field: 'label' | 'value', value: string) => void;
  onInspect: (index: number, focus?: 'ranges') => void;
  onDelete: (index: number) => void;
  onCreate: (name: string) => void;
  onReorder: (from: number, to: number, before: boolean) => void;
  onSectionRename: (from: string, to: string) => void;
  onSectionMethod: (name: string, value: string) => void;
  onSectionKV: (name: string) => void;
  onAddSection: () => void;
}

export function EditableReportFrame({
  payload, profile, reloadKey, headers,
  onPanelEdit, onItemEdit, onInspect, onDelete, onCreate,
  onReorder, onSectionRename, onSectionMethod, onSectionKV, onAddSection,
}: Props) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [frameH, setFrameH] = useState(0);

  // Latest payload/callbacks without forcing a re-fetch (that's what reloadKey is for).
  const payloadRef = useRef(payload); payloadRef.current = payload;
  const cb = useRef({ onPanelEdit, onItemEdit, onInspect, onDelete, onCreate, onReorder, onSectionRename, onSectionMethod, onSectionKV, onAddSection });
  cb.current = { onPanelEdit, onItemEdit, onInspect, onDelete, onCreate, onReorder, onSectionRename, onSectionMethod, onSectionKV, onAddSection };

  // Re-render the iframe only on structural change / profile flip.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      setLoading(true); setErr(null);
      try {
        const res = await fetch(`${API_BASE}/clinical-panels/preview-html`, {
          method: 'POST', headers, signal: ctrl.signal,
          body: JSON.stringify({ ...payloadRef.current, profile, editable: true }),
        });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const text = await res.text();
        if (!cancelled) setHtml(text);
      } catch (e: any) {
        if (!cancelled && e?.name !== 'AbortError') setErr(e?.message || 'Preview failed');
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [reloadKey, profile, headers]);

  // Receive edits from inside the iframe.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const d = e.data;
      if (!d || !d.__rbEdit) return;
      const c = cb.current;
      switch (d.type) {
        case 'panel': c.onPanelEdit(d.field, d.value); break;
        case 'item': c.onItemEdit(d.index, d.field, d.value); break;
        case 'inspect': c.onInspect(d.index, d.focus); break;
        case 'delete': c.onDelete(d.index); break;
        case 'create': c.onCreate(d.name); break;
        case 'reorder': c.onReorder(d.from, d.to, d.before); break;
        case 'sectionRename': c.onSectionRename(d.from, d.to); break;
        case 'sectionMethod': c.onSectionMethod(d.name, d.value); break;
        case 'sectionKV': c.onSectionKV(d.name); break;
        case 'addSection': c.onAddSection(); break;
        case 'ready': if (typeof d.height === 'number' && d.height > 0) setFrameH(d.height); break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div className="relative w-full rounded-lg border bg-muted/40 overflow-auto" style={{ minHeight: '80vh' }}>
      {loading && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering…
        </div>
      )}
      {err && (
        <div className="absolute left-1/2 top-6 z-10 -translate-x-1/2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive shadow">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}
      <iframe
        title="Editable report"
        srcDoc={html}
        sandbox="allow-scripts"
        className="w-full bg-white"
        style={{ border: 0, display: 'block', height: frameH ? frameH + 8 : undefined, minHeight: frameH ? undefined : '80vh' }}
      />
    </div>
  );
}
