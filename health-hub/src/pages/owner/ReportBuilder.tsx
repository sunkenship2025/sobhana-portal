/**
 * Report Builder — author a clinical report as a document (report-first canvas),
 * with a pixel-true server-rendered Preview, compiling down to the existing
 * models (ClinicalPanel / ClinicalPanelItem / TestDefinition / BillableProduct).
 *
 * Edit mode = the report-styled editable canvas (ReportCanvas); Preview mode =
 * the real renderer (ReportPreviewFrame). Non-inline panel fields live in a
 * Settings popover; the clinical contract lives in the row Inspector.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import { Plus, Save, FilePlus2, Loader2, Package, Settings2, Pencil, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { LoadingState } from '@/components/ui/loading-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ReportPreviewFrame, type PreviewPayload } from '@/components/reportbuilder/ReportPreviewFrame';
import { ItemInspector, type InspectorItem, type CanonicalPatch } from '@/components/reportbuilder/ItemInspector';
import { ReportCanvas } from '@/components/reportbuilder/ReportCanvas';
import {
  CODE_REGEX, LAYOUTS, type Department, type TestDef, type BuilderItem, type PanelForm,
  blankPanel, uid, itemFromDef,
} from './reportBuilderShared';

export default function ReportBuilder() {
  const { token } = useAuthStore();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [loading, setLoading] = useState(true);
  const [panelsList, setPanelsList] = useState<{ id: string; code: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [defs, setDefs] = useState<TestDef[]>([]);

  const [panel, setPanel] = useState<PanelForm>(blankPanel());
  const [items, setItemsRaw] = useState<BuilderItem[]>([]);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [profile, setProfile] = useState<'digital' | 'letterhead'>('digital');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [inspectUid, setInspectUid] = useState<string | null>(null);
  const [pubOpen, setPubOpen] = useState(false);

  const setItems = useCallback((updater: (xs: BuilderItem[]) => BuilderItem[]) => { setItemsRaw(updater); setDirty(true); }, []);
  const setP = <K extends keyof PanelForm>(patch: Partial<PanelForm>) => { setPanel((p) => ({ ...p, ...patch })); setDirty(true); };
  const patchItem = (uid_: string, patch: Partial<BuilderItem>) => setItems((xs) => xs.map((x) => (x._uid === uid_ ? { ...x, ...patch } : x)));
  const onCanonicalSaved = (p: CanonicalPatch) => { if (inspectUid) patchItem(inspectUid, { ...p }); };

  const loadAll = useCallback(async () => {
    try {
      const [pRes, dRes, defRes] = await Promise.all([
        fetch(`${API_BASE}/clinical-panels?active=all`, { headers }),
        fetch(`${API_BASE}/departments`, { headers }),
        fetch(`${API_BASE}/clinical-definitions?status=ACTIVE`, { headers }),
      ]);
      if (pRes.ok) { const rows = await pRes.json(); setPanelsList(rows.map((r: any) => ({ id: r.id, code: r.code, name: r.name }))); }
      if (dRes.ok) setDepartments(await dRes.json());
      if (defRes.ok) setDefs(await defRes.json());
    } catch { toast.error('Failed to load builder data'); } finally { setLoading(false); }
  }, [headers]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const openPanel = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${id}`, { headers });
      if (!res.ok) throw new Error();
      const p = await res.json();
      setPanel({
        id: p.id, code: p.code, label: p.name, departmentId: p.departmentId ?? '',
        layoutType: p.layoutType ?? 'STANDARD_TABLE', sampleType: p.sampleType ?? null,
        panelMethodText: p.panelMethodText ?? null, showSubgroups: !!p.showSubgroups,
        showInterpretation: !!p.showInterpretation, spacedDefinitionsGap: p.spacedDefinitionsGap ?? 0,
        valueDisplayPrefix: p.valueDisplayPrefix ?? null, comments: p.comments ?? null, interpretation: p.interpretation ?? null,
      });
      const defById = new Map(defs.map((d) => [d.id, d]));
      setItemsRaw((p.items ?? []).map((it: any) => {
        const d = defById.get(it.testDefinitionId);
        return {
          _uid: uid(), testDefinitionId: it.testDefinitionId,
          code: it.testDefinition?.code ?? d?.code ?? '', name: it.testDefinition?.name ?? d?.name ?? '',
          referenceUnit: d?.referenceUnit ?? null, referenceMin: d?.referenceMin ?? null, referenceMax: d?.referenceMax ?? null,
          referenceText: d?.referenceText ?? null, criticalMin: d?.criticalMin ?? null, criticalMax: d?.criticalMax ?? null,
          method: d?.method ?? null, sampleType: d?.sampleType ?? null,
          displayLabel: it.displayLabel ?? null, subGroup: it.subGroup ?? null, indentLevel: it.indentLevel ?? 0,
          isBold: !!it.isBold, isItalic: !!it.isItalic, methodText: it.methodText ?? null, showMethod: !!it.showMethod,
          joinPrevious: !!it.joinPrevious, gridWidth: it.gridWidth ?? null, mockValue: null, mockTextValue: null,
        };
      }));
      setDirty(false);
    } catch { toast.error('Failed to open panel'); }
  };
  const newBlank = () => { setPanel(blankPanel()); setItemsRaw([]); setDirty(false); };

  const departmentName = departments.find((d) => d.id === panel.departmentId)?.name ?? '';
  const liveItems = items.filter((i) => i.code); // committed rows only (skip blank inline drafts)

  const previewPayload: PreviewPayload = useMemo(() => ({
    panel: {
      code: panel.code || 'PREVIEW', label: panel.label || 'Untitled report',
      departmentId: panel.departmentId || undefined, departmentName,
      layoutType: panel.layoutType, sampleType: panel.sampleType, panelMethodText: panel.panelMethodText,
      showSubgroups: panel.showSubgroups, showInterpretation: panel.showInterpretation,
      spacedDefinitionsGap: panel.spacedDefinitionsGap, valueDisplayPrefix: panel.valueDisplayPrefix,
      comments: panel.comments, interpretation: panel.interpretation,
    },
    items: liveItems.map((it, idx) => ({
      testDefinition: {
        code: it.code, name: it.name, method: it.method, sampleType: it.sampleType,
        referenceMin: it.referenceMin, referenceMax: it.referenceMax, referenceUnit: it.referenceUnit,
        referenceText: it.referenceText, criticalMin: it.criticalMin, criticalMax: it.criticalMax,
      },
      displayOrder: idx, showMethod: it.showMethod, methodText: it.methodText, indentLevel: it.indentLevel,
      isBold: it.isBold, isItalic: it.isItalic, subGroup: it.subGroup, joinPrevious: it.joinPrevious,
      gridWidth: it.gridWidth, displayLabel: it.displayLabel, mockValue: it.mockValue, mockTextValue: it.mockTextValue,
    })),
    patient: { name: 'Sample Patient', gender: 'F', yearOfBirth: new Date().getFullYear() - 34 },
  }), [panel, liveItems, departmentName]);

  const canSave = panel.label.trim() && CODE_REGEX.test(panel.code.trim().toUpperCase()) && panel.departmentId && liveItems.length > 0;

  const save = async () => {
    if (!canSave) { toast.error('Name, a valid code, a department and at least one test are required'); return; }
    setSaving(true);
    try {
      const body = {
        name: panel.code.trim().toUpperCase(), displayName: panel.label.trim(), departmentId: panel.departmentId,
        layoutType: panel.layoutType, sampleType: panel.sampleType, showSubgroups: panel.showSubgroups,
        showInterpretation: panel.showInterpretation, spacedDefinitionsGap: panel.spacedDefinitionsGap,
        valueDisplayPrefix: panel.valueDisplayPrefix, panelMethodText: panel.panelMethodText,
        comments: panel.comments, interpretation: panel.interpretation,
        items: liveItems.map((it, idx) => ({
          testDefinitionId: it.testDefinitionId, displayOrder: idx, showMethod: it.showMethod, methodText: it.methodText,
          indentLevel: it.indentLevel, isBold: it.isBold, isItalic: it.isItalic, subGroup: it.subGroup,
          joinPrevious: it.joinPrevious, gridWidth: it.gridWidth, displayLabel: it.displayLabel,
        })),
      };
      const url = panel.id ? `${API_BASE}/clinical-panels/${panel.id}` : `${API_BASE}/clinical-panels`;
      const res = await fetch(url, { method: panel.id ? 'PUT' : 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `Save failed (${res.status})`); }
      const saved = await res.json();
      toast.success(panel.id ? 'Report updated' : 'Report created');
      setPanel((p) => ({ ...p, id: saved.id, code: saved.code }));
      setDirty(false);
      await loadAll();
    } catch (e) { toast.error((e as Error).message || 'Save failed'); } finally { setSaving(false); }
  };

  if (loading) return <LoadingState />;

  const inspected = items.find((i) => i._uid === inspectUid) || null;
  const inspectItem: InspectorItem | null = inspected ? {
    testDefinitionId: inspected.testDefinitionId, code: inspected.code, name: inspected.name,
    displayLabel: inspected.displayLabel, subGroup: inspected.subGroup, indentLevel: inspected.indentLevel,
    isBold: inspected.isBold, isItalic: inspected.isItalic, methodText: inspected.methodText,
  } : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <Select value={panel.id ?? '__new__'} onValueChange={(v) => (v === '__new__' ? newBlank() : openPanel(v))}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Open a report…" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__new__"><span className="flex items-center gap-2"><FilePlus2 className="h-3.5 w-3.5" /> New blank report</span></SelectItem>
            {panelsList.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name} <span className="text-muted-foreground">· {p.code}</span></SelectItem>))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={newBlank}><Plus className="h-4 w-4 mr-1" /> New</Button>

        <Select value={panel.layoutType} onValueChange={(v) => setP({ layoutType: v })}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>{LAYOUTS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
        </Select>

        <PanelSettings panel={panel} departments={departments} setP={setP} />

        <div className="flex-1" />

        <div className="inline-flex rounded-md border p-0.5">
          <Button variant={mode === 'edit' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('edit')}><Pencil className="h-3.5 w-3.5 mr-1" /> Edit</Button>
          <Button variant={mode === 'preview' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('preview')}><Eye className="h-3.5 w-3.5 mr-1" /> Preview</Button>
        </div>
        <div className="inline-flex rounded-md border p-0.5">
          <Button variant={profile === 'digital' ? 'secondary' : 'ghost'} size="sm" onClick={() => setProfile('digital')}>Digital</Button>
          <Button variant={profile === 'letterhead' ? 'secondary' : 'ghost'} size="sm" onClick={() => setProfile('letterhead')}>Letterhead</Button>
        </div>
        {panel.id && (
          <Button size="sm" variant="outline" onClick={() => setPubOpen(true)} disabled={dirty} title={dirty ? 'Save first' : 'Create a billable product'}>
            <Package className="h-4 w-4 mr-1" /> Publish
          </Button>
        )}
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          {panel.id ? 'Save' : 'Create'}
        </Button>
      </div>

      {/* Main surface: edit canvas OR true preview */}
      {mode === 'edit' ? (
        <ReportCanvas
          panel={panel} items={items} defs={defs} profile={profile} departmentName={departmentName}
          headers={headers} selectedUid={inspectUid}
          setPanel={setP} setItems={setItems} onInspect={setInspectUid}
          onCreatedDef={(d) => setDefs((xs) => [d, ...xs])}
        />
      ) : (
        <div className="h-[80vh]"><ReportPreviewFrame payload={previewPayload} profile={profile} /></div>
      )}

      <ItemInspector
        item={inspectItem} open={!!inspectUid} onOpenChange={(v) => { if (!v) setInspectUid(null); }}
        headers={headers} showSubgroup={panel.showSubgroups}
        onPatch={(p) => { if (inspectUid) patchItem(inspectUid, p); }} onCanonicalSaved={onCanonicalSaved}
      />

      {panel.id && (
        <PublishProductDialog open={pubOpen} onOpenChange={setPubOpen} panelId={panel.id} defaultName={panel.label} defaultCode={panel.code} headers={headers} />
      )}
    </div>
  );
}

