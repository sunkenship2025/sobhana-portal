/**
 * Report Builder — a home of reports (Drafts + Live) that opens into an
 * editable-report editor with a persistent dock (Inspector · Panel · Pricing ·
 * Compiles-to).
 *
 * A draft is an INACTIVE ClinicalPanel with no product — it can never be billed,
 * and it autosaves as you build. Publish flips it live (+ optional product);
 * Discard deletes it. The editor surface is the REAL server-rendered report in an
 * iframe, edited in place; everything compiles down to ClinicalPanel /
 * ClinicalPanelItem / TestDefinition / BillableProduct.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import {
  Plus, FilePlus2, Loader2, Search, Sparkles, Check, CircleDashed, Package, ArrowDown,
  ArrowLeft, Trash2, Rocket, FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { LoadingState } from '@/components/ui/loading-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { ReportPreviewFrame, type PreviewPayload } from '@/components/reportbuilder/ReportPreviewFrame';
import { EditableReportFrame, type PanelEditField } from '@/components/reportbuilder/EditableReportFrame';
import { ItemInspectorBody, type InspectorItem, type CanonicalPatch } from '@/components/reportbuilder/ItemInspector';
import {
  CODE_REGEX, LAYOUTS, SAMPLE_TYPES, type Department, type TestDef, type BuilderItem, type PanelForm,
  blankPanel, uid, itemFromDef, autoCode,
} from './reportBuilderShared';
import { PAYOUT_CATEGORIES } from '@/lib/payoutCategories';

type DockTab = 'inspector' | 'panel' | 'pricing' | 'compile';
interface PanelRow { id: string; code: string; name: string; isActive: boolean; itemCount: number; departmentName: string; productCount: number; }
const renameKey = (m: Record<string, any>, from: string, to: string) => {
  if (!(from in m)) return m; const n = { ...m }; n[to] = n[from]; delete n[from]; return n;
};

export default function ReportBuilder() {
  const { token } = useAuthStore();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'home' | 'editor'>('home');
  const [panelsList, setPanelsList] = useState<PanelRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [defs, setDefs] = useState<TestDef[]>([]);
  const [homeQuery, setHomeQuery] = useState('');

  const [panel, setPanel] = useState<PanelForm>(blankPanel());
  const [items, setItemsRaw] = useState<BuilderItem[]>([]);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [profile, setProfile] = useState<'digital' | 'letterhead'>('digital');
  const [reloadKey, setReloadKey] = useState(0);
  const [rev, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [inspectUid, setInspectUid] = useState<string | null>(null);
  const [rangesFocus, setRangesFocus] = useState(0);
  const [dockTab, setDockTab] = useState<DockTab>('panel');
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{ id: string; name: string; fromEditor?: boolean } | null>(null);
  const codeTouchedRef = useRef(false);
  const lastAutoCodeRef = useRef('');

  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);
  const touch = useCallback(() => { setDirty(true); setRev((r) => r + 1); }, []);
  const setItems = useCallback((updater: (xs: BuilderItem[]) => BuilderItem[]) => { setItemsRaw(updater); touch(); }, [touch]);
  const setP = useCallback((patch: Partial<PanelForm>) => { setPanel((p) => ({ ...p, ...patch })); touch(); }, [touch]);
  const setPReload = (patch: Partial<PanelForm>) => { setP(patch); bumpReload(); };
  const patchItem = (uid_: string, patch: Partial<BuilderItem>) => setItems((xs) => xs.map((x) => (x._uid === uid_ ? { ...x, ...patch } : x)));

  const loadAll = useCallback(async () => {
    try {
      const [pRes, dRes, defRes] = await Promise.all([
        fetch(`${API_BASE}/clinical-panels?active=all`, { headers }),
        fetch(`${API_BASE}/departments`, { headers }),
        fetch(`${API_BASE}/clinical-definitions?status=ACTIVE`, { headers }),
      ]);
      if (pRes.ok) {
        const rows = await pRes.json();
        setPanelsList(rows.map((r: any) => ({
          id: r.id, code: r.code, name: r.name, isActive: !!r.isActive,
          itemCount: r.itemCount ?? 0, departmentName: r.department?.name ?? '', productCount: r.productCount ?? 0,
        })));
      }
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
        payoutCategory: p.payoutCategory ?? null,
        panelMethodText: p.panelMethodText ?? null, panelMethodItalic: !!p.panelMethodItalic,
        showMethodColumn: !!p.showMethodColumn, showSubgroups: !!p.showSubgroups, showInterpretation: !!p.showInterpretation,
        spacedDefinitionsGap: p.spacedDefinitionsGap ?? 0, valueDisplayPrefix: p.valueDisplayPrefix ?? null,
        comments: p.comments ?? null, interpretation: p.interpretation ?? null,
        narrativeTemplateHtml: p.narrativeTemplateHtml ?? null,
        subgroupMethods: p.subgroupMethods ?? {}, subgroupTableOverrides: p.subgroupTableOverrides ?? {},
        isActive: !!p.isActive,
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
      codeTouchedRef.current = true;
      setDirty(false); setSaveState('saved'); setInspectUid(null); setDockTab('inspector'); setView('editor'); bumpReload();
    } catch { toast.error('Failed to open panel'); }
  };
  const openNew = () => {
    codeTouchedRef.current = false; lastAutoCodeRef.current = '';
    setPanel(blankPanel()); setItemsRaw([]); setDirty(false); setSaveState('idle'); setInspectUid(null); setDockTab('panel'); setView('editor'); bumpReload();
  };
  const backHome = () => { setView('home'); setPanel(blankPanel()); setItemsRaw([]); setDirty(false); loadAll(); };

  const departmentName = departments.find((d) => d.id === panel.departmentId)?.name ?? '';
  const liveItems = useMemo(() => items.filter((i) => i.code), [items]);
  const renderedItems = useMemo(() => {
    if (!panel.showSubgroups) return liveItems;
    const groups = new Map<string, BuilderItem[]>();
    for (const it of liveItems) { const g = it.subGroup || '__default__'; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(it); }
    return Array.from(groups.values()).flat();
  }, [liveItems, panel.showSubgroups]);

  const previewPayload: PreviewPayload = useMemo(() => ({
    panel: {
      code: panel.code || 'PREVIEW', label: panel.label || 'Untitled report',
      departmentId: panel.departmentId || undefined, departmentName,
      layoutType: panel.layoutType, sampleType: panel.sampleType, panelMethodText: panel.panelMethodText,
      panelMethodItalic: panel.panelMethodItalic, showMethodColumn: panel.showMethodColumn, showSubgroups: panel.showSubgroups, showInterpretation: panel.showInterpretation,
      spacedDefinitionsGap: panel.spacedDefinitionsGap, valueDisplayPrefix: panel.valueDisplayPrefix,
      comments: panel.comments, interpretation: panel.interpretation, narrativeTemplateHtml: panel.narrativeTemplateHtml,
      subgroupMethods: panel.subgroupMethods, subgroupTableOverrides: panel.subgroupTableOverrides,
    },
    items: renderedItems.map((it, idx) => ({
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
  }), [panel, renderedItems, departmentName]);

  /* ── Edits streamed back from inside the report ── */
  const onPanelEdit = (field: PanelEditField, value: string) => {
    if (field === 'label') {
      const patch: Partial<PanelForm> = { label: value };
      if (!codeTouchedRef.current && (!panel.code || panel.code === lastAutoCodeRef.current)) {
        const c = value.trim() ? autoCode(value, new Set(panelsList.map((p) => p.code))) : '';
        patch.code = c; lastAutoCodeRef.current = c;
      }
      return setP(patch);
    }
    if (field === 'panelMethodText') return setP({ panelMethodText: value.trim() || null });
    if (field === 'narrativeTemplateHtml') return setP({ narrativeTemplateHtml: value || null });
    const prev = (field === 'comments' ? panel.comments : panel.interpretation) ?? '';
    const wasEmpty = !prev.replace(/&nbsp;|\s/g, '');
    const patch: Partial<PanelForm> = { [field]: value || null };
    if (value && value.replace(/&nbsp;|\s/g, '')) patch.showInterpretation = true;
    setP(patch);
    if (wasEmpty) bumpReload();
  };
  const onItemEdit = (index: number, field: 'label' | 'value', value: string) => {
    const it = renderedItems[index]; if (!it) return;
    if (field === 'label') { patchItem(it._uid, { displayLabel: value.trim() || null }); return; }
    const num = Number(value);
    if (value.trim() !== '' && !Number.isNaN(num)) patchItem(it._uid, { mockValue: num, mockTextValue: null });
    else patchItem(it._uid, { mockValue: null, mockTextValue: value.trim() || null });
  };
  const onInspect = (index: number, focus?: 'ranges') => {
    const it = renderedItems[index]; if (!it) return;
    setInspectUid(it._uid); setDockTab('inspector'); if (focus === 'ranges') setRangesFocus((n) => n + 1);
  };
  const onDeselect = () => { setInspectUid(null); setDockTab('panel'); };
  const onDelete = (index: number) => {
    const it = renderedItems[index]; if (!it) return;
    setItems((xs) => xs.filter((x) => x._uid !== it._uid));
    if (inspectUid === it._uid) setInspectUid(null);
    if (liveItems.length <= 1) setDockTab('panel');
    bumpReload();
  };
  const onReorder = (from: number, to: number, before: boolean) => {
    const fromUid = renderedItems[from]?._uid, toUid = renderedItems[to]?._uid;
    if (!fromUid || !toUid || fromUid === toUid) return;
    const arr = renderedItems.slice();
    const fi = arr.findIndex((x) => x._uid === fromUid); const [moved] = arr.splice(fi, 1);
    let ti = arr.findIndex((x) => x._uid === toUid);
    if (ti < 0) arr.push(moved); else arr.splice(before ? ti : ti + 1, 0, moved);
    setItems((xs) => [...arr, ...xs.filter((i) => !i.code)]);
    bumpReload();
  };
  const onSectionRename = (from: string, to: string) => {
    if (!to || from === to) return;
    setItems((xs) => xs.map((x) => ((x.subGroup || '') === from ? { ...x, subGroup: to } : x)));
    setP({ subgroupMethods: renameKey(panel.subgroupMethods, from, to), subgroupTableOverrides: renameKey(panel.subgroupTableOverrides, from, to) });
    bumpReload();
  };
  const onSectionMethod = (name: string, value: string) => {
    const v = value.trim(); const m = { ...panel.subgroupMethods };
    if (v) m[name] = v; else delete m[name];
    setP({ subgroupMethods: m }); bumpReload();
  };
  const onSectionKV = (name: string) => {
    const o = { ...panel.subgroupTableOverrides };
    if (o[name]) delete o[name]; else o[name] = true;
    setP({ subgroupTableOverrides: o }); bumpReload();
  };
  const onAddSection = () => {
    if (!liveItems.length) { toast.info('Add a test first, then group it into a subgroup'); return; }
    const existing = new Set(items.map((i) => i.subGroup).filter(Boolean) as string[]);
    let name = 'SUBGROUP', n = 1; while (existing.has(name)) name = `SUBGROUP ${++n}`;
    const last = liveItems[liveItems.length - 1];
    setItems((xs) => xs.map((x) => (x._uid === last._uid ? { ...x, subGroup: name } : x)));
    if (!panel.showSubgroups) setP({ showSubgroups: true });
    bumpReload();
    toast.success('Subgroup added — rename it on the report; move tests in via ⚙ Subgroup');
  };

  const addExisting = (d: TestDef) => {
    if (items.some((i) => i.testDefinitionId === d.id)) { toast.info('Already in this report'); return; }
    const it = itemFromDef(d);
    setItems((xs) => [...xs, it]); setInspectUid(it._uid); setDockTab('inspector'); bumpReload();
  };
  const onCreate = async (name: string) => {
    const nm = name.trim(); if (!nm) return;
    if (!panel.departmentId) { toast.info('Pick a department in the Panel tab first — new tests are created in it'); setDockTab('panel'); return; }
    const existing = defs.find((d) => d.name.toLowerCase() === nm.toLowerCase());
    if (existing) { addExisting(existing); return; }
    const used = new Set([...defs.map((d) => d.code), ...items.map((i) => i.code)].filter(Boolean));
    const code = autoCode(nm, used);
    try {
      const res = await fetch(`${API_BASE}/clinical-definitions`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: nm, code, departmentId: panel.departmentId || null, interpretationMode: 'NONE', ranges: [], interpretationRules: [] }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Create failed'); }
      const d = await res.json();
      setDefs((xs) => [d, ...xs]);
      const it = itemFromDef(d);
      setItems((xs) => [...xs, it]); setInspectUid(it._uid); setDockTab('inspector'); bumpReload();
      toast.success(`Created ${d.code} (v1) — “${nm}”`);
    } catch (e) { toast.error((e as Error).message); }
  };
  const onCanonicalSaved = (p: CanonicalPatch) => { if (inspectUid) { patchItem(inspectUid, { ...p }); bumpReload(); } };

  const canSave = !!(panel.label.trim() && CODE_REGEX.test(panel.code.trim().toUpperCase()) && panel.departmentId && liveItems.length > 0);

  const persist = useCallback(async (silent: boolean) => {
    if (!canSave) { if (!silent) toast.error('Name, a valid code, a department and at least one test are required'); return; }
    setSaveState('saving');
    try {
      const body = {
        name: panel.code.trim().toUpperCase(), displayName: panel.label.trim(), departmentId: panel.departmentId,
        layoutType: panel.layoutType, sampleType: panel.sampleType, payoutCategory: panel.payoutCategory, panelMethodText: panel.panelMethodText,
        panelMethodItalic: panel.panelMethodItalic, showMethodColumn: panel.showMethodColumn, showSubgroups: panel.showSubgroups, showInterpretation: panel.showInterpretation,
        spacedDefinitionsGap: panel.spacedDefinitionsGap, valueDisplayPrefix: panel.valueDisplayPrefix,
        comments: panel.comments, interpretation: panel.interpretation, narrativeTemplateHtml: panel.narrativeTemplateHtml,
        subgroupMethods: panel.subgroupMethods, subgroupTableOverrides: panel.subgroupTableOverrides, isActive: panel.isActive,
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
      setPanel((p) => ({ ...p, id: saved.id, code: saved.code }));
      setDirty(false); setSaveState('saved');
    } catch (e) { setSaveState('idle'); if (!silent) toast.error((e as Error).message || 'Save failed'); }
  }, [canSave, panel, liveItems, headers]);

  // Autosave in the editor (debounced). A valid new report saves as a DRAFT
  // (blankPanel starts isActive=false), so nothing needs an explicit "Create".
  const revRef = useRef(0);
  useEffect(() => {
    if (view !== 'editor' || !dirty || !canSave) return;
    revRef.current = rev;
    const t = setTimeout(() => { if (revRef.current === rev) persist(true); }, 900);
    return () => clearTimeout(t);
  }, [rev, dirty, canSave, view, persist]);

  const onPublished = (productMade: boolean) => {
    setPanel((p) => ({ ...p, isActive: true }));
    if (productMade) setPanelsList((xs) => xs.map((x) => (x.id === panel.id ? { ...x, isActive: true, productCount: 1 } : x)));
  };
  const doDiscard = async () => {
    const t = discardTarget; if (!t) return;
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${t.id}`, { method: 'DELETE', headers });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || 'Discard failed'); }
      toast.success('Draft discarded');
      setPanelsList((xs) => xs.filter((x) => x.id !== t.id));
      setDiscardTarget(null);
      if (t.fromEditor) backHome();
    } catch (e) { toast.error((e as Error).message); }
  };

  if (loading) return <LoadingState />;

  /* ─────────────── HOME ─────────────── */
  if (view === 'home') {
    return (
      <>
        <ReportHome panels={panelsList} query={homeQuery} setQuery={setHomeQuery}
          onOpen={openPanel} onNew={openNew}
          onDiscard={(p) => setDiscardTarget({ id: p.id, name: p.name })} />
        <DiscardDialog target={discardTarget} onCancel={() => setDiscardTarget(null)} onConfirm={doDiscard} />
      </>
    );
  }

  /* ─────────────── EDITOR ─────────────── */
  const inspected = items.find((i) => i._uid === inspectUid) || null;
  const inspectItem: InspectorItem | null = inspected ? {
    testDefinitionId: inspected.testDefinitionId, code: inspected.code, name: inspected.name,
    displayLabel: inspected.displayLabel, subGroup: inspected.subGroup, indentLevel: inspected.indentLevel,
    isBold: inspected.isBold, isItalic: inspected.isItalic, methodText: inspected.methodText,
  } : null;
  const DOCK_TABS: { k: DockTab; label: string }[] = [
    { k: 'inspector', label: 'Inspector' }, { k: 'panel', label: 'Panel' }, { k: 'pricing', label: 'Pricing' }, { k: 'compile', label: 'Compiles to' },
  ];

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <Button variant="ghost" size="sm" onClick={backHome}><ArrowLeft className="h-4 w-4 mr-1" /> Reports</Button>
        <div className="h-5 w-px bg-border" />
        <span className="text-sm font-medium truncate max-w-[190px]" title={panel.label}>{panel.label.trim() || 'Untitled report'}</span>
        <StatusChip id={panel.id} isActive={panel.isActive} state={saveState} dirty={dirty} />
        <div className="h-5 w-px bg-border" />
        <Select value={panel.layoutType} onValueChange={(v) => setPReload({ layoutType: v })}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>{LAYOUTS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
        </Select>
        <AddExistingButton defs={defs} used={new Set(items.map((i) => i.testDefinitionId))} onAdd={addExisting} />

        <div className="flex-1" />

        <div className="inline-flex rounded-md border p-0.5">
          <Button variant={mode === 'edit' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('edit')}>Edit</Button>
          <Button variant={mode === 'preview' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('preview')}>Preview</Button>
        </div>
        <div className="inline-flex rounded-md border p-0.5">
          <Button variant={profile === 'digital' ? 'secondary' : 'ghost'} size="sm" onClick={() => setProfile('digital')}>Digital</Button>
          <Button variant={profile === 'letterhead' ? 'secondary' : 'ghost'} size="sm" onClick={() => setProfile('letterhead')}>Letterhead</Button>
        </div>
        {!panel.isActive ? (
          <>
            {panel.id && <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setDiscardTarget({ id: panel.id!, name: panel.label || 'Untitled report', fromEditor: true })}><Trash2 className="h-4 w-4" /></Button>}
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setPublishOpen(true)} disabled={!panel.id || !canSave}>
              <Rocket className="h-4 w-4 mr-1" /> Publish
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setDockTab('pricing')}><Package className="h-4 w-4 mr-1" /> Pricing</Button>
        )}
      </div>

      {/* Stage */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_370px]">
        <div>
          {mode === 'edit' ? (
            <EditableReportFrame
              payload={previewPayload} profile={profile} reloadKey={reloadKey} headers={headers}
              onPanelEdit={onPanelEdit} onItemEdit={onItemEdit} onInspect={onInspect} onDelete={onDelete} onCreate={onCreate}
              onReorder={onReorder} onSectionRename={onSectionRename} onSectionMethod={onSectionMethod} onSectionKV={onSectionKV} onAddSection={onAddSection} onDeselect={onDeselect}
            />
          ) : (
            <div className="h-[80vh]"><ReportPreviewFrame payload={previewPayload} profile={profile} /></div>
          )}
        </div>

        <aside className="rounded-lg border bg-card overflow-hidden flex flex-col max-h-[82vh]">
          <div className="flex border-b shrink-0">
            {DOCK_TABS.map((t) => (
              <button key={t.k} onClick={() => setDockTab(t.k)}
                className={`flex-1 py-2.5 text-xs font-medium border-b-2 ${dockTab === t.k ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="overflow-y-auto flex-1">
            {dockTab === 'inspector' && (
              <ItemInspectorBody item={inspectItem} headers={headers} showSubgroup={panel.showSubgroups} focusRanges={rangesFocus}
                onPatch={(p) => { if (inspectUid) { patchItem(inspectUid, p); bumpReload(); } }} onCanonicalSaved={onCanonicalSaved} />
            )}
            {dockTab === 'panel' && <PanelPane panel={panel} departments={departments} setP={setP} setPReload={setPReload}
              onCodeEdit={(v) => { codeTouchedRef.current = true; setP({ code: v.toUpperCase() }); }}
              onNameEdit={(v) => onPanelEdit('label', v)} onNameBlur={bumpReload} />}
            {dockTab === 'pricing' && <PricingPane panel={panel} headers={headers} />}
            {dockTab === 'compile' && <CompilePane panel={panel} items={liveItems} departmentName={departmentName} />}
          </div>
        </aside>
      </div>

      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} panel={panel} headers={headers} onPublished={onPublished} />
      <DiscardDialog target={discardTarget} onCancel={() => setDiscardTarget(null)} onConfirm={doDiscard} />
    </div>
  );
}

