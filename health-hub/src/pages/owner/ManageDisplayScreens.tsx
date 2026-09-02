/**
 * Waiting Room Display — Screens manager (owner)
 *
 * Pair and manage the branch's TVs. Creating a screen mints a code; the display
 * link (this app's origin + /display/<code>) is opened once on the TV and it
 * remembers itself. Revoking kills a lost device's link.
 */
import { useState } from 'react';
import {
  useApiQuery,
  useApiMutation,
  branchRequest,
  apiCall,
  qk,
  useBranchId,
} from '@/lib/query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Tv, Plus, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import ManageDisplayAds from './ManageDisplayAds';

type Screen = {
  id: string;
  name: string;
  code: string;
  slug: string | null;
  branchSlug?: string;
  scope: string;
  doctorIds: string[];
  holdSeconds: number;
  showTrackQr: boolean;
  chimeSound: string;
  isActive: boolean;
  revokedAt: string | null;
  createdAt: string;
  /** TV is holding the display stream open right now (presence, 60s window). */
  online?: boolean;
};
type Doc = { id: string; name: string; specialty?: string; isActive?: boolean; roomLabel?: string | null };

export default function ManageDisplayScreens() {
  const branchId = useBranchId();

  const screensQ = useApiQuery<Screen[]>({
    branchScoped: true,
    queryKey: qk.displayScreens(branchId),
    queryFn: () => branchRequest<Screen[]>('/display-screens', branchId!),
  });
  const doctorsQ = useApiQuery<Doc[]>({
    queryKey: qk.clinicDoctors(),
    queryFn: () => apiCall<Doc[]>('/clinic-doctors'),
  });
  const doctors = (doctorsQ.data ?? []).filter((d) => d.isActive !== false);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'OP' | 'OP_IP'>('OP');
  const [doctorIds, setDoctorIds] = useState<string[]>([]);
  const [holdSeconds, setHoldSeconds] = useState(18);
  const [showTrackQr, setShowTrackQr] = useState(true);
  const [chimeOn, setChimeOn] = useState(true);

  const createM = useApiMutation<
    Screen,
    { name: string; scope: string; doctorIds: string[]; holdSeconds: number; showTrackQr: boolean; chimeSound: string }
  >({
    mutationFn: (v) =>
      branchRequest<Screen>('/display-screens', branchId!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      }),
    invalidate: [qk.displayScreens(branchId)],
    onSuccess: () => {
      toast.success('Screen added');
      setOpen(false);
      setName('');
      setScope('OP');
      setDoctorIds([]);
      setHoldSeconds(18);
      setShowTrackQr(true);
      setChimeOn(true);
    },
    onError: (e) => toast.error(e.message || 'Failed to add screen'),
  });

  const patchM = useApiMutation<Screen, { id: string; data: Record<string, unknown> }>({
    mutationFn: ({ id, data }) =>
      branchRequest<Screen>(`/display-screens/${id}`, branchId!, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    invalidate: [qk.displayScreens(branchId)],
    onError: (e) => toast.error(e.message || 'Failed to update screen'),
  });

  const revokeM = useApiMutation<{ ok: boolean }, string>({
    mutationFn: (id) =>
      branchRequest<{ ok: boolean }>(`/display-screens/${id}`, branchId!, { method: 'DELETE' }),
    invalidate: [qk.displayScreens(branchId)],
    onSuccess: () => toast.success('Screen removed'),
    onError: (e) => toast.error(e.message || 'Failed to remove screen'),
  });

  const roomM = useApiMutation<Doc, { id: string; roomLabel: string }>({
    mutationFn: ({ id, roomLabel }) =>
      branchRequest<Doc>(`/clinic-doctors/${id}`, branchId!, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomLabel }),
      }),
    invalidate: [qk.clinicDoctors()],
    onSuccess: () => toast.success('Room saved'),
    onError: (e) => toast.error(e.message || 'Failed to save room'),
  });
  const [rooms, setRooms] = useState<Record<string, string>>({});
  const roomValue = (d: Doc) => (rooms[d.id] !== undefined ? rooms[d.id] : d.roomLabel || '');
  const saveRoom = (d: Doc) => {
    const val = (rooms[d.id] ?? d.roomLabel ?? '').trim();
    if (val === (d.roomLabel || '')) return; // unchanged — skip the write
    roomM.mutate({ id: d.id, roomLabel: val });
  };

  const [holds, setHolds] = useState<Record<string, number>>({});
  const holdEdit = (s: Screen) => (holds[s.id] !== undefined ? holds[s.id] : s.holdSeconds);
  const saveHold = (s: Screen) => {
    const v = holds[s.id];
    if (v === undefined || v === s.holdSeconds) return;
    patchM.mutate({ id: s.id, data: { holdSeconds: v } });
  };

  const [slugs, setSlugs] = useState<Record<string, string>>({});
  const slugEdit = (s: Screen) => (slugs[s.id] !== undefined ? slugs[s.id] : s.slug || '');
  const saveSlug = (s: Screen) => {
    const v = (slugs[s.id] ?? s.slug ?? '').trim();
    if (!v || v === (s.slug || '')) return;
    patchM.mutate({ id: s.id, data: { slug: v } });
  };

  const urlFor = (s: Screen) => `${window.location.origin}/display/${s.branchSlug || ''}/${s.slug || s.code}`;
  const copyLink = (s: Screen) => {
    navigator.clipboard?.writeText(urlFor(s));
    toast.success('Display link copied');
  };
  const toggleDoc = (id: string) =>
    setDoctorIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const docName = (id: string) => doctors.find((d) => d.id === id)?.name ?? '1 doctor';

  const screens = screensQ.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Tv className="h-5 w-5" /> Waiting Room Display
          </h2>
          <p className="text-sm text-muted-foreground">
            Pair a TV to this branch, then open its link on the screen (kiosk browser). It shows the live OP queue.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Add screen
        </Button>
      </div>

      {screensQ.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : screens.length === 0 ? (
        <div className="rounded-lg border border-dashed py-14 text-center text-sm text-muted-foreground">
          No screens yet. Add one, then open its link on the TV.
        </div>
      ) : (
        <div className="space-y-3">
          {screens.map((s) => (
            <div key={s.id} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{s.name}</span>
                    <Badge variant="secondary">{s.scope === 'OP_IP' ? 'OP + IP' : 'OP'}</Badge>
                    {!s.isActive && <Badge variant="outline">Paused</Badge>}
                    {/* Only worth saying when it's actionable: a paused screen is
                        offline by definition, so don't say it twice. */}
                    {s.isActive && s.online === false && <Badge variant="outline">Offline</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {s.doctorIds.length === 0
                      ? 'All doctors with OP visits today'
                      : `${s.doctorIds.length} doctor${s.doctorIds.length > 1 ? 's' : ''}: ${s.doctorIds.map(docName).join(', ')}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">Active</span>
                  <Switch
                    checked={s.isActive}
                    onCheckedChange={(v) => patchM.mutate({ id: s.id, data: { isActive: v } })}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2">
                <code className="text-xs sm:text-sm font-mono truncate flex-1">{urlFor(s)}</code>
                <Button size="sm" variant="ghost" onClick={() => copyLink(s)}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <a href={urlFor(s)} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-5 text-sm">
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Address</span>
                  <Input
                    className="w-32 h-8"
                    value={slugEdit(s)}
                    onChange={(e) => setSlugs((m) => ({ ...m, [s.id]: e.target.value }))}
                    onBlur={() => saveSlug(s)}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Hold</span>
                  <Input
                    type="number"
                    min={8}
                    max={40}
                    className="w-20 h-8"
                    value={holdEdit(s)}
                    onChange={(e) => setHolds((h) => ({ ...h, [s.id]: Number(e.target.value) }))}
                    onBlur={() => saveHold(s)}
                  />
                  <span className="text-muted-foreground">sec</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Switch checked={s.showTrackQr} onCheckedChange={(v) => patchM.mutate({ id: s.id, data: { showTrackQr: v } })} />
                  <span className="text-muted-foreground">Track-token QR</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Switch checked={s.chimeSound !== 'none'} onCheckedChange={(v) => patchM.mutate({ id: s.id, data: { chimeSound: v ? 'dingdong' : 'none' } })} />
                  <span className="text-muted-foreground">Chime</span>
                </label>
              </div>

              <div className="flex justify-end">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                      Unpair
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this screen?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently deletes “{s.name}” and its link. This can't be undone —
                        add a new screen to pair a TV again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => revokeM.mutate(s.id)}
                      >
                        Unpair
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="pt-2">
        <h3 className="text-base font-semibold">Doctors &amp; rooms</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Optional. The room shows on the display when a patient is called; leave blank to hide it.
        </p>
        <div className="rounded-lg border divide-y">
          {doctors.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No clinic doctors found.</div>
          ) : (
            doctors.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{d.name}</div>
                  {d.specialty && <div className="text-xs text-muted-foreground truncate">{d.specialty}</div>}
                </div>
                <Input
                  className="w-40"
                  placeholder="Room / Cabin"
                  value={roomValue(d)}
                  onChange={(e) => setRooms((r) => ({ ...r, [d.id]: e.target.value }))}
                  onBlur={() => saveRoom(d)}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <ManageDisplayAds />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a screen</DialogTitle>
            <DialogDescription>
              Give it a name so you can tell your TVs apart, then open its link on the screen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Screen name</Label>
              <Input
                placeholder="e.g. Ground-floor OP waiting"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Shows</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as 'OP' | 'OP_IP')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OP">OP only</SelectItem>
                  <SelectItem value="OP_IP">OP + IP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Doctors</Label>
              <p className="text-xs text-muted-foreground">
                Leave all unchecked to show every doctor with OP visits today.
              </p>
              <div className="max-h-48 overflow-y-auto rounded-md border p-2 space-y-1">
                {doctors.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-1 py-2">No clinic doctors found.</p>
                ) : (
                  doctors.map((d) => (
                    <label key={d.id} className="flex items-center gap-2 rounded px-1 py-1.5 hover:bg-muted/50 cursor-pointer">
                      <Checkbox checked={doctorIds.includes(d.id)} onCheckedChange={() => toggleDoc(d.id)} />
                      <span className="text-sm">
                        {d.name}
                        {d.specialty ? <span className="text-muted-foreground"> · {d.specialty}</span> : null}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Now-Serving hold (seconds)</Label>
                <Input type="number" min={8} max={40} value={holdSeconds} onChange={(e) => setHoldSeconds(Number(e.target.value))} />
              </div>
              <label className="flex items-center gap-2 pt-7 cursor-pointer">
                <Switch checked={showTrackQr} onCheckedChange={setShowTrackQr} />
                <span className="text-sm">Show "track your token" QR</span>
              </label>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Switch checked={chimeOn} onCheckedChange={setChimeOn} />
              <span className="text-sm">Play call chime (ding-dong)</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createM.mutate({ name: name.trim(), scope, doctorIds, holdSeconds, showTrackQr, chimeSound: chimeOn ? 'dingdong' : 'none' })}
              disabled={!name.trim() || createM.isPending}
            >
              {createM.isPending ? 'Adding…' : 'Add screen'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
