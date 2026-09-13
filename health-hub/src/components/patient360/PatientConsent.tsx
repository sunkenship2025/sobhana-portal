/**
 * Consent, on the line that shows the phone number — because consent is a property of
 * the number, not of a settings page.
 *
 * Two switches, not one. Staff sending a report has always implied consent for reports;
 * it has never implied consent to be sold to. And an inbound STOP is not staff-
 * reversible: a switch a staff member can flip is not an opt-out, it is a suggestion.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { getConsent, setConsent } from '@/pages/owner/automations/api';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export function PatientConsent({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['consent', patientId], queryFn: () => getConsent(patientId),
  });

  const save = useMutation({
    mutationFn: (on: boolean) => setConsent(patientId, on, on ? undefined : 'Asked us to stop'),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['consent', patientId] });
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes('PATIENT_OPTED_OUT_BY_REPLY')
          ? 'She replied STOP herself. Only she can turn this back on, by replying START.'
          : e.message,
      ),
  });

  if (!data || !data.phone) return null;
  const m = data.marketing;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          WhatsApp
          <Badge variant="outline" className={`text-[11px] font-normal ${
            data.service.on ? 'border-emerald-200 text-emerald-700' : ''}`}>
            {data.service.on ? 'Reports on' : 'Reports off'}
          </Badge>
          <Badge variant="outline" className={`text-[11px] font-normal ${
            m.blockedByPhoneOptOut ? 'border-destructive/30 text-destructive' : ''}`}>
            {m.blockedByPhoneOptOut ? 'Offers stopped' : m.on ? 'Offers on' : 'Offers off'}
          </Badge>
          <span className="text-xs underline-offset-2 hover:underline">change</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-96 p-0">
        <p className="border-b px-4 py-3 text-sm font-semibold">WhatsApp · {data.phone}</p>

        <div className="flex items-start gap-3 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Reports, bills and OTP</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {data.service.on && data.service.since
                ? `On since ${shortDate(data.service.since)}`
                : 'Off'}
            </span>
          </span>
          <Switch checked={data.service.on} disabled />
        </div>

        <div className="flex items-start gap-3 border-t px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Offers and campaigns</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {m.blockedByPhoneOptOut
                ? m.staffCanReEnable
                  ? `Turned off by staff${m.optedOutAt ? ` on ${shortDate(m.optedOutAt)}` : ''}`
                  : `Replied STOP${m.optedOutAt ? ` on ${shortDate(m.optedOutAt)}` : ''}. Staff cannot switch this back on — she can, by replying START.`
                : m.on
                  ? `On${m.since ? ` since ${shortDate(m.since)}` : ''}`
                  : 'Never asked. No journey may message her with an offer.'}
            </span>
            {data.phoneSharedWithPatients > 1 && (
              <span className="mt-1 block text-xs text-muted-foreground">
                This number is shared with {data.phoneSharedWithPatients - 1} other patient
                {data.phoneSharedWithPatients > 2 ? 's' : ''} — an opt-out here covers all of them.
              </span>
            )}
          </span>
          {m.staffCanReEnable ? (
            <Switch
              checked={m.on}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate(v)}
            />
          ) : (
            <span className="flex shrink-0 items-center gap-1 pt-1 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" /> Locked
            </span>
          )}
        </div>

        {data.deceasedAt && (
          <p className="border-t bg-destructive/5 px-4 py-3 text-xs">
            <b>Recorded as deceased on {shortDate(data.deceasedAt)}.</b> No automated message of any
            kind will be sent. Reports can still be printed at the counter.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
