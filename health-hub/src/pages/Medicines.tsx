/**
 * Medicines — the list doctors find when they type or dictate.
 *
 * Owner and doctors alike can search it, add a medicine, and edit any of them:
 * the name that prints, generic and brand, strength, form, route, the other names
 * it goes by (including how the microphone mishears it), whether doctors are
 * offered it at all, and — with a reason — whether it is a controlled drug.
 *
 * Medicines doctors wrote as typed on a signed prescription land here too,
 * tagged with who wrote them, and are edited like any other. Nothing here can
 * change a signed prescription: it carries its own copy of every line.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2, Pill, Plus, Search } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useConfirm } from '@/hooks/use-confirm';
import { ROUTE_OPTIONS } from '@/lib/doctorApi';

interface Med {
  id: string;
  canonicalName: string;
  genericName: string | null;
  brandName: string | null;
  manufacturer: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  route: string | null;
  aliases: string[];
  scheduleClass: string | null;
  isScheduleX: boolean;
  isNdps: boolean;
  source: 'CURATED' | 'LEARNED' | 'IMPORTED' | string;
  usageCount: number;
  isActive: boolean;
  createdAt: string;
  learnedBy: { name: string } | null;
}

const api = <T,>(path: string, init: RequestInit = {}) =>
  apiRequest<T>(`${API_BASE}/medications${path}`, {
    ...init,
    headers: { 'X-Branch-Id': useBranchStore.getState().activeBranchId ?? '', ...(init.headers ?? {}) },
  });

const day = (v: string) => new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** Where it came from, in words. */
function origin(m: Med): string {
  if (m.source === 'LEARNED') return `Written by ${m.learnedBy?.name ?? 'a doctor'} · ${day(m.createdAt)}`;
  if (m.source === 'CURATED') return m.learnedBy ? `Added by ${m.learnedBy.name} · ${day(m.createdAt)}` : 'Clinic list';
  return 'Catalogue';
}

