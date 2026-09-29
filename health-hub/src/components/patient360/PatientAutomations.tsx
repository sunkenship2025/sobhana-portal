/**
 * Automations on the patient's own record.
 *
 * Staff never go to Activity and search — the patient is at the counter or on the phone
 * and they are already on this page. A run's subject is the visit that triggered it, so
 * it renders on that visit's row rather than in a separate panel competing with the
 * timeline; and a coupon the patient is holding sits above the timeline, where it is
 * seen before the patient mentions it, because they usually will not.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getPatientAutomations, reasonLabel, rupees } from '@/pages/owner/automations/api';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** The live-coupon card. Renders nothing when there is nothing to hold. */
export function PatientOffersHeld({ patientId }: { patientId: string }) {
  const { data } = useQuery({
    queryKey: ['patient-automations', patientId],
    queryFn: () => getPatientAutomations(patientId),
  });

  const live = (data?.coupons ?? []).filter(
    (c) => c.status === 'ISSUED' && new Date(c.expiresAt) > new Date() && c.useCount < c.maxUses,
  );
  if (live.length === 0) return null;

  return (
    <div className="space-y-2">
      {live.map((c) => {
        const days = Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 86400000);
        return (
          <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
            <span className="rounded border border-dashed bg-muted/40 px-2.5 py-1 font-mono text-sm font-semibold">
              {c.code}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {c.campaign.discountPercentage}% off{' '}
                {c.campaign.scope !== 'TESTS_ONLY' ? 'the bill'
                  : c.allowedProductIds.length ? `${c.allowedProductIds.length} particular test${c.allowedProductIds.length === 1 ? '' : 's'}` : 'tests'}
                {c.campaign.maxDiscountPerBillInPaise != null &&
                  `, up to ${rupees(c.campaign.maxDiscountPerBillInPaise)}`}
              </span>
              {(() => {
                // The check the counter makes before taking the code. An offer switched off
                // still honours codes already sent, so only a spent budget refuses one.
                const spent = c.reservedPerUseInPaise === 0 && c.campaign.maxDiscountBudgetInPaise != null
                  && c.campaign.committedInPaise + c.campaign.reservedInPaise >= c.campaign.maxDiscountBudgetInPaise;
                return spent ? (
                  <span className="mt-0.5 block text-xs text-destructive">
                    This offer's budget has run out — the counter will refuse the code.
                  </span>
                ) : null;
              })()}
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {c.campaign.holder === 'NOT_ISSUED_PATIENT' && 'For their family & friends, not for this patient · '}
                Issued {shortDate(c.createdAt)}
                {c.automationRunId && ' by a journey'} · expires {shortDate(c.expiresAt)}
                {days > 0 && `, in ${days} day${days === 1 ? '' : 's'}`} ·{' '}
                {c.useCount === 0
                  ? c.maxUses > 1 ? `${c.maxUses} uses, none used yet` : 'not used yet'
                  : `${c.maxUses - c.useCount} of ${c.maxUses} uses left`}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One visit row's automation line. Deliberately also renders the case where nothing
 * happened and why — "did we chase this one?" needs an answer on the quiet rows, which
 * is the half most products leave blank.
 */
export function VisitAutomationLine({ patientId, visitId }: { patientId: string; visitId: string }) {
  const { data } = useQuery({
    queryKey: ['patient-automations', patientId],
    queryFn: () => getPatientAutomations(patientId),
  });

  const runs = (data?.runs ?? []).filter((r) => r.visitId === visitId);
  if (runs.length === 0) return null;

  return (
    <div className="mt-2.5 space-y-1.5 border-t border-dashed pt-2.5">
      {runs.map((r) => {
        const outcome =
          r.convertedAt ? 'Came in'
          : r.holdout ? 'Control group'
          : r.state === 'PENDING' || r.state === 'RUNNING' ? 'Running'
          : reasonLabel(r.stopReason ?? 'Finished');
        const tone =
          r.convertedAt ? 'secondary'
          : r.state === 'PENDING' || r.state === 'RUNNING' ? 'outline'
          : 'outline';
        return (
          <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={tone as 'secondary' | 'outline'} className="shrink-0 text-[11px] font-normal">
              {outcome}
            </Badge>
            <span className="min-w-0 text-muted-foreground">
              <span className="font-medium text-foreground">{r.automation}</span>
              {r.messagesSent > 0 && ` · ${r.messagesSent} message${r.messagesSent === 1 ? '' : 's'}`}
              {r.convertedAt && r.convertedValueInPaise != null &&
                ` · ${rupees(r.convertedValueInPaise)}`}
              {!r.convertedAt && r.nextActionAt &&
                ` · next ${shortDate(r.nextActionAt)}`}
              {r.holdout && ' · enrolled and checked, never messaged'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
