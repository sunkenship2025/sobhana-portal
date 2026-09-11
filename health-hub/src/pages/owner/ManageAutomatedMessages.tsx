/**
 * Automated messages — automations as objects, branches as a property of one.
 *
 * The first cut listed every branch × sheet as its own card, which reads fine at
 * two branches and becomes sixty cards at thirty. An automation is the thing you
 * manage ("Daily Diagnostic Report"); which branches it covers, who it reaches
 * and when it fires all live inside it. Storage is still one row per branch —
 * that is what makes two branches two messages with two links — but that is a
 * detail of sending, not of managing.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ArrowLeft, Send, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { apiRequest } from '@/lib/utils';
import { API_BASE } from '@/lib/api';

interface Branch { id: string; name: string; code: string }
interface Automation {
  domain: 'DIAGNOSTICS' | 'CLINIC';
  name: string;
  group: string;
  content: string;
  triggerNote: string;
  channel: string;
  audience: string;
  enabled: boolean;
  sendAtMinutes: number;
  branchIds: string[];
  lastRun: { runDate: string; status: string; detail: string | null; sentAt: string } | null;
  failing: boolean;
}
interface Payload { automations: Automation[]; branches: Branch[]; recipients: string[] }

const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 1350;
};
const clockLabel = (m: number) => {
  const h = Math.floor(m / 60);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${ampm}`;
};

export default function ManageAutomatedMessages() {
  const qc = useQueryClient();
  const [openDomain, setOpenDomain] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Payload>({
    queryKey: ['automated-messages'],
    queryFn: () => apiRequest(`${API_BASE}/automated-messages`),
  });

  const save = useMutation({
    mutationFn: (body: { domain: string; enabled: boolean; sendAtMinutes: number; branchIds: string[] }) =>
      apiRequest<Payload>(`${API_BASE}/automated-messages`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (fresh) => {
      qc.setQueryData(['automated-messages'], fresh);
      toast.success('Saved');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save'),
  });

  const sendNow = useMutation({
    mutationFn: (body: { domain: string; branchIds: string[] }) =>
      apiRequest<{ results: { branchId: string; status: string; detail: string | null }[] }>(
        `${API_BASE}/automated-messages/send-now`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.status === 'SENT').length;
      const bad = r.results.filter((x) => x.status !== 'SENT');
      if (ok) toast.success(`Sent ${ok} message${ok === 1 ? '' : 's'}`);
      if (bad.length) toast.error(bad[0].detail || `${bad.length} failed`);
      qc.invalidateQueries({ queryKey: ['automated-messages'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not send'),
  });

  const open = useMemo(
    () => data?.automations.find((a) => a.domain === openDomain) ?? null,
    [data, openDomain],
  );

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data) return null;

  if (open) {
    return (
      <AutomationDetail
        automation={open}
        branches={data.branches}
        recipients={data.recipients}
        onBack={() => setOpenDomain(null)}
        onSave={(patch) => save.mutate({ domain: open.domain, ...patch })}
        onSendNow={(branchIds) => sendNow.mutate({ domain: open.domain, branchIds })}
        saving={save.isPending}
        sending={sendNow.isPending}
      />
    );
  }

  const active = data.automations.filter((a) => a.enabled).length;
  const paused = data.automations.length - active;
  const failed = data.automations.filter((a) => a.failing).length;
  const groups = [...new Set(data.automations.map((a) => a.group))];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Automated messages</h2>
        <p className="text-sm text-muted-foreground">
          Keep your team updated automatically. Reports and alerts sent on a schedule.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { n: active, label: 'Active' },
          { n: paused, label: 'Paused' },
          { n: failed, label: 'Failed' },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border p-3">
            <p className="text-xl font-semibold tabular-nums">{s.n}</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
          <div className="divide-y rounded-lg border">
            {data.automations
              .filter((a) => a.group === g)
              .map((a) => (
                <button
                  key={a.domain}
                  onClick={() => setOpenDomain(a.domain)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${a.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.branchIds.length} branch{a.branchIds.length === 1 ? '' : 'es'} · {a.channel} ·{' '}
                      {clockLabel(a.sendAtMinutes)}
                      {a.lastRun ? ` · last sent ${a.lastRun.runDate}` : ''}
                    </span>
                  </span>
                  {a.failing && <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {a.enabled ? 'Active' : 'Paused'}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
          </div>
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        Only the owner receives these today. More automations — and more people who can receive
        them — will live here.
      </p>
    </div>
  );
}

function AutomationDetail({
  automation, branches, recipients, onBack, onSave, onSendNow, saving, sending,
}: {
  automation: Automation;
  branches: Branch[];
  recipients: string[];
  onBack: () => void;
  onSave: (patch: { enabled: boolean; sendAtMinutes: number; branchIds: string[] }) => void;
  onSendNow: (branchIds: string[]) => void;
  saving: boolean;
  sending: boolean;
}) {
  const [enabled, setEnabled] = useState(automation.enabled);
  const [minutes, setMinutes] = useState(automation.sendAtMinutes);
  const [picked, setPicked] = useState<string[]>(automation.branchIds);

  const allOn = picked.length === branches.length && branches.length > 0;
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Automated messages
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{automation.name}</h2>
          <p className="text-sm text-muted-foreground">
            {automation.content} · {automation.channel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{enabled ? 'Active' : 'Paused'}</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trigger</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Every day at</Label>
            <Input
              type="time"
              className="h-9 w-32"
              value={toTime(minutes)}
              onChange={(e) => setMinutes(toMinutes(e.target.value))}
            />
          </div>
          {/* Beside the time, because "does this actually work" is the question
              you have while setting it. Sends immediately and does NOT consume
              tonight's scheduled send. */}
          <Button
            variant="secondary"
            className="h-9"
            disabled={sending || picked.length === 0}
            onClick={() => onSendNow(picked)}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {sending ? 'Sending…' : 'Send now'}
          </Button>
          <p className="pb-2 text-xs text-muted-foreground">{automation.triggerNote}. Covers that day only.</p>
        </div>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Send to</p>
        {recipients.length > 0 ? (
          <p className="text-sm">
            {automation.audience}{' '}
            <span className="text-muted-foreground">· {recipients.map((r) => `+91 ${r}`).join(', ')}</span>
          </p>
        ) : (
          <p className="text-sm text-destructive">
            No owner has a phone number yet — add one in Roles or nothing will send.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Branches</p>
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setPicked(allOn ? [] : branches.map((b) => b.id))}
          >
            {allOn ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="divide-y rounded-lg border">
          {branches.map((b) => (
            <label key={b.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
              <Checkbox checked={picked.includes(b.id)} onCheckedChange={() => toggle(b.id)} />
              <span>{b.name}</span>
              <span className="text-xs text-muted-foreground">{b.code}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Each branch is sent as its own message with its own link.
        </p>
      </section>

      {automation.lastRun && (
        <p className="text-xs text-muted-foreground">
          Last run: {automation.lastRun.runDate} · {automation.lastRun.status.toLowerCase()}
          {automation.lastRun.detail ? ` — ${automation.lastRun.detail}` : ''}
        </p>
      )}

      <div className="flex justify-end">
        <Button disabled={saving} onClick={() => onSave({ enabled, sendAtMinutes: minutes, branchIds: picked })}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