export default function Medicines() {
  const role = useAuthStore((s) => s.user?.role);
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300);
  const [rows, setRows] = useState<Med[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState<Med | 'new' | null>(null);

  const load = useCallback(async (offset = 0) => {
    if (offset) setMore(true); else setLoading(true);
    try {
      const r = await api<{ items: Med[]; hasMore: boolean }>(`?q=${encodeURIComponent(dq.trim())}&offset=${offset}`);
      setRows((cur) => (offset ? [...cur, ...r.items] : r.items));
      setHasMore(r.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load medicines');
    } finally {
      setLoading(false);
      setMore(false);
    }
  }, [dq]);

  useEffect(() => { void load(0); }, [load]);

  const saved = (m: Med) => {
    setEditing(null);
    setRows((cur) => (cur.some((r) => r.id === m.id) ? cur.map((r) => (r.id === m.id ? m : r)) : [m, ...cur]));
  };

  return (
    <AppLayout context={role === 'doctor' ? 'doctor' : undefined}>
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Medicines</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              What doctors find when they type or dictate. Prescriptions already signed keep what they were signed with.
            </p>
          </div>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> Add medicine
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search by brand, molecule or another name…" className="h-10 pl-9" aria-label="Search medicines"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {dq.trim()
              ? 'Searching the full catalogue, most-used first.'
              : 'The clinic’s own medicines — the clinic list, ones doctors added, and anything prescribed here. Search to reach the full catalogue.'}
          </p>
        </div>

        {loading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Pill}
            title={dq.trim() ? 'No medicine by that name' : 'No medicines yet'}
            description={dq.trim() ? 'Add it, and doctors will find it by that name straight away.' : 'Add the medicines the clinic uses.'}
          />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {rows.map((m) => {
              const details = [
                m.brandName && m.brandName !== m.canonicalName ? m.brandName : null,
                m.genericName && m.genericName !== m.canonicalName ? m.genericName : null,
                m.strength ? `${m.strength}${m.strengthUnit ? ` ${m.strengthUnit}` : ''}` : null,
                m.dosageForm, m.route, m.manufacturer,
              ].filter(Boolean).join(' · ');
              return (
                <li key={m.id} className="flex flex-wrap items-start gap-3 p-3 sm:p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.canonicalName}</span>
                      <Badge variant="outline" className="h-5 font-normal">{origin(m)}</Badge>
                      {!m.isActive && <Badge variant="outline" className="h-5 text-amber-700">Hidden from doctors</Badge>}
                      {m.isScheduleX && <Badge variant="outline" className="h-5 text-red-700">Schedule X</Badge>}
                      {m.isNdps && <Badge variant="outline" className="h-5 text-red-700">NDPS</Badge>}
                      {m.scheduleClass && !['X', 'NDPS'].includes(m.scheduleClass) && (
                        <Badge variant="outline" className="h-5">Sch {m.scheduleClass}</Badge>
                      )}
                    </div>
                    {details && <p className="text-xs text-muted-foreground">{details}</p>}
                    {m.aliases.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Also called: {m.aliases.slice(0, 5).join(', ')}{m.aliases.length > 5 ? ` +${m.aliases.length - 5} more` : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {m.usageCount > 0 && <span className="text-xs text-muted-foreground">used {m.usageCount}×</span>}
                    <Button variant="outline" size="sm" onClick={() => setEditing(m)}>Edit</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {hasMore && !loading && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={more} onClick={() => void load(rows.length)}>
              {more && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Show more
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <MedicineDialog
          med={editing === 'new' ? null : editing}
          initialName={editing === 'new' ? q.trim() : ''}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onDeleted={(id) => { setEditing(null); setRows((cur) => cur.filter((r) => r.id !== id)); }}
        />
      )}
    </AppLayout>
  );
}

const SCHEDULES = ['OTC', 'H', 'H1', 'X'] as const;

function MedicineDialog({
  med, initialName, onClose, onSaved, onDeleted,
}: {
  med: Med | null;
  initialName: string;
  onClose: () => void;
  onSaved: (m: Med) => void;
  onDeleted: (id: string) => void;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const [f, setF] = useState({
    canonicalName: med?.canonicalName ?? initialName,
    brandName: med?.brandName ?? '',
    genericName: med?.genericName ?? '',
    strength: med?.strength ?? '',
    strengthUnit: med?.strengthUnit ?? 'mg',
    dosageForm: med?.dosageForm ?? '',
    route: med?.route ?? '',
    manufacturer: med?.manufacturer ?? '',
    aliases: (med?.aliases ?? []).join('\n'),
    isActive: med?.isActive ?? true,
  });
  // The controlled-drug flags start from what is stored; changing them takes a reason.
  const initialSchedule = med?.scheduleClass && med.scheduleClass !== 'NDPS' ? med.scheduleClass : med?.isScheduleX ? 'X' : '';
  const [schedule, setSchedule] = useState(initialSchedule);
  const [ndps, setNdps] = useState(med?.isNdps ?? false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const controlledChanged = schedule !== initialSchedule || ndps !== (med?.isNdps ?? false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  const save = async () => {
    if (!f.canonicalName.trim()) { toast.error('Give it the name that should print on the prescription'); return; }
    if (controlledChanged && !reason.trim()) { toast.error('Say why the controlled-drug setting is changing'); return; }
    setBusy(true);
    try {
      const body = {
        ...f,
        aliases: f.aliases.split('\n').map((a) => a.trim()).filter(Boolean),
        ...(controlledChanged ? { scheduleClass: schedule || null, isScheduleX: schedule === 'X', isNdps: ndps, reason: reason.trim() } : {}),
      };
      const m = med
        ? await api<Med>(`/${med.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api<Med>('', { method: 'POST', body: JSON.stringify(body) });
      toast.success(med ? 'Medicine saved' : 'Medicine added — doctors will find it straight away');
      onSaved(m);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!med) return;
    const ok = await confirm({
      title: `Delete ${med.canonicalName}?`,
      description: 'Doctors will no longer find it when they type or dictate. Prescriptions that already name it keep their own copy.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/${med.id}`, { method: 'DELETE' });
      toast.success('Medicine deleted');
      onDeleted(med.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  };

  const field = (label: string, k: keyof typeof f, placeholder = '') => (
    <label className="space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input value={f[k] as string} onChange={set(k)} placeholder={placeholder} className="h-9" />
    </label>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{med ? 'Edit medicine' : 'Add a medicine'}</DialogTitle>
          <DialogDescription>
            {med ? origin(med) : 'Doctors will find it by any of its names — typed or dictated.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {field('Name on the prescription *', 'canonicalName', 'Amoxicillin 500 mg + Clavulanic acid 125 mg')}
          <div className="grid gap-3 sm:grid-cols-2">
            {field('Brand', 'brandName', 'Augmentin 625')}
            {field('Generic / molecule', 'genericName', 'Amoxicillin + Clavulanic acid')}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {field('Strength', 'strength', '500+125')}
            {field('Unit', 'strengthUnit', 'mg')}
            {field('Form', 'dosageForm', 'tablet')}
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">Route</span>
              <Select value={f.route || 'none'} onValueChange={(v) => setF((cur) => ({ ...cur, route: v === 'none' ? '' : v }))}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {ROUTE_OPTIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>
          {field('Manufacturer', 'manufacturer')}
          <label className="block space-y-1">
            <span className="block text-xs text-muted-foreground">Also called / heard as — one per line</span>
            <Textarea
              value={f.aliases} onChange={set('aliases')} rows={3}
              placeholder={'augmentin\naumintin\namoxyclav 625'}
            />
            <span className="block text-xs text-muted-foreground">
              Short forms the doctors use, and how dictation mishears it. Typing or saying any of these finds this medicine.
            </span>
          </label>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Offer to doctors</p>
              <p className="text-xs text-muted-foreground">Off hides it from search and dictation without deleting it.</p>
            </div>
            <Switch checked={f.isActive} onCheckedChange={(v) => setF((cur) => ({ ...cur, isActive: v }))} aria-label="Offer to doctors" />
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Controlled drug</p>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-xs text-muted-foreground">Schedule</span>
                <Select value={schedule || 'none'} onValueChange={(v) => setSchedule(v === 'none' ? '' : v)}>
                  <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    {SCHEDULES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={ndps} onCheckedChange={(v) => setNdps(v === true)} aria-label="NDPS" />
                NDPS (narcotic / psychotropic)
              </label>
            </div>
            <p className="text-xs text-muted-foreground">Schedule X and NDPS medicines cannot be prescribed over phone or video.</p>
            {controlledChanged && (
              <Input
                value={reason} onChange={(e) => setReason(e.target.value)} className="h-9"
                placeholder="Why is this changing? (required)" aria-label="Reason for the controlled-drug change"
              />
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {med ? (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove()}>Delete</Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {med ? 'Save' : 'Add medicine'}
            </Button>
          </div>
        </DialogFooter>
        {ConfirmDialog}
      </DialogContent>
    </Dialog>
  );
}
