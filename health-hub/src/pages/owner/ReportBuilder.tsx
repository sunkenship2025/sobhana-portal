/**
 * Report Builder — author a clinical report as a document, with a live preview
 * rendered by the REAL server renderer (pixel-identical to the finalized report).
 *
 * It compiles down to the existing models:
 *   canvas → ClinicalPanel + ClinicalPanelItem  (presentation / layout)
 *   tests  → TestDefinition                      (canonical clinical contract)
 *
 * Phase 2 scope: load any existing panel and edit it, build new panels, add
 * existing tests or create new ones inline, per-item presentation fields, and a
 * byte-accurate digital/letterhead preview. Full range/formula/versioning +
 * products + the authoring-bug fixes land in the following phases.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import {
  Plus, Search, Trash2, ArrowUp, ArrowDown, Save, FilePlus2, Loader2, Sparkles, Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { LoadingState } from '@/components/ui/loading-state';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { ReportPreviewFrame, type PreviewPayload } from '@/components/reportbuilder/ReportPreviewFrame';
import { ItemInspector, type InspectorItem, type CanonicalPatch } from '@/components/reportbuilder/ItemInspector';

const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

const LAYOUTS = [
  { value: 'STANDARD_TABLE', label: 'Standard Table' },
  { value: 'PROCEDURE_STRUCTURED', label: 'Procedure' },
  { value: 'IMAGING_NARRATIVE', label: 'Imaging Narrative' },
  { value: 'TEXT_ONLY', label: 'Text only' },
];

interface Department { id: string; name: string }

interface TestDef {
  id: string; rootDefinitionId?: string; code: string; name: string;
  referenceUnit: string | null; referenceMin: number | null; referenceMax: number | null;
  referenceText: string | null; criticalMin: number | null; criticalMax: number | null;
  method: string | null; sampleType: string | null;
}

interface BuilderItem {
  _uid: string;
  testDefinitionId: string;
  code: string; name: string;
  referenceUnit: string | null; referenceMin: number | null; referenceMax: number | null;
  referenceText: string | null; criticalMin: number | null; criticalMax: number | null;
  method: string | null; sampleType: string | null;
  // ClinicalPanelItem (presentation)
  displayLabel: string | null;
  subGroup: string | null;
  indentLevel: number;
  isBold: boolean; isItalic: boolean;
  methodText: string | null; showMethod: boolean;
  joinPrevious: boolean; gridWidth: number | null;
  // preview mock
  mockValue: number | null; mockTextValue: string | null;
}

interface PanelForm {
  id: string | null;
  code: string; label: string;
  departmentId: string;
  layoutType: string;
  sampleType: string | null;
  panelMethodText: string | null;
  showSubgroups: boolean;
  showInterpretation: boolean;
  spacedDefinitionsGap: number;
  valueDisplayPrefix: string | null;
  comments: string | null;
  interpretation: string | null;
}

const blankPanel = (): PanelForm => ({
  id: null, code: '', label: '', departmentId: '', layoutType: 'STANDARD_TABLE',
  sampleType: null, panelMethodText: null, showSubgroups: false, showInterpretation: false,
  spacedDefinitionsGap: 0, valueDisplayPrefix: null, comments: null, interpretation: null,
});

const uid = () => Math.random().toString(36).slice(2, 10);

const itemFromDef = (d: TestDef): BuilderItem => ({
  _uid: uid(),
  testDefinitionId: d.id,
  code: d.code, name: d.name,
  referenceUnit: d.referenceUnit ?? null, referenceMin: d.referenceMin ?? null, referenceMax: d.referenceMax ?? null,
  referenceText: d.referenceText ?? null, criticalMin: d.criticalMin ?? null, criticalMax: d.criticalMax ?? null,
  method: d.method ?? null, sampleType: d.sampleType ?? null,
  displayLabel: null, subGroup: null, indentLevel: 0, isBold: false, isItalic: false,
  methodText: null, showMethod: false, joinPrevious: false, gridWidth: null,
  mockValue: null, mockTextValue: null,
});

export default function ReportBuilder() {
  const { token } = useAuthStore();
  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token],
  );

  const [loading, setLoading] = useState(true);
  const [panelsList, setPanelsList] = useState<{ id: string; code: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [defs, setDefs] = useState<TestDef[]>([]);

  const [panel, setPanel] = useState<PanelForm>(blankPanel());
  const [items, setItems] = useState<BuilderItem[]>([]);
  const [profile, setProfile] = useState<'digital' | 'letterhead'>('digital');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [inspectUid, setInspectUid] = useState<string | null>(null);
  const [pubOpen, setPubOpen] = useState(false);

  const setP = <K extends keyof PanelForm>(k: K, v: PanelForm[K]) => { setPanel((p) => ({ ...p, [k]: v })); setDirty(true); };
  const patchItem = (uid_: string, patch: Partial<BuilderItem>) => {
    setItems((xs) => xs.map((x) => (x._uid === uid_ ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  // A versioned clinical-contract save re-points the item to the NEW version id
  // and refreshes the reference fields the preview reads.
  const onCanonicalSaved = (patch: CanonicalPatch) => {
    if (!inspectUid) return;
    patchItem(inspectUid, {
      testDefinitionId: patch.testDefinitionId,
      referenceUnit: patch.referenceUnit, referenceMin: patch.referenceMin, referenceMax: patch.referenceMax,
      referenceText: patch.referenceText, criticalMin: patch.criticalMin, criticalMax: patch.criticalMax,
      method: patch.method,
    });
  };

  // ─── Data loads ────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    try {
      const [pRes, dRes, defRes] = await Promise.all([
        fetch(`${API_BASE}/clinical-panels?active=all`, { headers }),
        fetch(`${API_BASE}/departments`, { headers }),
        fetch(`${API_BASE}/clinical-definitions?status=ACTIVE`, { headers }),
      ]);
      if (pRes.ok) {
        const rows = await pRes.json();
        setPanelsList(rows.map((r: any) => ({ id: r.id, code: r.code, name: r.name })));
      }
      if (dRes.ok) setDepartments(await dRes.json());
      if (defRes.ok) setDefs(await defRes.json());
    } catch {
      toast.error('Failed to load builder data');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── Load an existing panel into the canvas ─────────────────────────────
  const openPanel = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${id}`, { headers });
      if (!res.ok) throw new Error();
      const p = await res.json();
      setPanel({
        id: p.id,
        code: p.code,            // transformPanel already flips name↔code for us
        label: p.name,
        departmentId: p.departmentId ?? '',
        layoutType: p.layoutType ?? 'STANDARD_TABLE',
        sampleType: p.sampleType ?? null,
        panelMethodText: p.panelMethodText ?? null,
        showSubgroups: !!p.showSubgroups,
        showInterpretation: !!p.showInterpretation,
        spacedDefinitionsGap: p.spacedDefinitionsGap ?? 0,
        valueDisplayPrefix: p.valueDisplayPrefix ?? null,
        comments: p.comments ?? null,
        interpretation: p.interpretation ?? null,
      });
      const defById = new Map(defs.map((d) => [d.id, d]));
      const rows: BuilderItem[] = (p.items ?? []).map((it: any) => {
        const d = defById.get(it.testDefinitionId);
        return {
          _uid: uid(),
          testDefinitionId: it.testDefinitionId,
          code: it.testDefinition?.code ?? d?.code ?? '',
          name: it.testDefinition?.name ?? d?.name ?? '',
          referenceUnit: d?.referenceUnit ?? null,
          referenceMin: d?.referenceMin ?? null, referenceMax: d?.referenceMax ?? null,
          referenceText: d?.referenceText ?? null,
          criticalMin: d?.criticalMin ?? null, criticalMax: d?.criticalMax ?? null,
          method: d?.method ?? null, sampleType: d?.sampleType ?? null,
          displayLabel: it.displayLabel ?? null,
          subGroup: it.subGroup ?? null,
          indentLevel: it.indentLevel ?? 0,
          isBold: !!it.isBold, isItalic: !!it.isItalic,
          methodText: it.methodText ?? null, showMethod: !!it.showMethod,
          joinPrevious: !!it.joinPrevious, gridWidth: it.gridWidth ?? null,
          mockValue: null, mockTextValue: null,
        };
      });
      setItems(rows);
      setDirty(false);
    } catch {
      toast.error('Failed to open panel');
    }
  };

  const newBlank = () => { setPanel(blankPanel()); setItems([]); setDirty(false); };

  // ─── Item ops ───────────────────────────────────────────────────────────
  const addDef = (d: TestDef) => {
    if (items.some((i) => i.testDefinitionId === d.id)) { toast.info('Already in this report'); return; }
    setItems((xs) => [...xs, itemFromDef(d)]);
    setDirty(true);
  };
  const removeItem = (u: string) => { setItems((xs) => xs.filter((x) => x._uid !== u)); setDirty(true); };
  const moveItem = (u: string, dir: -1 | 1) => {
    setItems((xs) => {
      const i = xs.findIndex((x) => x._uid === u);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setDirty(true);
  };

  // ─── Live preview payload ───────────────────────────────────────────────
  const previewPayload: PreviewPayload = useMemo(() => ({
    panel: {
      code: panel.code || 'PREVIEW',
      label: panel.label || 'Untitled report',
      departmentId: panel.departmentId || undefined,
      departmentName: departments.find((d) => d.id === panel.departmentId)?.name,
      layoutType: panel.layoutType,
      sampleType: panel.sampleType,
      panelMethodText: panel.panelMethodText,
      showSubgroups: panel.showSubgroups,
      showInterpretation: panel.showInterpretation,
      spacedDefinitionsGap: panel.spacedDefinitionsGap,
      valueDisplayPrefix: panel.valueDisplayPrefix,
      comments: panel.comments,
      interpretation: panel.interpretation,
    },
    items: items.map((it, idx) => ({
      testDefinition: {
        code: it.code, name: it.name, method: it.method, sampleType: it.sampleType,
        referenceMin: it.referenceMin, referenceMax: it.referenceMax, referenceUnit: it.referenceUnit,
        referenceText: it.referenceText, criticalMin: it.criticalMin, criticalMax: it.criticalMax,
      },
      displayOrder: idx, showMethod: it.showMethod, methodText: it.methodText,
      indentLevel: it.indentLevel, isBold: it.isBold, isItalic: it.isItalic,
      subGroup: it.subGroup, joinPrevious: it.joinPrevious, gridWidth: it.gridWidth,
      displayLabel: it.displayLabel,
      mockValue: it.mockValue, mockTextValue: it.mockTextValue,
    })),
    patient: { name: 'Sample Patient', gender: 'F', yearOfBirth: new Date().getFullYear() - 34 },
  }), [panel, items, departments]);

  // ─── Save ───────────────────────────────────────────────────────────────
  const canSave = panel.label.trim() && CODE_REGEX.test(panel.code.trim().toUpperCase()) && panel.departmentId && items.length > 0;

  const save = async () => {
    if (!canSave) { toast.error('Name, a valid code, a department and at least one test are required'); return; }
    setSaving(true);
    try {
      const body = {
        name: panel.code.trim().toUpperCase(),   // cross-wire: DB.name = code
        displayName: panel.label.trim(),          // cross-wire: DB.displayName = label
        departmentId: panel.departmentId,
        layoutType: panel.layoutType,
        sampleType: panel.sampleType,
        showSubgroups: panel.showSubgroups,
        showInterpretation: panel.showInterpretation,
        spacedDefinitionsGap: panel.spacedDefinitionsGap,
        valueDisplayPrefix: panel.valueDisplayPrefix,
        panelMethodText: panel.panelMethodText,
        comments: panel.comments,
        interpretation: panel.interpretation,
        items: items.map((it, idx) => ({
          testDefinitionId: it.testDefinitionId,
          displayOrder: idx,
          showMethod: it.showMethod,
          methodText: it.methodText,
          indentLevel: it.indentLevel,
          isBold: it.isBold,
          isItalic: it.isItalic,
          subGroup: it.subGroup,
          joinPrevious: it.joinPrevious,
          gridWidth: it.gridWidth,
          displayLabel: it.displayLabel,
        })),
      };
      const url = panel.id ? `${API_BASE}/clinical-panels/${panel.id}` : `${API_BASE}/clinical-panels`;
      const res = await fetch(url, { method: panel.id ? 'PUT' : 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || `Save failed (${res.status})`);
      }
      const saved = await res.json();
      toast.success(panel.id ? 'Report updated' : 'Report created');
      setPanel((p) => ({ ...p, id: saved.id, code: saved.code }));
      setDirty(false);
      await loadAll();
    } catch (e) {
      toast.error((e as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
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
          <SelectTrigger className="w-[240px]"><SelectValue placeholder="Open a report…" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__new__"><span className="flex items-center gap-2"><FilePlus2 className="h-3.5 w-3.5" /> New blank report</span></SelectItem>
            {panelsList.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name} <span className="text-muted-foreground">· {p.code}</span></SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={newBlank}><Plus className="h-4 w-4 mr-1" /> New</Button>
        <div className="flex-1" />
        <div className="inline-flex rounded-md border p-0.5">
          <Button variant={profile === 'digital' ? 'secondary' : 'ghost'} size="sm" onClick={() => setProfile('digital')}>Digital</Button>
          <Button variant={profile === 'letterhead' ? 'secondary' : 'ghost'} size="sm" onClick={() => setProfile('letterhead')}>Letterhead</Button>
        </div>
        {panel.id && (
          <Button size="sm" variant="outline" onClick={() => setPubOpen(true)} disabled={dirty} title={dirty ? 'Save the report first' : 'Create a billable product for this report'}>
            <Package className="h-4 w-4 mr-1" /> Publish as product
          </Button>
        )}
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          {panel.id ? 'Save' : 'Create'}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Left: authoring ── */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label>Report name</Label>
                <Input value={panel.label} onChange={(e) => setP('label', e.target.value)} placeholder="e.g. Complete Blood Count" />
              </div>
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input value={panel.code} onChange={(e) => setP('code', e.target.value.toUpperCase())} placeholder="CBP" disabled={!!panel.id} className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label>Department</Label>
                <Select value={panel.departmentId} onValueChange={(v) => setP('departmentId', v)}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Layout</Label>
                <Select value={panel.layoutType} onValueChange={(v) => setP('layoutType', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{LAYOUTS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Panel method</Label>
                <Input value={panel.panelMethodText ?? ''} onChange={(e) => setP('panelMethodText', e.target.value || null)} placeholder="e.g. Automated cell counter" />
              </div>
            </div>
            {panel.layoutType === 'STANDARD_TABLE' && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="space-y-1.5">
                  <Label>Value prefix</Label>
                  <Input value={panel.valueDisplayPrefix ?? ''} maxLength={5} onChange={(e) => setP('valueDisplayPrefix', e.target.value || null)} placeholder='e.g. "1:"' />
                </div>
                <div className="space-y-1.5">
                  <Label>Spaced gap</Label>
                  <Select value={String(panel.spacedDefinitionsGap)} onValueChange={(v) => setP('spacedDefinitionsGap', Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{[0, 1, 2, 3].map((g) => <SelectItem key={g} value={String(g)}>{['None', 'Small', 'Medium', 'Large'][g]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 flex items-center justify-between">
                  <Label className="cursor-pointer" htmlFor="rb-subgroups">Show subgroups</Label>
                  <Switch id="rb-subgroups" checked={panel.showSubgroups} onCheckedChange={(v) => setP('showSubgroups', v)} />
                </div>
                <div className="col-span-2 flex items-center justify-between">
                  <Label className="cursor-pointer" htmlFor="rb-notes">Clinical Notes box</Label>
                  <Switch id="rb-notes" checked={panel.showInterpretation} onCheckedChange={(v) => setP('showInterpretation', v)} />
                </div>
              </div>
            )}
          </div>

          {/* Tests */}
          <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Tests <span className="text-muted-foreground font-normal">({items.length})</span></h3>
              <AddTestControl defs={defs} used={new Set(items.map((i) => i.testDefinitionId))} onAdd={addDef} headers={headers} departments={departments} onCreated={(d) => { setDefs((xs) => [d, ...xs]); addDef(d); }} />
            </div>
            {items.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">No tests yet. Add one to start the report.</p>}
            <div className="space-y-2">
              {items.map((it, idx) => (
                <ItemRow
                  key={it._uid}
                  item={it}
                  first={idx === 0} last={idx === items.length - 1}
                  onInspect={() => setInspectUid(it._uid)}
                  onMock={(v) => patchItem(it._uid, { mockValue: v })}
                  onRemove={() => removeItem(it._uid)}
                  onUp={() => moveItem(it._uid, -1)}
                  onDown={() => moveItem(it._uid, 1)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: live preview ── */}
        <div className="lg:sticky lg:top-4 h-[78vh]">
          <ReportPreviewFrame payload={previewPayload} profile={profile} />
        </div>
      </div>

      <ItemInspector
        item={inspectItem}
        open={!!inspectUid}
        onOpenChange={(v) => { if (!v) setInspectUid(null); }}
        headers={headers}
        showSubgroup={panel.showSubgroups}
        onPatch={(patch) => { if (inspectUid) patchItem(inspectUid, patch); }}
        onCanonicalSaved={onCanonicalSaved}
      />

      {panel.id && (
        <PublishProductDialog open={pubOpen} onOpenChange={setPubOpen} panelId={panel.id} defaultName={panel.label} defaultCode={panel.code} headers={headers} />
      )}
    </div>
  );
}

/* ───────── Publish as product (thin 1-panel = 1-product rail) ───────── */
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
        body: JSON.stringify({
          name: name.trim(), code: code.trim().toUpperCase(),
          basePrice: Number(price),               // rupees; backend converts to paise
          workflowMode: workflow, payoutCategory: category || null,
          panels: [{ panelId }],
        }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `Publish failed (${res.status})`); }
      const p = await res.json();
      toast.success(`Published product ${p.code}`);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || 'Publish failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish as product</DialogTitle>
          <DialogDescription>Creates a billable product for this report. Bundles, packages &amp; per-branch pricing live in the Billable Products tab.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label>Product name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Price (₹)</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="450" /></div>
          <div className="space-y-1.5">
            <Label>Workflow</Label>
            <Select value={workflow} onValueChange={setWorkflow}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="REPORTABLE">Reportable</SelectItem>
                <SelectItem value="BILL_ONLY">Bill only</SelectItem>
                <SelectItem value="EXTERNAL_UPLOAD">External upload</SelectItem>
                <SelectItem value="EVENT">Event</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Payout category</Label><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Laboratory" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={busy}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────── Item row ───────── */
function ItemRow({ item, first, last, onInspect, onMock, onRemove, onUp, onDown }: {
  item: BuilderItem; first: boolean; last: boolean;
  onInspect: () => void; onMock: (v: number | null) => void; onRemove: () => void; onUp: () => void; onDown: () => void;
}) {
  const refText = item.referenceText
    ? item.referenceText
    : item.referenceMin != null && item.referenceMax != null
      ? `${item.referenceMin} – ${item.referenceMax}`
      : '—';
  return (
    <div className="rounded-md border p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={onUp} disabled={first}><ArrowUp className="h-3 w-3" /></button>
          <button className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={onDown} disabled={last}><ArrowDown className="h-3 w-3" /></button>
        </div>
        <button className="flex-1 min-w-0 text-left" onClick={onInspect}>
          <div className="text-sm font-medium truncate">{item.displayLabel || item.name} <span className="text-xs text-muted-foreground font-mono">{item.code}</span></div>
          <div className="text-xs text-muted-foreground">{item.referenceUnit || '—'} · ref {refText}{item.subGroup ? ` · ${item.subGroup}` : ''}</div>
        </button>
        <Input className="w-24 h-8" placeholder="value" value={item.mockValue ?? ''} onChange={(e) => onMock(e.target.value === '' ? null : Number(e.target.value))} title="Sample value for the preview" />
        <Button variant="ghost" size="sm" className="h-8" onClick={onInspect}>Edit</Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={onRemove}><Trash2 className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

/* ───────── Add / create test ───────── */
function AddTestControl({ defs, used, onAdd, onCreated, headers, departments }: {
  defs: TestDef[]; used: Set<string>; onAdd: (d: TestDef) => void; onCreated: (d: TestDef) => void;
  headers: Record<string, string>; departments: Department[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = defs.filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()) || d.code.toLowerCase().includes(q.toLowerCase())).slice(0, 40);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add test</Button></PopoverTrigger>
        <PopoverContent className="w-80 p-2" align="end">
          <div className="flex items-center gap-2 border rounded-md px-2 mb-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests…" className="border-0 focus-visible:ring-0 px-0" />
          </div>
          <div className="max-h-72 overflow-auto space-y-0.5">
            {filtered.map((d) => (
              <button key={d.id} disabled={used.has(d.id)}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-accent disabled:opacity-40 flex items-center justify-between"
                onClick={() => { onAdd(d); setOpen(false); setQ(''); }}>
                <span className="text-sm">{d.name} <span className="text-xs text-muted-foreground font-mono">{d.code}</span></span>
                {used.has(d.id) && <span className="text-[11px] text-muted-foreground">added</span>}
              </button>
            ))}
            {filtered.length === 0 && <p className="text-sm text-muted-foreground py-3 text-center">No matches.</p>}
          </div>
          <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => { setOpen(false); setCreateOpen(true); }}>
            <Sparkles className="h-4 w-4 mr-1" /> Create a new test
          </Button>
        </PopoverContent>
      </Popover>
      <CreateTestDialog open={createOpen} onOpenChange={setCreateOpen} headers={headers} departments={departments} onCreated={onCreated} />
    </>
  );
}

function CreateTestDialog({ open, onOpenChange, headers, departments, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; headers: Record<string, string>;
  departments: Department[]; onCreated: (d: TestDef) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [unit, setUnit] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setName(''); setCode(''); setUnit(''); setDepartmentId(''); setMin(''); setMax(''); } }, [open]);

  const create = async () => {
    if (!name.trim() || !CODE_REGEX.test(code.trim().toUpperCase())) { toast.error('Name and a valid code are required'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/clinical-definitions`, {
        method: 'POST', headers,
        body: JSON.stringify({
          name: name.trim(), code: code.trim().toUpperCase(),
          referenceUnit: unit.trim() || null,
          departmentId: departmentId || null,
          referenceMin: min === '' ? null : Number(min),
          referenceMax: max === '' ? null : Number(max),
          interpretationMode: 'NONE',
          ranges: [], interpretationRules: [],
        }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Create failed'); }
      const d = await res.json();
      toast.success(`Created ${d.code} (v1)`);
      onCreated(d);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New test</DialogTitle>
          <DialogDescription>Creates a v1 Clinical Definition and adds it to the report. Ranges &amp; formula can be enriched later in Clinical Definitions.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => { setName(e.target.value); if (!code) setCode(e.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12)); }} /></div>
          <div className="space-y-1.5"><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Unit</Label><Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="g/dL" /></div>
          <div className="col-span-2 space-y-1.5">
            <Label>Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Ref. min</Label><Input value={min} onChange={(e) => setMin(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Ref. max</Label><Input value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={busy}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Create &amp; add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
