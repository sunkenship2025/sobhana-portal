/**
 * Waiting Room Display — Ad creatives (owner)
 *
 * Upload photos, videos, or a slideshow to rotate on the TV when idle. Media
 * uploads via raw multipart (react-query wrappers skip multipart); everything
 * else goes through the standard branch-scoped mutations.
 */
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useApiQuery, useApiMutation, branchRequest, qk, useBranchId,
} from '@/lib/query';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, Film, Images, Image as ImageIcon, Upload } from 'lucide-react';
import { toast } from 'sonner';

type AdMedia = { index: number; mimeType: string; path: string };
type Ad = {
  id: string;
  name: string;
  kind: 'IMAGE' | 'VIDEO' | 'SLIDESHOW' | string;
  fit: 'cover' | 'contain' | string;
  durationSec: number;
  enabled: boolean;
  weight: number;
  sortOrder: number;
  screenIds: string[];
  media: AdMedia[];
};

const KIND_LABEL: Record<string, string> = { IMAGE: 'Photo', VIDEO: 'Video', SLIDESHOW: 'Slideshow' };

export default function ManageDisplayAds() {
  const branchId = useBranchId();
  const token = useAuthStore((s) => s.token);
  const qc = useQueryClient();

  const adsQ = useApiQuery<Ad[]>({
    branchScoped: true,
    queryKey: qk.displayAds(branchId),
    queryFn: () => branchRequest<Ad[]>('/display-ads', branchId!),
  });
  const ads = useMemo(
    () => (adsQ.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [adsQ.data],
  );
  const screensQ = useApiQuery<{ id: string; name: string }[]>({
    branchScoped: true,
    queryKey: qk.displayScreens(branchId),
    queryFn: () => branchRequest<{ id: string; name: string }[]>('/display-screens', branchId!),
  });
  const screens = screensQ.data ?? [];

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'IMAGE' | 'VIDEO' | 'SLIDESHOW'>('IMAGE');
  const [fit, setFit] = useState<'cover' | 'contain'>('cover');
  const [durationSec, setDurationSec] = useState(10);
  const [weight, setWeight] = useState(1);
  const [files, setFiles] = useState<FileList | null>(null);
  const [screenIds, setScreenIds] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reset = () => {
    setEditingId(null);
    setName(''); setKind('IMAGE'); setFit('cover'); setDurationSec(10); setWeight(1); setFiles(null); setScreenIds([]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const openEdit = (ad: Ad) => {
    setEditingId(ad.id);
    setName(ad.name);
    setKind(ad.kind as any);
    setFit(ad.fit === 'contain' ? 'contain' : 'cover');
    setDurationSec(ad.durationSec);
    setWeight(ad.weight);
    setScreenIds(ad.screenIds ?? []);
    setFiles(null);
    setOpen(true);
  };

  const submit = async () => {
    if (!name.trim()) return toast.error('Name is required');
    if (editingId) {
      const data: Record<string, unknown> = { name: name.trim(), fit, weight, screenIds };
      if (kind !== 'VIDEO') data.durationSec = durationSec;
      patchM.mutate(
        { id: editingId, data },
        { onSuccess: () => { toast.success('Ad updated'); reset(); setOpen(false); } },
      );
      return;
    }
    if (!files || files.length === 0) return toast.error('Choose a file to upload');
    if (kind !== 'SLIDESHOW' && files.length !== 1) return toast.error('Choose exactly one file');
    const fd = new FormData();
    fd.append('name', name.trim());
    fd.append('kind', kind);
    fd.append('fit', fit);
    fd.append('durationSec', String(durationSec));
    fd.append('weight', String(weight));
    fd.append('screenIds', JSON.stringify(screenIds));
    Array.from(files).forEach((f) => fd.append('files', f));
    setUploading(true);
    try {
      const res = await fetch(`${API_BASE}/display-ads`, {
        method: 'POST',
        // No Content-Type — the browser sets the multipart boundary.
        headers: { Authorization: `Bearer ${token}`, 'X-Branch-Id': branchId || '' },
        body: fd,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || 'Upload failed');
      }
      toast.success('Ad added');
      qc.invalidateQueries({ queryKey: qk.displayAds(branchId) });
      reset();
      setOpen(false);
    } catch (e: any) {
      toast.error(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const patchM = useApiMutation<Ad, { id: string; data: Record<string, unknown> }>({
    mutationFn: ({ id, data }) =>
      branchRequest<Ad>(`/display-ads/${id}`, branchId!, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      }),
    invalidate: [qk.displayAds(branchId)],
    onError: (e) => toast.error(e.message || 'Failed to update ad'),
  });
  const deleteM = useApiMutation<{ ok: boolean }, string>({
    mutationFn: (id) => branchRequest(`/display-ads/${id}`, branchId!, { method: 'DELETE' }),
    invalidate: [qk.displayAds(branchId)],
    onSuccess: () => toast.success('Ad removed'),
    onError: (e) => toast.error(e.message || 'Failed to remove ad'),
  });

  const move = async (idx: number, dir: -1 | 1) => {
    const a = ads[idx];
    const b = ads[idx + dir];
    if (!a || !b) return;
    await Promise.all([
      branchRequest(`/display-ads/${a.id}`, branchId!, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sortOrder: b.sortOrder }) }),
      branchRequest(`/display-ads/${b.id}`, branchId!, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sortOrder: a.sortOrder }) }),
    ]).catch((e: any) => toast.error(e.message || 'Failed to reorder'));
    qc.invalidateQueries({ queryKey: qk.displayAds(branchId) });
  };

  const KindIcon = (k: string) => (k === 'VIDEO' ? Film : k === 'SLIDESHOW' ? Images : ImageIcon);
  const accept = kind === 'VIDEO' ? 'video/mp4,video/webm' : 'image/png,image/jpeg,image/webp';

  return (
    <div className="pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Ads</h3>
          <p className="text-sm text-muted-foreground">
            Creatives that rotate when no one is being called. Upload at 1920×1080 for the cleanest fit.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Add ad
        </Button>
      </div>

      {ads.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          No ads yet. Without ads, the display shows a plain welcome between calls.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {ads.map((ad, idx) => {
            const Icon = KindIcon(ad.kind);
            const thumb = ad.media[0];
            return (
              <div key={ad.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="h-14 w-24 shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center">
                  {thumb && ad.kind !== 'VIDEO' ? (
                    <img src={`${API_BASE}${thumb.path}`} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Icon className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{ad.name}</span>
                    <Badge variant="secondary">{KIND_LABEL[ad.kind] || ad.kind}</Badge>
                    <Badge variant="outline">{ad.fit === 'contain' ? 'Letterbox' : 'Fill'}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {ad.kind === 'VIDEO' ? 'Plays to end' : `${ad.durationSec}s${ad.kind === 'SLIDESHOW' ? '/slide' : ''}`}
                    {' · '}weight {ad.weight}
                    {ad.kind === 'SLIDESHOW' ? ` · ${ad.media.length} slides` : ''}
                    {' · '}
                    {ad.screenIds?.length ? `${ad.screenIds.length} screen${ad.screenIds.length > 1 ? 's' : ''}` : 'All screens'}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" disabled={idx === 0} onClick={() => move(idx, -1)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" disabled={idx === ads.length - 1} onClick={() => move(idx, 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <div className="flex items-center gap-1.5 px-1">
                    <Switch checked={ad.enabled} onCheckedChange={(v) => patchM.mutate({ id: ad.id, data: { enabled: v } })} />
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => openEdit(ad)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove “{ad.name}”?</AlertDialogTitle>
                        <AlertDialogDescription>This deletes the creative and its media. This can't be undone.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => deleteM.mutate(ad.id)}
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit ad' : 'Add an ad'}</DialogTitle>
            <DialogDescription>
              {editingId ? 'Update this creative’s settings. The media stays the same.' : 'Photo, video, or a slideshow of photos.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="e.g. Full Body Checkup offer" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              {!editingId && (
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={kind} onValueChange={(v) => { setKind(v as any); setFiles(null); if (fileRef.current) fileRef.current.value = ''; }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="IMAGE">Photo</SelectItem>
                      <SelectItem value="VIDEO">Video</SelectItem>
                      <SelectItem value="SLIDESHOW">Slideshow</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label>Fit</Label>
                <Select value={fit} onValueChange={(v) => setFit(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cover">Fill the frame</SelectItem>
                    <SelectItem value="contain">Letterbox</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!editingId && (
              <div className="space-y-2">
                <Label>{kind === 'SLIDESHOW' ? 'Images (pick several)' : kind === 'VIDEO' ? 'Video (MP4/WebM)' : 'Image (PNG/JPG/WebP)'}</Label>
                <div
                  className="border-2 border-dashed rounded-lg p-5 text-center cursor-pointer hover:bg-muted/40"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-5 w-5 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground mt-2">
                    {files && files.length ? `${files.length} file${files.length > 1 ? 's' : ''} selected` : 'Click to choose'}
                  </p>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept={accept}
                  multiple={kind === 'SLIDESHOW'}
                  onChange={(e) => setFiles(e.target.files)}
                />
                <p className="text-xs text-muted-foreground">Max 45 MB per file. Keep videos short.</p>
              </div>
            )}
            {kind !== 'VIDEO' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{kind === 'SLIDESHOW' ? 'Seconds per slide' : 'Seconds on screen'}</Label>
                  <Input type="number" min={3} max={60} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))} />
                </div>
                <div className="space-y-2">
                  <Label>Weight (frequency)</Label>
                  <Input type="number" min={1} max={10} value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
                </div>
              </div>
            )}
            {kind === 'VIDEO' && (
              <div className="space-y-2 w-1/2">
                <Label>Weight (frequency)</Label>
                <Input type="number" min={1} max={10} value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
              </div>
            )}
            {screens.length > 0 && (
              <div className="space-y-2">
                <Label>Show on</Label>
                <p className="text-xs text-muted-foreground">Leave all unchecked to show on every screen in this branch.</p>
                <div className="max-h-32 overflow-y-auto rounded-md border p-2 space-y-1">
                  {screens.map((sc) => (
                    <label key={sc.id} className="flex items-center gap-2 rounded px-1 py-1.5 hover:bg-muted/50 cursor-pointer">
                      <Checkbox
                        checked={screenIds.includes(sc.id)}
                        onCheckedChange={() =>
                          setScreenIds((cur) => (cur.includes(sc.id) ? cur.filter((x) => x !== sc.id) : [...cur, sc.id]))
                        }
                      />
                      <span className="text-sm">{sc.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); reset(); }}>Cancel</Button>
            <Button onClick={submit} disabled={uploading || !name.trim() || (!editingId && !files?.length)}>
              {uploading ? 'Uploading…' : editingId ? 'Save changes' : 'Add ad'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
