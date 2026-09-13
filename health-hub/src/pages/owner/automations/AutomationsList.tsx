/**
 * The list, and the empty state a new centre sees first.
 *
 * Patient journeys are listed before the day sheets: the day sheets work and nobody
 * opens this screen to look at them — the thing you come here to check is the one
 * messaging patients.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, AlertTriangle, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingState } from '@/components/ui/loading-state';
import { listAutomations, type AutomationRow } from './api';

const GROUP_ORDER = ['Patient journeys', 'Conversations', 'Reports to your team'];

function StatusDot({ status }: { status: AutomationRow['status'] }) {
  const cls =
    status === 'ACTIVE' ? 'bg-emerald-500' : status === 'DRAFT' ? 'bg-muted-foreground/30' : 'bg-muted-foreground/40';
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

function cadence(a: AutomationRow): string {
  if (a.messageCount === 0) return 'No messages yet';
  const days = a.days.filter((d) => d > 0);
  const plural = a.messageCount === 1 ? 'message' : 'messages';
  return days.length
    ? `${a.messageCount} ${plural} · ${days.map((d) => `Day ${d}`).join(' / ')}`
    : `${a.messageCount} ${plural}`;
}

export function AutomationsList({ onOpen, onCreate }: {
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [group, setGroup] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['automations'],
    queryFn: listAutomations,
  });

  const rows = useMemo(() => {
    const all = data?.automations ?? [];
    return all.filter((a) =>
      (status === 'all' || a.status === status) &&
      (group === 'all' || a.group === group) &&
      (q === '' || a.name.toLowerCase().includes(q.toLowerCase())),
    );
  }, [data, q, status, group]);

  if (isLoading) return <LoadingState />;

  const all = data?.automations ?? [];
  const active = all.filter((a) => a.status === 'ACTIVE').length;
  const paused = all.filter((a) => a.status === 'PAUSED').length;

  if (all.length === 0) {
    return (
      <div className="space-y-5">
        <div className="rounded-lg border bg-card px-5 py-10 text-center">
          <p className="text-base font-semibold">No automations yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Follow-ups, reminders and reports that go out on their own — to your patients,
            or to your team.
          </p>
          <Button className="mt-4" onClick={onCreate}>Create automation</Button>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Most centres start here
          </p>
          <div className="rounded-lg border">
            <div className="flex items-center gap-3 p-4">
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">Clinic → diagnostics recovery</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  A patient consulted but never did the tests. Three messages over two weeks,
                  and it stops the moment they come in.
                </span>
              </span>
              <Button onClick={onCreate}>Use this</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Automations</h2>
          <p className="text-sm text-muted-foreground">What goes out on its own.</p>
        </div>
        <Button onClick={onCreate}>Create automation</Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { n: active, label: 'Active' },
          { n: paused, label: 'Paused' },
          { n: all.filter((a) => a.status === 'DRAFT').length, label: 'Draft' },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border p-3">
            <p className="text-xl font-semibold tabular-nums">{s.n}</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-9 w-56 pl-8"
            placeholder="Search automations…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="PAUSED">Paused</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
          </SelectContent>
        </Select>
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {GROUP_ORDER.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {GROUP_ORDER.filter((g) => rows.some((a) => a.group === g)).map((g) => (
        <div key={g} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
          <div className="divide-y rounded-lg border">
            {rows.filter((a) => a.group === g).map((a) => (
              <button
                key={a.id}
                onClick={() => onOpen(a.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
              >
                <StatusDot status={a.status} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{a.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {cadence(a)}
                    {a.runs > 0 && ` · ${a.runs.toLocaleString('en-IN')} runs`}
                    {a.live > 0 && ` · ${a.live.toLocaleString('en-IN')} running now`}
                  </span>
                </span>
                {a.status === 'DRAFT' && (
                  <span className="shrink-0 text-xs text-muted-foreground">Never activated</span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {a.status === 'ACTIVE' ? 'Active' : a.status === 'PAUSED' ? 'Paused' : 'Draft'}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      ))}

      {rows.length === 0 && (
        <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing matches those filters.
        </p>
      )}
    </div>
  );
}
