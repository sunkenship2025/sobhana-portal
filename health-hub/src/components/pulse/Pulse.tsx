/**
 * Pulse — the persistent object + expandable panel. V1 exposes Conversation only; Insights,
 * Analysis and Actions are architectural slots, not tabs. Owner-only, matching the API.
 */
import './pulse.css';
import { useAuthStore } from '@/store/authStore';
import { usePulse } from './usePulse';
import { PulseOrb } from './PulseOrb';
import { PulsePanel } from './PulsePanel';

export function Pulse() {
  const role = useAuthStore((s) => s.user?.role);
  const p = usePulse();
  if (role !== 'owner') return null;
  return p.open
    ? <PulsePanel p={p} onClose={() => p.setOpen(false)} />
    : <PulseOrb thinking={p.thinking} onOpen={() => p.setOpen(true)} onHover={p.prefetch} />;
}
