import { useState } from 'react';

export function PulseOrb({ thinking, badge, hint, onOpen, onHover }: {
  thinking: boolean; badge?: boolean; hint?: string | null; onOpen: () => void; onHover: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-center gap-2"
      onMouseEnter={() => { setHover(true); onHover(); }} onMouseLeave={() => setHover(false)}>
      {hover && (
        <div className="pulse-tip pointer-events-none absolute bottom-[86px] right-0 max-w-[240px] rounded-lg bg-foreground px-3 py-2 text-[11.5px] leading-snug text-background shadow-lg">
          {hint || <>Ask Pulse<br />about your data</>}
          <span className="absolute -bottom-1 right-[22px] h-2 w-2 rotate-45 bg-foreground" />
        </div>
      )}
      <button type="button" aria-label="Open Pulse" onClick={onOpen} onFocus={onHover}
        className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <div className={`pulse-orb ${thinking ? 'is-thinking' : ''}`} />
        {badge && <span className="pulse-badge" />}
      </button>
      <span className="pulse-label">PULSE</span>
    </div>
  );
}