/* ───────── Home ───────── */
function ReportHome({ panels, query, setQuery, onOpen, onNew, onDiscard }: {
  panels: PanelRow[]; query: string; setQuery: (v: string) => void;
  onOpen: (id: string) => void; onNew: () => void; onDiscard: (p: PanelRow) => void;
}) {
  const q = query.trim().toLowerCase();
  const match = (p: PanelRow) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q);
  const drafts = panels.filter((p) => !p.isActive && match(p));
  const live = panels.filter((p) => p.isActive && match(p));
  return (
    <div className="space-y-7">
      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-3 border-b bg-background/95 px-1 py-3 backdrop-blur">
        <div className="shrink-0"><h2 className="text-xl font-bold tracking-tight">Reports</h2><p className="text-sm text-muted-foreground">Build and manage your diagnostic report templates.</p></div>
        <div className="relative ml-auto flex-1 min-w-[220px] max-w-2xl"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${panels.length} report${panels.length === 1 ? '' : 's'}…`} className="pl-8 w-full" /></div>
        <Button onClick={onNew} className="shrink-0"><Plus className="h-4 w-4 mr-1" /> New report</Button>
      </div>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Drafts <span className="text-muted-foreground/70">· {drafts.length}</span></h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {drafts.map((p) => (
            <button key={p.id} onClick={() => onOpen(p.id)} className="group text-left rounded-xl border bg-card p-4 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><div className="font-semibold truncate">{p.name}</div><div className="text-xs text-muted-foreground mt-0.5"><span className="font-mono">{p.code}</span> · {p.departmentName || '—'}</div></div>
                <span className="shrink-0 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-0.5">Draft</span>
              </div>
              <div className="flex items-center justify-between mt-4">
                <span className="text-xs text-muted-foreground">{p.itemCount} test{p.itemCount === 1 ? '' : 's'}</span>
                <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onDiscard(p); }} className="h-7 w-7 grid place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:border hover:border-destructive"><Trash2 className="h-3.5 w-3.5" /></span>
              </div>
            </button>
          ))}
          <button onClick={onNew} className="rounded-xl border-2 border-dashed bg-background hover:bg-muted/40 p-4 min-h-[120px] flex flex-col items-center justify-center text-center transition">
            <span className="h-9 w-9 rounded-full bg-primary/10 grid place-items-center mb-2"><Plus className="h-5 w-5 text-primary" /></span>
            <span className="font-semibold text-primary">New report</span><span className="text-xs text-muted-foreground">Blank template</span>
          </button>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Live reports <span className="text-muted-foreground/70">· {live.length}</span></h3>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground rounded-lg border border-dashed p-6 text-center">No live reports yet — build a draft and Publish it.</p>
        ) : (
          <div className="rounded-lg border bg-card divide-y overflow-hidden">
            {live.map((p) => (
              <button key={p.id} onClick={() => onOpen(p.id)} className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-muted/50">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium min-w-0 truncate flex-1">{p.name}</span>
                <span className="font-mono text-xs text-muted-foreground w-20 shrink-0 hidden sm:block">{p.code}</span>
                <span className="text-sm text-muted-foreground w-32 shrink-0 hidden md:block truncate">{p.departmentName}</span>
                <span className="text-xs text-muted-foreground w-16 shrink-0 hidden md:block">{p.itemCount} test{p.itemCount === 1 ? '' : 's'}</span>
                <span className={`shrink-0 rounded-full text-[10px] font-bold px-2 py-0.5 ${p.productCount > 0 ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>{p.productCount > 0 ? 'Billable' : 'Live'}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ───────── Status chip ───────── */
function StatusChip({ id, isActive, state, dirty }: { id: string | null; isActive: boolean; state: 'idle' | 'saving' | 'saved'; dirty: boolean }) {
  if (state === 'saving') return <span className="flex items-center gap-1.5 text-xs text-amber-600"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</span>;
  if (!id) return <span className="flex items-center gap-1.5 text-xs text-amber-600"><CircleDashed className="h-3.5 w-3.5" /> Draft · add a test to save</span>;
  if (isActive) return <span className="flex items-center gap-1.5 text-xs text-emerald-600"><Check className="h-3.5 w-3.5" /> Live{dirty ? ' · saving…' : ''}</span>;
  return <span className="flex items-center gap-1.5 text-xs text-amber-600"><CircleDashed className="h-3.5 w-3.5" /> Draft · {dirty ? 'unsaved' : 'autosaved'}</span>;
}

/* ───────── Publish dialog ───────── */
function PublishDialog({ open, onOpenChange, panel, headers, onPublished }: {
  open: boolean; onOpenChange: (v: boolean) => void; panel: PanelForm; headers: Record<string, string>; onPublished: (productMade: boolean) => void;
}) {
  const [sell, setSell] = useState(true);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setSell(true); setPrice(''); } }, [open]);
  const confirm = async () => {
    if (!panel.id) return;
    if (sell && (price === '' || Number.isNaN(Number(price)))) { toast.error('Enter a price, or uncheck "also sell"'); return; }
    setBusy(true);
    try {
      const r1 = await fetch(`${API_BASE}/clinical-panels/${panel.id}`, { method: 'PATCH', headers, body: JSON.stringify({ isActive: true }) });
      if (!r1.ok) { const j = await r1.json().catch(() => ({})); throw new Error(j.message || 'Publish failed'); }
      let productMade = false;
      if (sell && price !== '') {
        const r2 = await fetch(`${API_BASE}/billable-products`, {
          method: 'POST', headers,
          body: JSON.stringify({ name: panel.label.trim(), code: panel.code.trim().toUpperCase(), basePrice: Number(price), workflowMode: 'REPORTABLE', panels: [{ panelId: panel.id }] }),
        });
        if (r2.ok) productMade = true;
        else { const j = await r2.json().catch(() => ({})); toast.error(j.message || 'Published live, but the product failed — add it in the Pricing tab'); }
      }
      toast.success(productMade ? 'Published — live & billable' : 'Published — now live');
      onPublished(productMade);
      onOpenChange(false);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish “{panel.label.trim() || 'Untitled report'}”?</DialogTitle>
          <DialogDescription>Makes it live — usable in reports, result entry and ordering. It stays not billable unless you give it a price.</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer">
          <input type="checkbox" checked={sell} onChange={(e) => setSell(e.target.checked)} className="h-4 w-4" />
          <span className="text-sm">Also sell it now at ₹</span>
          <Input value={price} onChange={(e) => setPrice(e.target.value)} disabled={!sell} placeholder="450" className="h-8 w-24" />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={confirm} disabled={busy}>{busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────── Discard dialog ───────── */
function DiscardDialog({ target, onCancel, onConfirm }: { target: { id: string; name: string } | null; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard this draft?</DialogTitle>
          <DialogDescription>Deletes “{target?.name}”. This can't be undone. (Definitions it created stay in Clinical Definitions and can be reused.)</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Keep it</Button>
          <Button variant="destructive" onClick={onConfirm}>Discard draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────── Add existing test ───────── */
function AddExistingButton({ defs, used, onAdd }: { defs: TestDef[]; used: Set<string>; onAdd: (d: TestDef) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const hits = defs.filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()) || d.code.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="outline" size="sm"><Search className="h-4 w-4 mr-1" /> Add existing</Button></PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <div className="flex items-center gap-2 border rounded-md px-2 mb-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests…" className="border-0 focus-visible:ring-0 px-0" />
        </div>
        <div className="max-h-72 overflow-auto space-y-0.5">
          {hits.map((d) => (
            <button key={d.id} disabled={used.has(d.id)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-accent disabled:opacity-40 flex items-center justify-between"
              onClick={() => { onAdd(d); setOpen(false); setQ(''); }}>
              <span className="text-sm">{d.name} <span className="text-xs text-muted-foreground font-mono">{d.code}</span></span>
              {used.has(d.id) && <span className="text-[11px] text-muted-foreground">added</span>}
            </button>
          ))}
          {hits.length === 0 && <p className="text-sm text-muted-foreground py-3 text-center flex items-center justify-center gap-1"><Sparkles className="h-3.5 w-3.5" /> Type it on the report to create it.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ───────── Panel pane ───────── */
function PanelPane({ panel, departments, setP, setPReload, onCodeEdit, onNameEdit, onNameBlur }: {
  panel: PanelForm; departments: Department[]; setP: (p: Partial<PanelForm>) => void; setPReload: (p: Partial<PanelForm>) => void;
  onCodeEdit: (v: string) => void; onNameEdit: (v: string) => void; onNameBlur: () => void;
}) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Panel settings · ClinicalPanel</h4>
        <div className="space-y-1.5 mb-3">
          <Label className="text-xs">Report name</Label>
          <Input value={panel.label} onChange={(e) => onNameEdit(e.target.value)} onBlur={onNameBlur} placeholder="e.g. Complete Blood Picture" className="h-8" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label className="text-xs">Code</Label><Input value={panel.code} onChange={(e) => onCodeEdit(e.target.value)} disabled={!!panel.id} className="font-mono h-8" placeholder="CBP" /></div>
          <div className="space-y-1.5"><Label className="text-xs">Department</Label>
            <Select value={panel.departmentId || undefined} onValueChange={(v) => setPReload({ departmentId: v })}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div className="space-y-1.5"><Label className="text-xs">Sample type</Label>
            <Select value={panel.sampleType || '__none__'} onValueChange={(v) => setPReload({ sampleType: v === '__none__' ? null : v })}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent><SelectItem value="__none__">None</SelectItem>{SAMPLE_TYPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label className="text-xs">Category</Label>
            <Select value={panel.payoutCategory || '__none__'} onValueChange={(v) => setP({ payoutCategory: v === '__none__' ? null : v })}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent><SelectItem value="__none__">None</SelectItem>{PAYOUT_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5 mt-3"><Label className="text-xs">Panel method</Label>
          <Input value={panel.panelMethodText ?? ''} onChange={(e) => setP({ panelMethodText: e.target.value || null })} placeholder="Shown below the panel title" className="h-8" />
          <div className="flex items-center justify-between pt-1"><Label className="text-xs cursor-pointer" htmlFor="p-mi">Italicize panel method</Label><Switch id="p-mi" checked={panel.panelMethodItalic} disabled={!panel.panelMethodText?.trim()} onCheckedChange={(v) => setPReload({ panelMethodItalic: v })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div className="space-y-1.5"><Label className="text-xs">Spaced gap</Label>
            <Select value={String(panel.spacedDefinitionsGap)} onValueChange={(v) => setPReload({ spacedDefinitionsGap: Number(v) })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>{[0, 1, 2, 3].map((g) => <SelectItem key={g} value={String(g)}>{['None', 'Small', 'Medium', 'Large'][g]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label className="text-xs">Value prefix</Label><Input value={panel.valueDisplayPrefix ?? ''} maxLength={5} onChange={(e) => setPReload({ valueDisplayPrefix: e.target.value || null })} className="h-8" placeholder='"1:"' /></div>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><Label className="text-xs cursor-pointer" htmlFor="p-mc">Show Method column</Label><Switch id="p-mc" checked={panel.showMethodColumn} onCheckedChange={(v) => setPReload({ showMethodColumn: v })} /></div>
        <div className="flex items-center justify-between"><Label className="text-xs cursor-pointer" htmlFor="p-sg">Show subgroups</Label><Switch id="p-sg" checked={panel.showSubgroups} onCheckedChange={(v) => setPReload({ showSubgroups: v })} /></div>
        <div className="flex items-center justify-between"><Label className="text-xs cursor-pointer" htmlFor="p-cn">Clinical Notes box</Label><Switch id="p-cn" checked={panel.showInterpretation} onCheckedChange={(v) => setPReload({ showInterpretation: v })} /></div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">The method column, subgroups &amp; subgroup methods appear automatically when you add that content on the report. Whether it's live &amp; billable is set by <b>Publish</b>.</p>
    </div>
  );
}

/* ───────── Pricing pane ───────── */
function PricingPane({ panel, headers }: { panel: PanelForm; headers: Record<string, string> }) {
  const [price, setPrice] = useState('');
  const [workflow, setWorkflow] = useState('REPORTABLE');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishedCode, setPublishedCode] = useState<string | null>(null);
  const publish = async () => {
    if (!panel.id) { toast.error('Save the report first'); return; }
    if (price === '' || Number.isNaN(Number(price))) { toast.error('Enter a price'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/billable-products`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: panel.label.trim(), code: panel.code.trim().toUpperCase(), basePrice: Number(price), workflowMode: workflow, payoutCategory: category || null, panels: [{ panelId: panel.id }] }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `Publish failed (${res.status})`); }
      const p = await res.json(); setPublishedCode(p.code); toast.success(`Published product ${p.code}`);
    } catch (e) { toast.error((e as Error).message || 'Publish failed'); } finally { setBusy(false); }
  };
  return (
    <div className="p-4 space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sell this report · BillableProduct</h4>
      {!panel.id && <p className="text-xs text-muted-foreground">Add a test to save the draft first, then publish it as a billable product.</p>}
      <div className="space-y-1.5"><Label className="text-xs">List price (₹)</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="450" className="h-8" /><p className="text-[11px] text-muted-foreground">Stored in paise. Product code <b>{panel.code || '—'}</b>.</p></div>
      <div className="space-y-1.5"><Label className="text-xs">Workflow mode</Label>
        <Select value={workflow} onValueChange={setWorkflow}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="REPORTABLE">Reportable</SelectItem><SelectItem value="BILL_ONLY">Bill only</SelectItem><SelectItem value="EXTERNAL_UPLOAD">External upload</SelectItem><SelectItem value="EVENT">Event</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5"><Label className="text-xs">Payout category</Label><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Laboratory" className="h-8" /><p className="text-[11px] text-muted-foreground">Referral commission is set per <b>category</b> (Referrals) — not per test.</p></div>
      <Button size="sm" className="w-full" onClick={publish} disabled={busy || !panel.id}>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Package className="h-4 w-4 mr-1" />}{publishedCode ? 'Publish again' : 'Publish product'}</Button>
      {publishedCode && <p className="text-xs text-emerald-600 flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Live as {publishedCode}.</p>}
      <p className="text-[11px] text-muted-foreground leading-relaxed">Per-branch prices, packages &amp; bundles live in the full <b>Billable Products</b> tab — this rail publishes the common one-panel = one-product case.</p>
    </div>
  );
}

/* ───────── Compiles-to pane ───────── */
function CompilePane({ panel, items, departmentName }: { panel: PanelForm; items: BuilderItem[]; departmentName: string }) {
  const Node = ({ title, tag, kv }: { title: string; tag: string; kv: string }) => (
    <div className="rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center gap-2 mb-1"><span className="text-sm font-semibold">{title}</span><span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary">{tag}</span></div>
      <div className="text-[11px] text-muted-foreground">{kv}</div>
    </div>
  );
  const Arrow = () => <div className="flex justify-center text-muted-foreground py-0.5"><ArrowDown className="h-3.5 w-3.5" /></div>;
  return (
    <div className="p-4 space-y-1">
      <p className="text-[11px] text-muted-foreground mb-2">Nothing new in the database. The report <b>compiles</b> to your existing models — like JSX to the DOM.</p>
      <Node title={panel.label || 'Untitled report'} tag="BillableProduct" kv={`code ${panel.code || '—'} · 1 line → panel`} />
      <Arrow />
      <Node title={panel.code || '—'} tag="ClinicalPanel" kv={`layout ${panel.layoutType} · dept ${departmentName || '—'} · subgroups ${panel.showSubgroups ? 'on' : 'off'} · ${items.length} items`} />
      <Arrow />
      <Node title={`${items.length} × ClinicalPanelItem`} tag="layout" kv="order, indent, subgroup, displayLabel, join, width — presentation only" />
      <Arrow />
      <Node title={`${items.length} × TestDefinition`} tag="canonical" kv="code, unit, ranges, criticals, formula, input-config — versioned, shared" />
    </div>
  );
}