/* ───────── Panel settings (non-inline fields) ───────── */
function PanelSettings({ panel, departments, setP }: {
  panel: PanelForm; departments: Department[]; setP: (patch: Partial<PanelForm>) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="sm"><Settings2 className="h-4 w-4 mr-1" /> Settings</Button></PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="start">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label className="text-xs">Code</Label><Input value={panel.code} onChange={(e) => setP({ code: e.target.value.toUpperCase() })} disabled={!!panel.id} className="font-mono h-8" placeholder="CBP" /></div>
          <div className="space-y-1.5"><Label className="text-xs">Department</Label>
            <Select value={panel.departmentId || undefined} onValueChange={(v) => setP({ departmentId: v })}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {panel.layoutType === 'STANDARD_TABLE' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label className="text-xs">Value prefix</Label><Input value={panel.valueDisplayPrefix ?? ''} maxLength={5} onChange={(e) => setP({ valueDisplayPrefix: e.target.value || null })} className="h-8" placeholder='"1:"' /></div>
            <div className="space-y-1.5"><Label className="text-xs">Spaced gap</Label>
              <Select value={String(panel.spacedDefinitionsGap)} onValueChange={(v) => setP({ spacedDefinitionsGap: Number(v) })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>{[0, 1, 2, 3].map((g) => <SelectItem key={g} value={String(g)}>{['None', 'Small', 'Medium', 'Large'][g]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between"><Label className="text-xs cursor-pointer" htmlFor="rb-sg">Show subgroups</Label><Switch id="rb-sg" checked={panel.showSubgroups} onCheckedChange={(v) => setP({ showSubgroups: v })} /></div>
        <div className="flex items-center justify-between"><Label className="text-xs cursor-pointer" htmlFor="rb-cn">Clinical Notes box</Label><Switch id="rb-cn" checked={panel.showInterpretation} onCheckedChange={(v) => setP({ showInterpretation: v })} /></div>
      </PopoverContent>
    </Popover>
  );
}

/* ───────── Publish as product ───────── */
function PublishProductDialog({ open, onOpenChange, panelId, defaultName, defaultCode, headers }: {
  open: boolean; onOpenChange: (v: boolean) => void; panelId: string;
  defaultName: string; defaultCode: string; headers: Record<string, string>;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [price, setPrice] = useState('');
  const [workflow, setWorkflow] = useState('REPORTABLE');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(defaultName); setCode(defaultCode); setPrice(''); setWorkflow('REPORTABLE'); setCategory(''); } }, [open, defaultName, defaultCode]);
  const create = async () => {
    if (!name.trim() || !CODE_REGEX.test(code.trim().toUpperCase()) || price === '') { toast.error('Name, a valid code and a price are required'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/billable-products`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: name.trim(), code: code.trim().toUpperCase(), basePrice: Number(price), workflowMode: workflow, payoutCategory: category || null, panels: [{ panelId }] }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `Publish failed (${res.status})`); }
      const p = await res.json();
      toast.success(`Published product ${p.code}`);
      onOpenChange(false);
    } catch (e) { toast.error((e as Error).message || 'Publish failed'); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Publish as product</DialogTitle><DialogDescription>Creates a billable product for this report. Bundles &amp; per-branch pricing live in the Billable Products tab.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label>Product name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Price (₹)</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="450" /></div>
          <div className="space-y-1.5"><Label>Workflow</Label>
            <Select value={workflow} onValueChange={setWorkflow}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="REPORTABLE">Reportable</SelectItem><SelectItem value="BILL_ONLY">Bill only</SelectItem><SelectItem value="EXTERNAL_UPLOAD">External upload</SelectItem><SelectItem value="EVENT">Event</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Payout category</Label><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Laboratory" /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={create} disabled={busy}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Publish</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
