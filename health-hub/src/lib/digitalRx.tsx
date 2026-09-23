/**
 * The clinic module master switch, client side.
 *
 * One org-wide setting decides whether the doctor portal exists. The server is
 * the enforcement — every prescription and doctor-portal route is behind
 * requireDigitalRx — so this is purely about not showing people doors that are
 * locked, and about saying WHY when somebody arrives at one.
 *
 * Deliberately NOT gated behind the module itself: the UI has to be able to ask
 * "is this on?" precisely when it is off.
 */
import { useApiQuery, apiCall } from '@/lib/query';
import { AppLayout } from '@/components/layout/AppLayout';
import { EmptyState } from '@/components/ui/empty-state';
import { ShieldOff } from 'lucide-react';

/** `undefined` while loading — callers must not treat that as "off".
 *  `voiceEnabled` says whether dictation is configured on the server; without
 *  it the module still works, doctors just type instead of speak. */
export function useDigitalRx(): { enabled: boolean | undefined; voiceEnabled: boolean | undefined; isLoading: boolean } {
  const { data, isLoading } = useApiQuery<{ enabled: boolean; voiceEnabled?: boolean }>({
    queryKey: ['digital-rx-enabled'],
    queryFn: () => apiCall<{ enabled: boolean; voiceEnabled?: boolean }>('/app-settings/digital-prescriptions'),
  });
  return { enabled: data?.enabled, voiceEnabled: data?.voiceEnabled, isLoading };
}

/**
 * Wraps every /doctor/* route.
 *
 * Renders a plain explanation rather than redirecting: a doctor whose only route
 * is /doctor would bounce between it and their default route forever, and the
 * one thing worse than a locked door is a spinning one. Nothing is rendered
 * while the answer is unknown, so the panel never flashes on a working portal.
 */
export function DigitalRxGate({ children }: { children: React.ReactNode }) {
  const { enabled, isLoading } = useDigitalRx();
  if (isLoading || enabled === undefined) return null;
  if (enabled) return <>{children}</>;
  return (
    <AppLayout context="doctor">
      <div className="p-6">
        <EmptyState
          icon={ShieldOff}
          title="Digital prescriptions are switched off"
          description="This clinic is running the paper prescription flow. An owner can turn the digital prescription module on from Consulting doctors."
        />
      </div>
    </AppLayout>
  );
}
