import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Wire the pdf.js worker. Vite resolves this URL at build time, so the worker
// ships alongside the rest of the bundle (no CDN, no CORS surprises). Using
// the bundled worker also guarantees the version matches the runtime — version
// drift is the #1 cause of "Setting up fake worker" warnings in pdf.js.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface PdfPreviewProps {
  /** Blob URL or remote URL for the PDF. Pass null/undefined to render an empty state. */
  src: string | null | undefined;
  className?: string;
}

/**
 * Cross-browser PDF preview. Renders every page stacked vertically inside a
 * scrollable container — no toolbar, no native browser PDF chrome, no buttons.
 * The user reads/skims by scrolling. Print/download live on the parent page.
 *
 * Identical look in Chrome, Safari, Firefox, Edge because pdf.js does the
 * rendering, not the browser's built-in PDF viewer.
 */
export function PdfPreview({ src, className }: PdfPreviewProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resize-observe the scroll container so each page auto-fits the available
  // width. Without this, pdf.js renders at intrinsic CSS pixel size — too
  // narrow on wide screens, clipped on narrow ones.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset on source change (e.g. user re-opens preview after editing results).
  useEffect(() => {
    setNumPages(null);
    setError(null);
  }, [src]);

  if (!src) {
    return (
      <div className={cn('flex items-center justify-center text-sm text-muted-foreground', className)}>
        No preview available
      </div>
    );
  }

  // Cap rendered width so a 1600px window doesn't render a 1600px-wide page;
  // 900px maps roughly to A4 at a comfortable on-screen reading scale, with
  // 32px of horizontal padding on either side.
  const pageWidth = Math.min(Math.max(containerWidth - 64, 320), 900);

  return (
    <div
      ref={containerRef}
      className={cn('h-full w-full overflow-auto bg-muted py-6', className)}
    >
      {error ? (
        <div className="flex h-full items-center justify-center text-sm text-destructive">
          {error}
        </div>
      ) : (
        <div className="mx-auto flex flex-col items-center gap-3" style={{ maxWidth: 900 }}>
          <Document
            file={src}
            loading={
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading preview…
              </div>
            }
            error={
              <div className="flex items-center justify-center py-16 text-sm text-destructive">
                Failed to load PDF
              </div>
            }
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            onLoadError={(e) => setError(e?.message || 'Failed to load PDF')}
          >
            {numPages
              ? Array.from({ length: numPages }, (_, i) => (
                  <Page
                    key={i + 1}
                    pageNumber={i + 1}
                    width={pageWidth || undefined}
                    className="overflow-hidden rounded-md border bg-white shadow-md"
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                  />
                ))
              : null}
          </Document>
        </div>
      )}
    </div>
  );
}
