import { useState } from 'react';
export function PulseOrb({ thinking, badge, onOpen, onHover }: { thinking: boolean; badge?: boolean; onOpen: () => void; onHover: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-center gap-1.5" onMouseEnter={() => { setHover(true); onHover(); }} onMouseLeave={() => setHover(false)}>
      {hover && <div className="pointer-events-none absolute -top-11 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 text-[11px] leading-tight text-background shadow">Ask Pulse<br />about your data</div>}
      <button type="button" aria-label="Open Pulse" onClick={onOpen} onFocus={onHover} className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <div className={`pulse-orb ${thinking ? 'is-thinking' : ''}`} />
        {badge && <span className="pulse-badge" />}
      </button>
      <span className="pulse-label">PULSE</span>
    </div>
  );
}
