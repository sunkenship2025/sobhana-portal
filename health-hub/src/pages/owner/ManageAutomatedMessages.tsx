/**
 * Automated messages — scheduled WhatsApp sends, one row per branch × domain.
 *
 * Owner-only, because a row here decides who receives a message carrying a
 * day's takings. Recipients are not typed in: they are the owner numbers held
 * in Roles, so there is one place a number lives and one place to change it.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Send, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { apiRequest } from '@/lib/utils';
import { API_BASE } from '@/lib/api';

interface Row {
  branchId: string;
  branchName: string;
  branchCode: string;
  domain: 'DIAGNOSTICS' | 'CLINIC';
  enabled: boolean;
  sendAtMinutes: number;
  lastRun: { runDate: string; status: string; detail: string | null; sentAt: string } | null;
}

const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 1350;
};
const DOMAIN_LABEL: Record<Row['domain'], string> = {
  DIAGNOSTICS: 'Diagnostic day sheet',
  CLINIC: 'OP day sheet',
};

export default function ManageAutomatedMessages() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ rows: Row[]; recipients: string[] }>({
    queryKey: ['automated-messages'],
    queryFn: () => apiRequest(`${API_BASE}/automated-messages`),
  });

  const save = useMutation({
    mutationFn: (body: Pick<Row, 'branchId' | 'domain' | 'enabled' | 'sendAtMinutes'>) =>
      apiRequest(`${API_BASE}/automated-messages`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automated-messages'] });
      toast.success('Saved');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save'),
    onSettled: () => setPending(null),
  });

  const commit = (r: Row, patch: Partial<Row>) => {
    setPending(`${r.branchId}:${r.domain}`);
    save.mutate({
      branchId: r.branchId,
      domain: r.domain,
      enabled: patch.enabled ?? r.enabled,
      sendAtMinutes: patch.sendAtMinutes ?? r.sendAtMinutes,
    });
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const recipients = data?.recipients ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Automated messages</h2>
        <p className="text-sm text-muted-foreground">
          Scheduled WhatsApp sends. Each branch and sheet has its own switch and time, so two
          branches arrive as two separate messages.
        </p>
      </div>

      {/* Recipients come from Roles — say so, and say what is missing. */}
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
        <Send className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <span className="font-medium">Goes to the owner</span>{' '}
          {recipients.length > 0 ? (
            <span className="text-muted-foreground">
              — {recipients.map((p) => `+91 ${p}`).join(', ')}. Change it in Roles.
            </span>
          ) : (
            <span className="text-destructive">
              — no owner has a phone number yet. Add one in Roles or nothing will send.
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {(data?.rows ?? []).map((r) => {
          const key = `${r.branchId}:${r.domain}`;
          const busy = pending === key;
          return (
            <Card key={key}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base font-medium">
                  <span>
                    {r.branchName}{' '}
                    <span className="text-muted-foreground">· {DOMAIN_LABEL[r.domain]}</span>
                  </span>
                  <Switch
                    checked={r.enabled}
                    disabled={busy}
                    onCheckedChange={(v) => commit(r, { enabled: v })}
                  />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-end gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Send at</Label>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <Input
                        type="time"
                        className="h-9 w-32"
                        value={toTime(r.sendAtMinutes)}
                        disabled={busy}
                        onChange={(e) => commit(r, { sendAtMinutes: toMinutes(e.target.value) })}
                      />
                    </div>
                  </div>
                  <p className="pb-2 text-xs text-muted-foreground">
                    Covers that day only, sent after the day's billing is done.
                  </p>
                </div>
                {r.lastRun && (
                  <p className="text-xs text-muted-foreground">
                    Last: {r.lastRun.runDate} · {r.lastRun.status.toLowerCase()}
                    {r.lastRun.detail ? ` — ${r.lastRun.detail}` : ''}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Right now this sends to the owner only. More automatic messages — and more people who can
          receive them — will live here later.
        </span>
      </div>
    </div>
  );
}
