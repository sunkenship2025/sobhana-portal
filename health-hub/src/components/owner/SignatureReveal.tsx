/**
 * SignatureReveal — plays the background removal back to the user: the paper
 * dissolves outward from the centre while the ink stays put, then the frame
 * eases into the crop that actually gets stored.
 *
 * It is a confidence check, not decoration. cleanSignature() is a threshold, and
 * a thresholded lined page or a faint pencil stroke can come out wrong; watching
 * the paper leave is how staff notice before the signature is on a report.
 *
 * The dissolve radius is driven by rAF rather than a CSS transition because
 * animating a custom property needs an @property registration, and one global
 * CSS rule for one animation isn't worth it. Honours prefers-reduced-motion by
 * jumping straight to the result.
 */
import { useEffect, useRef, useState } from 'react';
import type { SignatureReveal as Reveal } from '@/lib/signatureImage';

const DISSOLVE_MS = 780;
const ZOOM_MS = 420;
const ZOOM_DELAY_MS = 120;
/** Matches the h-16 preview the signature already renders at. */
const STAGE_H = 64;

const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const maskAt = (radiusPct: number) =>
  `radial-gradient(circle at 50% 50%, #000 0%, #000 ${radiusPct}%, transparent ${radiusPct + 18}%)`;

interface SignatureRevealProps {
  reveal: Reveal;
  /** The cleaned + cropped image the animation lands on. */
  finalUrl: string;
  /** Fired once the animation is over — the caller revokes the object URLs. */
  onDone: () => void;
}

export function SignatureReveal({ reveal, finalUrl, onDone }: SignatureRevealProps) {
  const paperRef = useRef<HTMLImageElement>(null);
  const cutRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setDone(true);
      onDone();
      return;
    }

    let raf = 0;
    let zoomTimer = 0;
    let endTimer = 0;
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DISSOLVE_MS);
      const eased = easeInOut(t);
      const cut = cutRef.current;
      if (cut) {
        const mask = maskAt(eased * 120);
        cut.style.maskImage = mask;
        cut.style.webkitMaskImage = mask;
        cut.style.opacity = String(Math.min(1, t * 5));
      }
      if (paperRef.current) paperRef.current.style.opacity = String(1 - eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    // Then zoom the frame so the crop box fills the stage. Origin sits on the
    // box centre, so the scale keeps it put and the translate recentres it.
    zoomTimer = window.setTimeout(() => {
      const frame = frameRef.current;
      if (!frame) return;
      const { x, y, w, h } = reveal.box;
      const cx = x + w / 2;
      const cy = y + h / 2;
      frame.style.transformOrigin = `${cx * 100}% ${cy * 100}%`;
      frame.style.transition = `transform ${ZOOM_MS}ms cubic-bezier(.4,0,.2,1)`;
      frame.style.transform = `translate(${(0.5 - cx) * 100}%, ${(0.5 - cy) * 100}%) scale(${
        1 / Math.max(w, h)
      })`;
    }, DISSOLVE_MS + ZOOM_DELAY_MS);

    endTimer = window.setTimeout(() => {
      setDone(true);
      onDone();
    }, DISSOLVE_MS + ZOOM_DELAY_MS + ZOOM_MS);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(zoomTimer);
      clearTimeout(endTimer);
    };
    // Runs once per reveal; onDone is a stable callback from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  if (done) {
    return <img src={finalUrl} alt="Signature, background removed" className="mx-auto h-16" />;
  }

  return (
    <div
      className="relative mx-auto overflow-hidden"
      style={{ height: STAGE_H, width: STAGE_H * reveal.aspect }}
    >
      <div ref={frameRef} className="absolute inset-0">
        <img
          ref={paperRef}
          src={reveal.originalUrl}
          alt=""
          className="absolute inset-0 h-full w-full"
        />
        <div ref={cutRef} className="absolute inset-0" style={{ opacity: 0 }}>
          <img src={reveal.cutoutUrl} alt="" className="absolute inset-0 h-full w-full" />
        </div>
      </div>
    </div>
  );
}
