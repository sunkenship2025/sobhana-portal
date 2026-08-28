/**
 * SignatureEditor — the escape hatch for automatic background removal.
 *
 * No threshold suits every photo, and chasing that with more clever rules only
 * moves which photo breaks. So the result is handed to the person who can see
 * it: a strength slider that re-runs the removal, an eraser for whatever it left
 * behind (a rule fragment, a stray mark, part of the next line down), and undo.
 *
 * Nothing is uploaded until "Use this signature" — the original stays untouched
 * on Cancel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Eraser, Loader2, RotateCcw, Undo2 } from 'lucide-react';
import { SignatureReveal } from './SignatureReveal';
import { cleanSignature, contentBox, type SignatureReveal as Reveal } from '@/lib/signatureImage';

/** Slider ends, as an offset to the Sauvola k. Left keeps more, right is stricter. */
const STRENGTH_MIN = -0.14;
const STRENGTH_MAX = 0.16;
/** Eraser radius as a share of the image width — scales with the photo. */
const BRUSH_SHARE = 0.02;
const BRUSH_MIN_PX = 6;
/** Undo depth. Each step is a full frame, so this is bounded on purpose. */
const HISTORY_LIMIT = 12;

interface SignatureEditorProps {
  /** The upload as picked — re-run when the strength changes. */
  source: File;
  /** First result, already cleaned at the default strength. */
  initial: File;
  /** Plays once before the tools appear; null skips straight to editing. */
  reveal: Reveal | null;
  /** True while the parent is uploading. */
  busy?: boolean;
  onApply: (file: File) => void;
  onCancel: () => void;
}

export function SignatureEditor({
  source,
  initial,
  reveal,
  busy = false,
  onApply,
  onCancel,
}: SignatureEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<ImageData[]>([]);
  const drawingRef = useRef(false);
  const [playing, setPlaying] = useState(!!reveal);
  const [strength, setStrength] = useState(0);
  const [recomputing, setRecomputing] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [current, setCurrent] = useState(initial);
  const initialUrl = useMemo(() => URL.createObjectURL(initial), [initial]);

  // The reveal frames and this preview are object URLs nobody else owns.
  useEffect(
    () => () => {
      URL.revokeObjectURL(initialUrl);
      if (reveal) {
        URL.revokeObjectURL(reveal.originalUrl);
        URL.revokeObjectURL(reveal.cutoutUrl);
      }
    },
    [initialUrl, reveal],
  );

  // Paint whatever the current result is onto the editing canvas.
  const load = useCallback(async (file: File) => {
    const bitmap = await createImageBitmap(file);
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    historyRef.current = [];
    setCanUndo(false);
  }, []);

  useEffect(() => {
    if (!playing) void load(current);
    // `current` is replaced wholesale by the slider; reloading is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, current, load]);

  // Re-run the removal at a new strength. Erases are dropped — the pixels they
  // applied to no longer exist.
  const applyStrength = async (value: number) => {
    setRecomputing(true);
    try {
      const result = await cleanSignature(source, value);
      // Only the file is wanted here; the animation frames would leak.
      if (result.reveal) {
        URL.revokeObjectURL(result.reveal.originalUrl);
        URL.revokeObjectURL(result.reveal.cutoutUrl);
      }
      setCurrent(result.file);
    } finally {
      setRecomputing(false);
    }
  };

  const pushHistory = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    setCanUndo(true);
  };

  const undo = () => {
    const canvas = canvasRef.current;
    const previous = historyRef.current.pop();
    if (!canvas || !previous) return;
    canvas.getContext('2d')!.putImageData(previous, 0, 0);
    setCanUndo(historyRef.current.length > 0);
  };

  /** Canvas coordinates for a pointer event — the canvas is displayed scaled. */
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const erase = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = at(e);
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(BRUSH_MIN_PX, canvas.width * BRUSH_SHARE), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const apply = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const { width: w, height: h } = canvas;
    // Erasing at the edge leaves empty margin — re-crop to whatever is left.
    const frame = ctx.getImageData(0, 0, w, h);
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < frame.data.length; i += 4, p += 1) alpha[p] = frame.data[i + 3];
    const box = contentBox(alpha, w, h) ?? { x: 0, y: 0, w, h };
    const out = document.createElement('canvas');
    out.width = box.w;
    out.height = box.h;
    out.getContext('2d')!.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) return;
    onApply(new File([blob], `${source.name.replace(/\.[^.]+$/, '')}.png`, { type: 'image/png' }));
  };

  return (
    <Dialog open onOpenChange={(o) => (!o && !busy ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Background removed</DialogTitle>
          <DialogDescription>
            Adjust the strength if strokes are missing or the paper is still showing, and rub out
            anything left behind. Nothing is saved until you apply it.
          </DialogDescription>
        </DialogHeader>

        <div
          className="rounded-lg border bg-muted/30 p-3"
          style={{
            backgroundImage:
              'linear-gradient(45deg,#00000008 25%,transparent 25%),linear-gradient(-45deg,#00000008 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#00000008 75%),linear-gradient(-45deg,transparent 75%,#00000008 75%)',
            backgroundSize: '12px 12px',
            backgroundPosition: '0 0,0 6px,6px -6px,-6px 0',
          }}
        >
          {playing && reveal ? (
            <SignatureReveal
              reveal={reveal}
              finalUrl={initialUrl}
              onDone={() => setPlaying(false)}
            />
          ) : (
            <canvas
              ref={canvasRef}
              className={`mx-auto block max-h-[220px] w-auto max-w-full ${
                erasing ? 'cursor-crosshair' : ''
              }`}
              style={{ touchAction: 'none' }}
              onPointerDown={(e) => {
                if (!erasing) return;
                drawingRef.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                pushHistory();
                erase(e);
              }}
              onPointerMove={(e) => {
                if (erasing && drawingRef.current) erase(e);
              }}
              onPointerUp={() => {
                drawingRef.current = false;
              }}
            />
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="sig-strength">Strength</Label>
              <span className="text-xs text-muted-foreground">
                {recomputing ? 'Re-running…' : strength === 0 ? 'Default' : strength < 0 ? 'Keeps more ink' : 'Removes more'}
              </span>
            </div>
            <Slider
              id="sig-strength"
              min={STRENGTH_MIN}
              max={STRENGTH_MAX}
              step={0.02}
              value={[strength]}
              disabled={playing || busy}
              onValueChange={([v]) => setStrength(v)}
              onValueCommit={([v]) => applyStrength(v)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={erasing ? 'default' : 'outline'}
              size="sm"
              disabled={playing || busy}
              onClick={() => setErasing((v) => !v)}
            >
              <Eraser className="mr-1 h-4 w-4" />
              {erasing ? 'Erasing' : 'Erase'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canUndo || playing || busy}
              onClick={undo}
            >
              <Undo2 className="mr-1 h-4 w-4" />
              Undo
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={playing || busy || recomputing}
              onClick={() => void load(current)}
            >
              <RotateCcw className="mr-1 h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={playing || busy || recomputing}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Use this signature
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
