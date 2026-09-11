import { useState } from 'react';

/**
 * The orb sits in its own 96px box because the halo reaches ~27px past the 52px body — at a
 * 24px inset it was clipping on the viewport edge and the label was running off the bottom.
 * The label lives in the hover card now: the object is the identity, and pages like Messages
 * already have their own controls in that corner.
 */
export function PulseOrb({ thinking, badge, hint, onOpen, onHover }: {
  thinking: boolean; badge?: boolean; hint?: string | null; onOpen: () => void; onHover: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div className="fixed bottom-9 right-9 z-40 flex h-24 w-24 items-center justify-center print:hidden"
      onMouseEnter={() => { setHover(true); onHover(); }} onMouseLeave={() => setHover(false)}>

      {hover && (
        <div className="pulse-tip pointer-events-none absolute bottom-[84px] right-1 w-max max-w-[248px] rounded-xl bg-foreground px-3.5 py-2.5 text-background shadow-xl">
          <div className="text-[10px] font-bold uppercase tracking-[.2em] opacity-55">Pulse</div>
          <div className="mt-0.5 text-[12.5px] leading-snug">{hint || 'Ask anything about your data'}</div>
          <span className="absolute -bottom-1 right-[34px] h-2.5 w-2.5 rotate-45 bg-foreground" />
        </div>)}

      <button type="button" aria-label="Open Pulse" onClick={onOpen} onFocus={onHover}
        className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <div className={`pulse-orb ${thinking ? 'is-thinking' : ''}`} />
        {badge && <span className="pulse-badge" />}
      </button>
    </div>
  );
}
