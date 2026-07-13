import { useState, useEffect, useCallback, Fragment, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Search, Eye, LayoutGrid, GripVertical, Trash2,
  ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { RichTextNarrativeEditor } from '@/components/diagnostics/RichTextNarrativeEditor';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  hasMeaningfulRichText,
  normalizeRichTextForStorage,
  sanitizeRichTextHtml,
} from '@/lib/richText';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  TestInputConfigEditor,
  defaultInputConfig,
  summarizeInputConfig,
  type TestInputConfigPayload,
} from '@/components/diagnostics/TestInputConfigEditor';
import { Settings2 } from 'lucide-react';

/* ───────── Types ───────── */

interface Department { id: string; name: string }

interface TestDefinitionSummary {
  id: string;
  rootDefinitionId: string;
  name: string;
  code: string;
  version: number;
  status: string;
  method?: string | null;
  referenceUnit?: string;
  referenceMin?: number | null;
  referenceMax?: number | null;
  referenceText?: string | null;
}

interface ClinicalPanelItem {
  id?: string;
  testDefinitionId: string;
  displayOrder: number;
  showMethod: boolean;
  methodText: string | null;
  indentLevel: number;
  isBold: boolean;
  isItalic: boolean;
  subGroup: string | null;
  joinPrevious: boolean;
  gridWidth: number | null;
  testDefinition?: TestDefinitionSummary;
}

interface ClinicalPanel {
  id: string;
  name: string;
  code: string;
  layoutType: string;
  sampleType: string | null;
  departmentId: string | null;
  isActive: boolean;
  showMethodColumn: boolean;
  showSubgroups: boolean;
  showInterpretation: boolean;
  valueDisplayPrefix: string | null;
  spacedDefinitionsGap: number;
  panelMethodText: string | null;
  panelMethodItalic: boolean;
  narrativeTemplateHtml: string | null;
  summaryInterpretationTemplate: string | null;
  comments: string | null;
  interpretation: string | null;
  subgroupMethods: Record<string, string> | null;
  subgroupTableOverrides: Record<string, boolean> | null;
  createdAt: string;
  updatedAt: string;
  department?: { id: string; name: string } | null;
  items: ClinicalPanelItem[];
  itemCount?: number;
}

const LAYOUT_TYPES = [
  { value: 'STANDARD_TABLE', label: 'Standard Table – configurable test table', hint: '', color: 'bg-blue-100 text-blue-800' },
  { value: 'TEXT_ONLY', label: 'Text Only – free text result', hint: 'Max 1 item', color: 'bg-muted text-foreground' },
  { value: 'IMAGING_NARRATIVE', label: 'Imaging Narrative – radiology reports', hint: '', color: 'bg-purple-100 text-purple-800' },
  { value: 'PROCEDURE_STRUCTURED', label: 'Procedure Structured – procedure reports', hint: '', color: 'bg-amber-100 text-amber-800' },
];

function layoutBadge(layoutType: string) {
  const lt = LAYOUT_TYPES.find(l => l.value === layoutType);
  return lt ? lt.color : 'bg-muted text-foreground';
}

const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

const SAMPLE_TYPES = ['WB-EDTA', 'NaF WB', 'Serum', 'Plasma', 'Urine', 'CSF', 'Synovial Fluid', 'Semen', 'N/A', 'Other'];

function supportsRichTextTemplate(layoutType: string): boolean {
  return layoutType === 'TEXT_ONLY' || layoutType === 'IMAGING_NARRATIVE';
}

function getLayoutItemConstraintMessage(layoutType: string, itemCount: number): string | null {
  switch (layoutType) {
    case 'TEXT_ONLY':
      return itemCount === 1 ? null : 'Text Only panels require exactly 1 backing test item';
    case 'IMAGING_NARRATIVE':
      return itemCount === 1 ? null : 'Imaging Narrative panels require exactly 1 backing test item';
    case 'STANDARD_TABLE':
      return itemCount > 0 ? null : 'Standard Table panels require at least 1 test item';
    case 'PROCEDURE_STRUCTURED':
      return itemCount > 0 ? null : 'Procedure Structured panels require at least 1 test item';
    default:
      return itemCount > 0 ? null : `${layoutType.replace(/_/g, ' ')} panels require at least 1 test item`;
  }
}

/* ───────── Per-item Value Input popover ─────────
 * Mounted only when the popover is open (key={rootDefinitionId+open}),
 * so it loads on first open and saves via PUT /test-input-configs/:rootId.
 * onSaved bubbles the saved config up to the parent's cache.
 */
function ValueInputConfigPopover({
  rootDefinitionId,
  testLabel,
  cached,
  authHeaders,
  onSaved,
}: {
  rootDefinitionId: string;
  testLabel: string;
  cached: TestInputConfigPayload | undefined;
  authHeaders: Record<string, string>;
  onSaved: (cfg: TestInputConfigPayload) => void;
}) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<TestInputConfigPayload | null>(cached ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open || config) return;
    setLoading(true);
    fetch(`${API_BASE}/test-input-configs/${rootDefinitionId}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        setConfig({
          rootDefinitionId: data.rootDefinitionId ?? rootDefinitionId,
          inputType: data.inputType ?? 'NUMERIC',
          defaultValue: data.defaultValue ?? null,
          valueOptions: Array.isArray(data.valueOptions) ? data.valueOptions : [],
        });
      })
      .catch(() => setConfig(defaultInputConfig(rootDefinitionId)))
      .finally(() => setLoading(false));
  }, [open, rootDefinitionId, config, authHeaders]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const cleanedOptions = config.valueOptions.map((v) => v.trim()).filter(Boolean);
      const res = await fetch(`${API_BASE}/test-input-configs/${rootDefinitionId}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          inputType: config.inputType,
          defaultValue: config.defaultValue?.trim() || null,
          valueOptions: cleanedOptions,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.message || 'Failed to save input config');
        return;
      }
      const saved = await res.json();
      const next: TestInputConfigPayload = {
        rootDefinitionId: saved.rootDefinitionId,
        inputType: saved.inputType,
        defaultValue: saved.defaultValue,
        valueOptions: Array.isArray(saved.valueOptions) ? saved.valueOptions : [],
      };
      onSaved(next);
      setConfig(next);
      setDirty(false);
      toast.success('Input config saved');
      setOpen(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save input config');
    } finally {
      setSaving(false);
    }
  };

  const summary = summarizeInputConfig(cached ?? config ?? null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1.5">
          <Settings2 className="h-3 w-3" /> Configure presets…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[460px] p-3 max-h-[80vh] overflow-y-auto">
        <div className="space-y-3">
          <div>
            <div className="font-medium text-sm">Value input · {testLabel}</div>
            <div className="text-xs text-muted-foreground">
              Shared across every panel and every version of this test.
            </div>
          </div>
          {loading || !config ? (
            <p className="text-xs text-muted-foreground py-3">Loading…</p>
          ) : (
            <TestInputConfigEditor
              rootDefinitionId={rootDefinitionId}
              config={config}
              onChange={(next) => {
                setConfig(next);
                setDirty(true);
              }}
            />
          )}
          <div className="flex items-center justify-between gap-2 pt-1 border-t">
            <span className="text-[11px] text-muted-foreground">{summary}</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleSave} disabled={!dirty || saving || !config}>
                {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function renderPreviewLabel(
  name: string | null | undefined,
  options?: {
    isBold?: boolean;
    isItalic?: boolean;
    method?: string | null;
    paddingLeft?: number;
    bodyClassName?: string;
    methodClassName?: string;
  }
) {
  const {
    isBold = false,
    isItalic = false,
    method = null,
    paddingLeft = 0,
    bodyClassName = 'py-1',
    methodClassName = 'text-[9px]',
  } = options ?? {};

  return (
    <div className={bodyClassName} style={{ paddingLeft }}>
      <div className={[isBold ? 'font-bold' : ''].filter(Boolean).join(' ')}>
        {name || '\u2014'}
      </div>
      {method && (
        <div className={[methodClassName, 'text-muted-foreground leading-tight', isItalic ? 'italic' : ''].filter(Boolean).join(' ')}>
          (Method : {method})
        </div>
      )}
    </div>
  );
}

function renderPanelMethodPreview(methodText: string | null | undefined, italic: boolean, className = 'mt-1 text-[10px] text-muted-foreground') {
  if (!methodText) return null;

  return (
    <div className={[className, italic ? 'italic' : ''].filter(Boolean).join(' ')}>
      (Method : {methodText})
    </div>
  );
}

/* ───────── Component ───────── */

export default function ManagePanelDefinitions() {
  const { token } = useAuthStore();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [panels, setPanels] = useState<ClinicalPanel[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [availableDefs, setAvailableDefs] = useState<TestDefinitionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPanel, setEditingPanel] = useState<ClinicalPanel | null>(null);
  const [saving, setSaving] = useState(false);

  // Preview dialog
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);

  // Form
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formLayout, setFormLayout] = useState('STANDARD_TABLE');
  const [formDeptId, setFormDeptId] = useState('');
  const [formSampleType, setFormSampleType] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [formItems, setFormItems] = useState<ClinicalPanelItem[]>([]);

  // Code validation
  const [codeAvailable, setCodeAvailable] = useState<boolean | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);
  const codeCheckTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Layout config flags
  const [formShowMethod, setFormShowMethod] = useState(false);
  const [formShowSubgroups, setFormShowSubgroups] = useState(false);
  const [formShowInterpretation, setFormShowInterpretation] = useState(false);
  const [formSpacedDefinitionsGap, setFormSpacedDefinitionsGap] = useState<number>(0);
  const [formValuePrefix, setFormValuePrefix] = useState('');
  const [formPanelMethodText, setFormPanelMethodText] = useState('');
  const [formPanelMethodItalic, setFormPanelMethodItalic] = useState(false);
  const [formNarrativeTemplateHtml, setFormNarrativeTemplateHtml] = useState('');
  // Comments (rich text, default) + Interpretation (rich text, behind Advanced)
  const [formComments, setFormComments] = useState('');
  const [formInterpretation, setFormInterpretation] = useState('');
  const [formShowAdvanced, setFormShowAdvanced] = useState(false);

  // Drag-and-drop
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Expanded items (for per-item display controls)
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  // Per-test input config cache (rootDefinitionId → config), populated lazily.
  const [inputConfigs, setInputConfigs] = useState<Record<string, TestInputConfigPayload>>({});

  // Subgroup management (panel-level defined groups)
  const [formSubgroups, setFormSubgroups] = useState<string[]>([]);
  const [newSubgroupInput, setNewSubgroupInput] = useState('');
  const [formSubgroupMethods, setFormSubgroupMethods] = useState<Record<string, string>>({});
  const [formSubgroupTableOverrides, setFormSubgroupTableOverrides] = useState<Record<string, boolean>>({});
  const [formShowSubgroupMethods, setFormShowSubgroupMethods] = useState(false);
  const [newSubgroupMethodInput, setNewSubgroupMethodInput] = useState('');

  // ─── Display style helpers ──────────────────────────────────────────────

  const getDisplayStyle = (item: ClinicalPanelItem): string => {
    if (item.isBold && !item.isItalic) return 'section-header';
    if (item.isItalic) return 'emphasis';
    return 'normal';
  };

  const setItemDisplayStyle = (idx: number, style: string) => {
    setFormItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      switch (style) {
        case 'section-header': return { ...item, isBold: true, isItalic: false };
        case 'emphasis': return { ...item, isBold: false, isItalic: true };
        default: return { ...item, isBold: false, isItalic: false };
      }
    }));
  };

  const addSubgroup = () => {
    const sg = newSubgroupInput.trim();
    if (!sg) return;
    if (formSubgroups.some(existing => existing.toLowerCase() === sg.toLowerCase())) {
      toast.error('Subgroup already exists');
      return;
    }
    setFormSubgroups(prev => [...prev, sg]);
    // Capture optional method
    const method = newSubgroupMethodInput.trim();
    if (method) {
      setFormSubgroupMethods(prev => ({ ...prev, [sg]: method }));
    }
    setNewSubgroupInput('');
    setNewSubgroupMethodInput('');
  };

  const removeSubgroup = (sg: string) => {
    setFormSubgroups(prev => prev.filter(s => s !== sg));
    setFormItems(prev => prev.map(item => item.subGroup === sg ? { ...item, subGroup: null } : item));
    setFormSubgroupMethods(prev => {
      const next = { ...prev };
      delete next[sg];
      return next;
    });
    setFormSubgroupTableOverrides(prev => {
      const next = { ...prev };
      delete next[sg];
      return next;
    });
  };

  // ─── Data fetching ──────────────────────────────────────────────────────

  const fetchPanels = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      params.set('active', 'all'); // Show active and inactive panels in management view
      const res = await fetch(`${API_BASE}/clinical-panels?${params}`, { headers });
      if (!res.ok) throw new Error('Failed to fetch');
      setPanels(await res.json());
    } catch {
      toast.error('Failed to load panels');
    } finally {
      setLoading(false);
    }
  }, [search]);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/departments`, { headers });
      if (!res.ok) return;
      setDepartments(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchAvailableDefs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/clinical-definitions?status=ACTIVE`, { headers });
      if (!res.ok) return;
      setAvailableDefs(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchPanels(); }, [fetchPanels]);
  useEffect(() => { fetchDepartments(); fetchAvailableDefs(); }, []);

  // ─── Debounced code uniqueness check ──────────────────────────────────

  useEffect(() => {
    if (editingPanel) { setCodeAvailable(null); return; }
    const code = formCode.trim().toUpperCase();
    if (!code || !CODE_REGEX.test(code)) { setCodeAvailable(null); return; }
    if (codeCheckTimer.current) clearTimeout(codeCheckTimer.current);
    setCodeChecking(true);
    codeCheckTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/clinical-panels/check-code?code=${encodeURIComponent(code)}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setCodeAvailable(data.available);
        }
      } catch { /* ignore */ }
      setCodeChecking(false);
    }, 400);
    return () => { if (codeCheckTimer.current) clearTimeout(codeCheckTimer.current); };
  }, [formCode, editingPanel]);

  // ─── Form helpers ───────────────────────────────────────────────────────

  const resetForm = () => {
    setFormName(''); setFormCode(''); setFormLayout('STANDARD_TABLE'); setFormDeptId('');
    setFormSampleType(''); setFormActive(true); setFormItems([]);
    setFormShowMethod(false); setFormShowSubgroups(false);
    setFormShowInterpretation(false); setFormSpacedDefinitionsGap(0); setFormValuePrefix('');
    setFormPanelMethodText(''); setFormPanelMethodItalic(false);
    setFormNarrativeTemplateHtml('');
    setFormComments(''); setFormInterpretation(''); setFormShowAdvanced(false);
    setFormSubgroups([]); setNewSubgroupInput('');
    setFormSubgroupMethods({}); setFormShowSubgroupMethods(false); setNewSubgroupMethodInput('');
    setFormSubgroupTableOverrides({});
    setExpandedItems(new Set());
    setEditingPanel(null);
    setCodeAvailable(null); setCodeChecking(false);
  };

  const populateForm = (p: ClinicalPanel) => {
    setFormName(p.name);
    setFormCode(p.code);
    setFormLayout(p.layoutType);
    setFormDeptId(p.departmentId || '');
    setFormSampleType(p.sampleType || '');
    setFormActive(p.isActive);
    setFormShowMethod(p.showMethodColumn ?? false);
    setFormShowSubgroups(p.showSubgroups ?? false);
    setFormShowInterpretation(p.showInterpretation ?? false);
    setFormSpacedDefinitionsGap(p.spacedDefinitionsGap ?? 0);
    setFormValuePrefix(p.valueDisplayPrefix || '');
    setFormPanelMethodText(p.panelMethodText || '');
    setFormPanelMethodItalic(p.panelMethodItalic ?? false);
    setFormNarrativeTemplateHtml(p.narrativeTemplateHtml || '');
    setFormComments(p.comments ?? p.summaryInterpretationTemplate ?? '');
    setFormInterpretation(p.interpretation ?? '');
    setFormShowAdvanced(hasMeaningfulRichText(p.interpretation));
    const items = (p.items || []).map(item => ({
      testDefinitionId: item.testDefinitionId,
      displayOrder: item.displayOrder,
      showMethod: item.showMethod ?? false,
      methodText: item.methodText ?? item.testDefinition?.method ?? null,
      indentLevel: item.indentLevel ?? 0,
      isBold: item.isBold ?? false,
      isItalic: item.isItalic ?? false,
      subGroup: item.subGroup ?? null,
      joinPrevious: item.joinPrevious ?? false,
      gridWidth: item.gridWidth ?? null,
      testDefinition: item.testDefinition,
    }));
    setFormItems(items);
    // Extract unique subgroups from existing items
    const uniqueSubgroups = [...new Set(items.map(i => i.subGroup).filter(Boolean) as string[])];
    setFormSubgroups(uniqueSubgroups);
    setNewSubgroupInput('');
    // Load subgroup methods
    const methods = (p.subgroupMethods && typeof p.subgroupMethods === 'object')
      ? p.subgroupMethods as Record<string, string>
      : {};
    setFormSubgroupMethods(methods);
    setFormShowSubgroupMethods(Object.keys(methods).length > 0);
    const overrides = (p.subgroupTableOverrides && typeof p.subgroupTableOverrides === 'object')
      ? p.subgroupTableOverrides as Record<string, boolean>
      : {};
    setFormSubgroupTableOverrides(overrides);
    setNewSubgroupMethodInput('');
    setExpandedItems(new Set());
  };

  const openCreate = () => { resetForm(); setDialogOpen(true); };
  const openEdit = async (panel: ClinicalPanel) => {
    // fetch detail
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${panel.id}`, { headers });
      if (!res.ok) throw new Error('Failed');
      const detail = await res.json();
      populateForm(detail);
      setEditingPanel(detail);
      setDialogOpen(true);
    } catch {
      toast.error('Failed to load panel details');
    }
  };

  // ─── Item management ───────────────────────────────────────────────────

  const addItem = () => {
    const maxItems = LAYOUT_MAX_ITEMS[formLayout];
    if (maxItems !== null && formItems.length >= maxItems) {
      toast.error(`${formLayout.replace(/_/g, ' ')} layout supports at most ${maxItems} item${maxItems !== 1 ? 's' : ''}`);
      return;
    }
    setFormItems([...formItems, {
      testDefinitionId: '',
      displayOrder: formItems.length,
      showMethod: false,
      methodText: null,
      indentLevel: 0,
      isBold: false,
      isItalic: false,
      subGroup: null,
      joinPrevious: false,
      gridWidth: null,
    }]);
  };

  const updateItem = (idx: number, field: string, val: any) => {
    // Warn on duplicate test selection
    if (field === 'testDefinitionId' && val) {
      const alreadyExists = formItems.some((item, i) => i !== idx && item.testDefinitionId === val);
      if (alreadyExists) {
        toast.warning('This test is already in this panel. Adding duplicate.');
      }
      // Auto-populate methodText from test definition when selecting a test
      const def = availableDefs.find(d => d.id === val);
      if (def?.method) {
        const updated = [...formItems];
        (updated[idx] as any)['testDefinitionId'] = val;
        (updated[idx] as any)['methodText'] = (updated[idx] as any)['methodText'] || def.method;
        (updated[idx] as any)['testDefinition'] = def;
        setFormItems(updated);
        return;
      }
    }
    const updated = [...formItems];
    (updated[idx] as any)[field] = val;
    setFormItems(updated);
  };

  const removeItem = (idx: number) => {
    setFormItems(formItems.filter((_, i) => i !== idx));
    setExpandedItems(prev => {
      const next = new Set<number>();
      prev.forEach(v => { if (v < idx) next.add(v); else if (v > idx) next.add(v - 1); });
      return next;
    });
  };

  // ─── Drag-and-drop handlers ────────────────────────────────────────────

  const handleDragStart = (idx: number) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    setDragIdx(idx);
  };

  const handleDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  };

  const handleDrop = (targetIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === targetIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    const updated = [...formItems];
    const [moved] = updated.splice(dragIdx, 1);
    updated.splice(targetIdx, 0, moved);
    updated.forEach((item, i) => item.displayOrder = i);
    setFormItems(updated);
    // Also remap expanded indices
    setExpandedItems(new Set());
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null); };

  const toggleExpand = (idx: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  // ─── Layout constraints ────────────────────────────────────────────────

  const LAYOUT_MAX_ITEMS: Record<string, number | null> = {
    STANDARD_TABLE: null,
    TEXT_ONLY: 1,
    IMAGING_NARRATIVE: 1,
    PROCEDURE_STRUCTURED: null,
  };

  const canAddItem = LAYOUT_MAX_ITEMS[formLayout] === null || formItems.length < (LAYOUT_MAX_ITEMS[formLayout] ?? Infinity);
  const supportsSubgroups = formLayout === 'STANDARD_TABLE';
  const supportsMethodColumn = formLayout === 'STANDARD_TABLE' || formLayout === 'PROCEDURE_STRUCTURED';
  const supportsValuePrefix = formLayout === 'STANDARD_TABLE';
  const layoutItemConstraintMessage = getLayoutItemConstraintMessage(formLayout, formItems.length);

  const handleLayoutChange = (newLayout: string) => {
    setFormLayout(newLayout);
    const maxItems = LAYOUT_MAX_ITEMS[newLayout];
    if (maxItems !== null && formItems.length > maxItems) {
      setFormItems(formItems.slice(0, maxItems));
      toast.info(`${newLayout.replace(/_/g, ' ')} layout allows at most ${maxItems} item${maxItems !== 1 ? 's' : ''}. Extra items removed.`);
    }
    if (newLayout !== 'STANDARD_TABLE') {
      setFormShowSubgroups(false);
      setFormItems(prev => prev.map(item => ({ ...item, subGroup: null })));
    }
    if (newLayout !== 'STANDARD_TABLE' && newLayout !== 'PROCEDURE_STRUCTURED') {
      setFormShowMethod(false);
    }
  };

  // ─── Save ───────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!formName.trim() || !formCode.trim()) {
      toast.error('Name and code are required');
      return;
    }

    if (!editingPanel && !CODE_REGEX.test(formCode.trim().toUpperCase())) {
      toast.error('Code must be 2-20 uppercase alphanumeric characters or underscores');
      return;
    }

    if (!editingPanel && codeAvailable === false) {
      toast.error('Code is already in use');
      return;
    }

    if (formItems.some(item => !item.testDefinitionId)) {
      toast.error('All items must have a test definition selected');
      return;
    }

    if (layoutItemConstraintMessage) {
      toast.error(layoutItemConstraintMessage);
      return;
    }

    setSaving(true);
    try {
      if (!formDeptId) {
        toast.error('Department is required');
        setSaving(false);
        return;
      }

      const body = {
        name: formCode.trim(),
        displayName: formName.trim(),
        layoutType: formLayout,
        departmentId: formDeptId,
        sampleType: formSampleType || null,
        isActive: formActive,
        showMethodColumn: formShowMethod,
        showSubgroups: formShowSubgroups,
        showInterpretation: formShowInterpretation,
        spacedDefinitionsGap: formSpacedDefinitionsGap,
        valueDisplayPrefix: formValuePrefix || null,
        panelMethodText: formPanelMethodText.trim() || null,
        panelMethodItalic: formPanelMethodItalic,
        narrativeTemplateHtml: supportsRichTextTemplate(formLayout)
          ? normalizeRichTextForStorage(formNarrativeTemplateHtml) || null
          : null,
        comments: normalizeRichTextForStorage(formComments) || null,
        interpretation: normalizeRichTextForStorage(formInterpretation) || null,
        subgroupMethods: (() => {
          // Filter out empty method strings
          const filtered = Object.fromEntries(
            Object.entries(formSubgroupMethods).filter(([, v]) => v.trim())
          );
          return Object.keys(filtered).length > 0 ? filtered : null;
        })(),
        subgroupTableOverrides: (() => {
          const active = Object.fromEntries(
            Object.entries(formSubgroupTableOverrides).filter(([, v]) => v)
          );
          return Object.keys(active).length > 0 ? active : null;
        })(),
        items: formItems.map((item, i) => ({
          testDefinitionId: item.testDefinitionId,
          displayOrder: i,
          showMethod: item.showMethod ?? false,
          methodText: item.methodText || null,
          indentLevel: item.indentLevel ?? 0,
          isBold: item.isBold ?? false,
          isItalic: item.isItalic ?? false,
          subGroup: item.subGroup || null,
          joinPrevious: i > 0 && (item.joinPrevious ?? false),
          gridWidth: item.gridWidth ?? null,
        })),
      };

      const url = editingPanel
        ? `${API_BASE}/clinical-panels/${editingPanel.id}`
        : `${API_BASE}/clinical-panels`;
      const method = editingPanel ? 'PUT' : 'POST';

      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Save failed');
      }

      toast.success(editingPanel ? 'Panel updated' : 'Panel created');
      setDialogOpen(false);
      resetForm();
      fetchPanels();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ─── Toggle Active ─────────────────────────────────────────────────────

  const toggleActive = async (panel: ClinicalPanel) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${panel.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ isActive: !panel.isActive }),
      });
      if (!res.ok) throw new Error('Toggle failed');
      toast.success(`Panel ${panel.isActive ? 'deactivated' : 'activated'}`);
      fetchPanels();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // ─── Preview ────────────────────────────────────────────────────────────

  const handlePreview = async (panel: ClinicalPanel) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${panel.id}/preview`, {
        method: 'POST', headers,
        body: JSON.stringify({ visitId: null }),
      });
      if (!res.ok) throw new Error('Preview failed');
      setPreviewData(await res.json());
      setPreviewOpen(true);
    } catch (err: any) {
      toast.error(err.message || 'Preview failed');
    }
  };

  // ─── Delete panel ───────────────────────────────────────────────────

  const [deleteConfirm, setDeleteConfirm] = useState<ClinicalPanel | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/clinical-panels/${deleteConfirm.id}`, {
        method: 'DELETE', headers,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Delete failed');
      }
      toast.success(`Panel "${deleteConfirm.name}" deleted`);
      setDeleteConfirm(null);
      fetchPanels();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <LayoutGrid className="h-5 w-5" /> Clinical Panel Definitions
          </h2>
          <p className="text-sm text-muted-foreground">Group tests into panels with layout presets and interpretation templates</p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Panel
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search panels..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {/* Table */}
      {loading ? (
        <LoadingState />
      ) : panels.length === 0 ? (
        <EmptyState title="No panels found" />
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Layout</TableHead>
                <TableHead>Sample</TableHead>
                <TableHead className="text-center">Items</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {panels.map(panel => (
                <TableRow key={panel.id} className="hover:bg-muted/50">
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">{panel.code}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{panel.name}</TableCell>
                  <TableCell>
                    <Badge className={layoutBadge(panel.layoutType)}>{panel.layoutType.replace(/_/g, ' ')}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {panel.sampleType || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className="text-xs">{panel.items?.length || 0}</Badge>
                  </TableCell>
                  <TableCell>{panel.department?.name || '—'}</TableCell>
                  <TableCell>
                    <Badge className={panel.isActive ? 'bg-green-100 text-green-800' : 'bg-muted text-foreground'}>
                      {panel.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center gap-0.5 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(panel)} title="Edit" className="h-7 w-7 p-0">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handlePreview(panel)} title="Preview panel structure" className="h-7 px-2 gap-1 text-xs">
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(panel)} title="Delete panel" className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <Switch
                        checked={panel.isActive}
                        onCheckedChange={() => toggleActive(panel)}
                        className="ml-1"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-right">
        Showing {panels.length} panel{panels.length !== 1 ? 's' : ''}
      </p>

      {/* ─── Create/Edit Dialog ───────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingPanel ? `Edit Panel: ${editingPanel.name}` : 'New Clinical Panel'}
            </DialogTitle>
            <DialogDescription>
              {editingPanel
                ? 'Update panel configuration, layout type, and test items.'
                : 'Define a new panel to group clinical tests with a specific layout.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-6">
            {/* ── Left Column: Configuration ─────────────────────────── */}
            <div className="flex-1 min-w-0 space-y-4">

              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Name *</Label>
                  <Input value={formName} onChange={e => setFormName(e.target.value)} />
                </div>
                <div>
                  <Label>Code *</Label>
                  <div className="relative">
                    <Input
                      value={formCode}
                      onChange={e => setFormCode(e.target.value.toUpperCase())}
                      className="font-mono pr-8"
                      disabled={!!editingPanel}
                    />
                    {!editingPanel && formCode.trim() && (
                      <span className="absolute right-2 top-2.5">
                        {codeChecking ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> :
                         !CODE_REGEX.test(formCode.trim()) ? <AlertCircle className="h-4 w-4 text-destructive" /> :
                         codeAvailable === true ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
                         codeAvailable === false ? <AlertCircle className="h-4 w-4 text-destructive" /> : null}
                      </span>
                    )}
                  </div>
                  {!editingPanel && formCode.trim() && !CODE_REGEX.test(formCode.trim()) && (
                    <p className="text-xs text-destructive mt-0.5">2-20 uppercase letters, digits, or underscores</p>
                  )}
                  {!editingPanel && codeAvailable === false && (
                    <p className="text-xs text-destructive mt-0.5">Code already in use</p>
                  )}
                </div>
                <div>
                  <Label>Layout Type</Label>
                  <Select value={formLayout} onValueChange={handleLayoutChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LAYOUT_TYPES.map(lt => (
                        <SelectItem key={lt.value} value={lt.value}>
                          {lt.label}
                          {lt.hint && <span className="text-muted-foreground ml-1 text-xs">({lt.hint})</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Department *</Label>
                  <Select value={formDeptId || '__none__'} onValueChange={v => setFormDeptId(v === '__none__' ? '' : v)}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Sample Type */}
              <div className="max-w-xs">
                <Label>Sample Type</Label>
                <Select value={formSampleType || '__none__'} onValueChange={v => setFormSampleType(v === '__none__' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="Select sample type..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {SAMPLE_TYPES.map(st => <SelectItem key={st} value={st}>{st}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Active */}
              <div className="flex items-center gap-2">
                <Switch checked={formActive} onCheckedChange={setFormActive} />
                <Label>Active</Label>
              </div>

              {/* ── Layout Configuration ─────────────────────────────── */}
              <div className="border rounded-lg p-3 bg-muted/30 space-y-3">
                <Label className="text-sm font-semibold">Layout Configuration</Label>
                <p className="text-xs text-muted-foreground -mt-1">
                  These flags control how the report renderer displays this panel.
                </p>

                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <div className="col-span-2 space-y-2 rounded-md border bg-background/80 p-3">
                    <div className="space-y-1">
                      <Label className="text-sm">Panel Method</Label>
                      <Input
                        value={formPanelMethodText}
                        onChange={e => setFormPanelMethodText(e.target.value)}
                        placeholder="Optional method shown below the panel title"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={formPanelMethodItalic}
                        onCheckedChange={setFormPanelMethodItalic}
                        disabled={!formPanelMethodText.trim()}
                      />
                      <Label className="text-sm">Italicize Panel Method</Label>
                    </div>
                  </div>
                  {supportsMethodColumn && (
                    <>
                      <div className="flex items-center gap-2">
                        <Switch checked={formShowMethod} onCheckedChange={setFormShowMethod} />
                        <Label className="text-sm">Show Method Column</Label>
                      </div>
                      {formShowMethod && formItems.length > 0 && !formItems.some(item => item.methodText) && (
                        <p className="text-xs text-amber-600 col-span-2">
                          No tests in this panel have methods configured
                        </p>
                      )}
                    </>
                  )}
                  {supportsSubgroups && (
                    <div className="flex items-center gap-2">
                      <Switch checked={formShowSubgroups} onCheckedChange={setFormShowSubgroups} />
                      <Label className="text-sm">Show Subgroups</Label>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Switch checked={formShowInterpretation} onCheckedChange={setFormShowInterpretation} />
                    <Label className="text-sm">Show Comments</Label>
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <Label className="text-sm shrink-0">Spaced Definitions Gap</Label>
                      <select
                        value={formSpacedDefinitionsGap}
                        onChange={(e) => setFormSpacedDefinitionsGap(parseInt(e.target.value, 10))}
                        className="h-7 text-xs border rounded w-20 px-1 bg-background"
                      >
                        <option value={0}>Off</option>
                        <option value={1}>1 Row Gap</option>
                        <option value={2}>2 Row Gap</option>
                        <option value={3}>3 Row Gap</option>
                      </select>
                    </div>
                  </div>
                  {supportsValuePrefix && (
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Label className="text-sm shrink-0">Value Prefix</Label>
                        <Input
                          value={formValuePrefix}
                          onChange={e => { if (e.target.value.length <= 5) setFormValuePrefix(e.target.value); }}
                          placeholder="Optional (e.g., 1:)"
                          className="h-7 text-xs w-32"
                          maxLength={5}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground pl-[86px]">
                        Max 5 chars. Prepended to values on report.
                      </p>
                    </div>
                  )}
                </div>

                {/* Subgroup list builder */}
                {formShowSubgroups && supportsSubgroups && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Defined Subgroups</Label>
                    <p className="text-[10px] text-muted-foreground -mt-1">
                      Define the subgroup names for this panel. Items below can be assigned to one of these groups.
                    </p>

                    {/* Enable Subgroup Methods toggle */}
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={formShowSubgroupMethods}
                        onCheckedChange={setFormShowSubgroupMethods}
                        className="scale-75"
                      />
                      <Label className="text-[11px] text-muted-foreground cursor-pointer" onClick={() => setFormShowSubgroupMethods(prev => !prev)}>
                        Enable Subgroup Methods
                      </Label>
                    </div>

                    {/* Chips */}
                    {formSubgroups.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        {formSubgroups.map(sg => {
                          const method = formSubgroupMethods[sg];
                          const keyValue = formSubgroupTableOverrides[sg] ?? false;
                          return (
                            <div key={sg} className="flex items-center gap-2">
                              <Badge variant="secondary" className="text-xs gap-1 pr-1 max-w-full">
                                <span className="font-semibold">{sg}</span>
                                {formShowSubgroupMethods && method && (
                                  <span className="text-muted-foreground font-normal truncate max-w-[140px]" title={method}>
                                    · {method}
                                  </span>
                                )}
                                <button
                                  onClick={() => removeSubgroup(sg)}
                                  className="text-red-400 hover:text-destructive ml-0.5 leading-none shrink-0"
                                >
                                  ×
                                </button>
                              </Badge>
                              <div className="flex items-center gap-1 shrink-0">
                                <Switch
                                  checked={keyValue}
                                  onCheckedChange={(val) =>
                                    setFormSubgroupTableOverrides(prev => ({ ...prev, [sg]: val }))
                                  }
                                  className="scale-[0.6]"
                                />
                                <span className={`text-[10px] ${keyValue ? 'text-green-600 font-medium' : 'text-muted-foreground'}`}>
                                  Key-value
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Input row */}
                    <div className="flex gap-1.5">
                      <Input
                        value={newSubgroupInput}
                        onChange={e => setNewSubgroupInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubgroup(); } }}
                        placeholder="e.g. Differential"
                        className="h-7 text-xs flex-1"
                      />
                      {formShowSubgroupMethods && (
                        <Input
                          value={newSubgroupMethodInput}
                          onChange={e => setNewSubgroupMethodInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubgroup(); } }}
                          placeholder="Method (optional)"
                          className="h-7 text-xs flex-1"
                        />
                      )}
                      <Button size="sm" variant="outline" onClick={addSubgroup} className="h-7 text-xs shrink-0" disabled={!newSubgroupInput.trim()}>
                        Add
                      </Button>
                    </div>

                    {formShowSubgroupMethods && (
                      <p className="text-[10px] text-muted-foreground -mt-1">
                        Method is optional. Displays as "Method : ..." under the subgroup header on the report.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Comments (rich text, default) + Advanced → Interpretation */}
              {formShowInterpretation && (
                <div className="space-y-3">
                  <div>
                    <Label>Comments</Label>
                    <RichTextNarrativeEditor
                      value={formComments}
                      onChange={setFormComments}
                      placeholder="Comments shown in a box below the results (same on every report)"
                      minHeightClassName="min-h-[140px]"
                      contentClassName="text-[12px] leading-[1.45] px-4 py-3"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormShowAdvanced(v => !v)}
                    className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                  >
                    <span className="text-xs w-3 inline-block">{formShowAdvanced ? '▾' : '▸'}</span>
                    Advanced
                  </button>
                  {formShowAdvanced && (
                    <div>
                      <Label>Interpretation</Label>
                      <RichTextNarrativeEditor
                        value={formInterpretation}
                        onChange={setFormInterpretation}
                        placeholder="Optional. Rendered above Comments on the report when filled."
                        minHeightClassName="min-h-[100px]"
                        contentClassName="text-[12px] leading-[1.45] px-4 py-3"
                      />
                    </div>
                  )}
                </div>
              )}

              {supportsRichTextTemplate(formLayout) && (
                <div className="space-y-2">
                  <Label>{formLayout === 'IMAGING_NARRATIVE' ? 'Imaging Narrative Template' : 'Text Result Template'}</Label>
                  <p className="text-xs text-muted-foreground">
                    Save the default rich-text report body here. It will appear automatically when users open Enter Test Results for this panel.
                  </p>
                  <RichTextNarrativeEditor
                    value={formNarrativeTemplateHtml}
                    onChange={setFormNarrativeTemplateHtml}
                    placeholder={
                      formLayout === 'IMAGING_NARRATIVE'
                        ? 'Create the default radiology narrative for this panel...'
                        : 'Create the default rich-text result template for this panel...'
                    }
                    minHeightClassName="min-h-[240px]"
                  />
                </div>
              )}

              <Separator />

              {/* ── Panel Items with DnD ──────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <Label className="text-sm font-semibold">Panel Test Items</Label>
                    {LAYOUT_MAX_ITEMS[formLayout] !== null && (
                      <span className="text-xs text-amber-600 ml-2">
                        (max {LAYOUT_MAX_ITEMS[formLayout]})
                      </span>
                    )}
                  </div>
                  <Button size="sm" variant="outline" onClick={addItem} disabled={!canAddItem}>
                    <Plus className="h-3 w-3 mr-1" /> Add Test
                  </Button>
                </div>

                {layoutItemConstraintMessage && (
                  <p className="mb-2 text-xs text-amber-600">
                    {layoutItemConstraintMessage}
                  </p>
                )}

                {formItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded">
                    {(formLayout === 'TEXT_ONLY' || formLayout === 'IMAGING_NARRATIVE')
                      ? 'Add exactly one backing clinical test item to store this panel result.'
                      : 'Add clinical tests to this panel.'}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {formItems.map((item, i) => {
                      const isExpanded = expandedItems.has(i);
                      const defLabel = item.testDefinition
                        ? `${item.testDefinition.code} \u2013 ${item.testDefinition.name}`
                        : availableDefs.find(d => d.id === item.testDefinitionId)
                          ? `${availableDefs.find(d => d.id === item.testDefinitionId)!.code} \u2013 ${availableDefs.find(d => d.id === item.testDefinitionId)!.name}`
                          : null;
                      return (
                        <div
                          key={i}
                          className={[
                            'border rounded transition-colors',
                            dragIdx === i ? 'opacity-40' : '',
                            dragOverIdx === i && dragIdx !== i ? 'border-blue-400 bg-blue-50/50' : '',
                          ].join(' ')}
                          draggable
                          onDragStart={handleDragStart(i)}
                          onDragOver={handleDragOver(i)}
                          onDrop={handleDrop(i)}
                          onDragEnd={handleDragEnd}
                        >
                          {/* Main row */}
                          <div className="flex items-center gap-2 p-2">
                            <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab shrink-0" />
                            <button
                              onClick={() => toggleExpand(i)}
                              className="text-muted-foreground hover:text-foreground shrink-0"
                            >
                              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                            <Select
                              value={item.testDefinitionId}
                              onValueChange={v => updateItem(i, 'testDefinitionId', v)}
                            >
                              <SelectTrigger className="flex-1 h-8 text-xs">
                                <SelectValue placeholder="Select test definition..." />
                              </SelectTrigger>
                              <SelectContent>
                                {availableDefs.map(d => (
                                  <SelectItem key={d.id} value={d.id}>
                                    {d.code} \u2013 {d.name} (v{d.version})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {/* Inline badges */}
                            {item.subGroup && (
                              <Badge variant="outline" className="text-[10px] shrink-0">{item.subGroup}</Badge>
                            )}
                            {(item.isBold || item.isItalic) && (
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                {item.isBold && !item.isItalic ? 'Header' : 'Emphasis'}
                              </Badge>
                            )}
                            {item.indentLevel > 0 && <span className="text-[10px] text-muted-foreground shrink-0">\u21e5{item.indentLevel}</span>}
                            <Button size="sm" variant="ghost" onClick={() => removeItem(i)} className="text-destructive shrink-0 h-7 w-7 p-0">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          {/* Expanded: per-item display controls */}
                          {isExpanded && (
                            <div className="px-3 pb-3 pt-1 border-t bg-muted/20">
                              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                {/* Subgroup */}
                                {formShowSubgroups && supportsSubgroups && (
                                  <div>
                                    <Label className="text-xs">Subgroup</Label>
                                    <Select
                                      value={item.subGroup || '__none__'}
                                      onValueChange={v => updateItem(i, 'subGroup', v === '__none__' ? null : v)}
                                    >
                                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">None</SelectItem>
                                        {formSubgroups.map(sg => (
                                          <SelectItem key={sg} value={sg}>{sg}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                )}
                                {/* Indent Level */}
                                <div>
                                  <Label className="text-xs">Indent Level</Label>
                                  <Select
                                    value={String(item.indentLevel ?? 0)}
                                    onValueChange={v => updateItem(i, 'indentLevel', parseInt(v))}
                                  >
                                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      {[0, 1, 2, 3].map(n => (
                                        <SelectItem key={n} value={String(n)}>{n === 0 ? 'None' : `Level ${n}`}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                {/* Display Style */}
                                <div>
                                  <Label className="text-xs">Display Style</Label>
                                  <Select
                                    value={getDisplayStyle(item)}
                                    onValueChange={v => setItemDisplayStyle(i, v)}
                                  >
                                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="normal">Normal</SelectItem>
                                      <SelectItem value="emphasis">Emphasis (italic)</SelectItem>
                                      <SelectItem value="section-header">Section Header (bold)</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                {/* Row */}
                                {i > 0 && (
                                  <div>
                                    <Label className="text-xs">Row</Label>
                                    <Select
                                      value={item.joinPrevious ? 'continue' : 'new'}
                                      onValueChange={v => updateItem(i, 'joinPrevious', v === 'continue')}
                                    >
                                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="new">New row</SelectItem>
                                        <SelectItem value="continue">Continue row above</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                )}
                                {/* Width */}
                                <div>
                                  <Label className="text-xs">Width</Label>
                                  <Select
                                    value={item.gridWidth == null ? 'auto' : String(item.gridWidth)}
                                    onValueChange={v => updateItem(i, 'gridWidth', v === 'auto' ? null : parseInt(v))}
                                  >
                                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="auto">Auto</SelectItem>
                                      <SelectItem value="3">Quarter (1/4)</SelectItem>
                                      <SelectItem value="4">Third (1/3)</SelectItem>
                                      <SelectItem value="6">Half (1/2)</SelectItem>
                                      <SelectItem value="8">Two thirds</SelectItem>
                                      <SelectItem value="12">Full</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                {/* Per-item Method */}
                                {formShowMethod && (
                                  <div className="col-span-2">
                                    <div className="flex items-center gap-2">
                                      <Switch
                                        checked={item.showMethod}
                                        onCheckedChange={v => updateItem(i, 'showMethod', v)}
                                      />
                                      <Label className="text-xs">Show Method</Label>
                                      {item.showMethod && (
                                        <Input
                                          value={item.methodText || ''}
                                          onChange={e => updateItem(i, 'methodText', e.target.value || null)}
                                          className="h-7 text-xs flex-1"
                                          placeholder="Method text override"
                                        />
                                      )}
                                    </div>
                                  </div>
                                )}

                                {/* Value Input — presets / default / input type */}
                                {item.testDefinition?.rootDefinitionId && (
                                  <div className="col-span-2 flex items-start gap-3 pt-1 mt-1 border-t">
                                    <div className="space-y-0.5 flex-1 min-w-0">
                                      <Label className="text-xs">Value Input</Label>
                                      <p className="text-[11px] text-muted-foreground truncate">
                                        {summarizeInputConfig(
                                          inputConfigs[item.testDefinition.rootDefinitionId]
                                        )}
                                      </p>
                                    </div>
                                    <ValueInputConfigPopover
                                      rootDefinitionId={item.testDefinition.rootDefinitionId}
                                      testLabel={item.testDefinition.name}
                                      cached={inputConfigs[item.testDefinition.rootDefinitionId]}
                                      authHeaders={headers}
                                      onSaved={(cfg) =>
                                        setInputConfigs((prev) => ({
                                          ...prev,
                                          [cfg.rootDefinitionId]: cfg,
                                        }))
                                      }
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>

            {/* ── Right Column: Live Preview ─────────────────────────── */}
            <div className="w-[360px] shrink-0 hidden lg:block">
              <div className="sticky top-0 space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-1.5">
                  <Eye className="h-3.5 w-3.5" /> Live Preview
                </Label>
                <p className="text-xs text-muted-foreground">
                  Shows how this panel will render on reports. Updates live as you change configuration.
                </p>
                <div className="border rounded-lg bg-white p-3 text-xs shadow-sm">
                  {/* Panel header */}
                  <div className="font-bold text-sm border-b pb-1 mb-2">
                    {formName || 'Panel Name'}
                    {renderPanelMethodPreview(formPanelMethodText, formPanelMethodItalic)}
                  </div>

                  {/* Layout-specific preview */}
                  {(formLayout === 'TEXT_ONLY' || formLayout === 'IMAGING_NARRATIVE') ? (
                    <div className="space-y-2">
                      {formItems.length > 0 ? (
                        <div>
                          <div className="font-medium text-xs mb-1">
                            {availableDefs.find(d => d.id === formItems[0]?.testDefinitionId)?.name || 'Test Name'}
                          </div>
                          <div className="min-h-[96px] rounded border border-dashed bg-muted p-3 text-[11px] text-foreground">
                            {hasMeaningfulRichText(formNarrativeTemplateHtml) ? (
                              <div
                                className="rich-text-preview"
                                dangerouslySetInnerHTML={{
                                  __html: sanitizeRichTextHtml(formNarrativeTemplateHtml),
                                }}
                              />
                            ) : (
                              <div className="italic text-muted-foreground">
                                {formLayout === 'IMAGING_NARRATIVE'
                                  ? 'Narrative text will appear here...'
                                  : 'Text result template will appear here...'}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-center py-4">Add exactly one backing test item</p>
                      )}
                    </div>
                  ) : formLayout === 'PROCEDURE_STRUCTURED' ? (
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-1 font-semibold">PARAMETER</th>
                          <th className="text-left py-1 font-semibold">RESULT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {formItems.length > 0 ? formItems.map((item, i) => {
                          const td = availableDefs.find(d => d.id === item.testDefinitionId);
                          const method = item.showMethod ? (item.methodText || td?.method || null) : null;
                          return (
                            <tr key={i} className="border-b border-dashed">
                              <td className="align-top">
                                {renderPreviewLabel(td?.name, {
                                  isBold: item.isBold,
                                  isItalic: item.isItalic,
                                  method,
                                })}
                              </td>
                              <td className="py-1 text-muted-foreground">\u2014</td>
                            </tr>
                          );
                        }) : (
                          <tr><td colSpan={2} className="text-center py-4 text-muted-foreground">No items</td></tr>
                        )}
                      </tbody>
                    </table>
                  ) : (
                    /* STANDARD_TABLE */
                    <>
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-1 font-semibold">TEST</th>
                            <th className="text-left py-1 font-semibold">VALUE</th>
                            <th className="text-left py-1 font-semibold">UNIT</th>
                            <th className="text-left py-1 font-semibold">REFERENCE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {formItems.length > 0 ? (() => {
                            const colCount = 4;
                            // Group consecutive items into runs (joinPrevious=true continues the previous run)
                            const partitionRuns = (items: typeof formItems): typeof formItems[] => {
                              const runs: typeof formItems[] = [];
                              for (const it of items) {
                                if (!it.joinPrevious || runs.length === 0) runs.push([it]);
                                else runs[runs.length - 1].push(it);
                              }
                              return runs;
                            };
                            const renderSingleItemRow = (item: typeof formItems[number], key: string) => {
                              const td = availableDefs.find(d => d.id === item.testDefinitionId);
                              const method = item.showMethod ? (item.methodText || td?.method || null) : null;
                              return (
                                <tr key={key} className="border-b border-dashed">
                                  <td className="align-top">
                                    {renderPreviewLabel(td?.name, {
                                      isBold: item.isBold,
                                      isItalic: item.isItalic,
                                      method,
                                      paddingLeft: (item.indentLevel || 0) * 12,
                                    })}
                                  </td>
                                  <td className="py-1 text-muted-foreground">{formValuePrefix}\u2014</td>
                                  <td className="py-1 text-muted-foreground">{td?.referenceUnit || '\u2014'}</td>
                                  <td className="py-1 text-muted-foreground">{td?.referenceText || (td?.referenceMin != null && td?.referenceMax != null ? `${td.referenceMin}\u2013${td.referenceMax}` : '\u2014')}</td>
                                </tr>
                              );
                            };
                            const renderGridRow = (run: typeof formItems, key: string) => (
                              <tr key={key} className="border-b border-dashed">
                                <td colSpan={colCount} className="py-1.5">
                                  <div className="flex items-baseline gap-4">
                                    {run.map((item, j) => {
                                      const td = availableDefs.find(d => d.id === item.testDefinitionId);
                                      const flexStyle = item.gridWidth ? { flex: `${item.gridWidth} 0 0` } : { flex: '1 0 0' };
                                      return (
                                        <div key={j} className="flex items-baseline gap-1.5 min-w-0" style={flexStyle}>
                                          <span className={`truncate ${item.isBold ? 'font-semibold' : ''}`}>{td?.name || 'Test'}</span>
                                          <span className="text-muted-foreground">:</span>
                                          <span className="text-muted-foreground">{formValuePrefix}\u2014</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </td>
                              </tr>
                            );
                            const renderRuns = (items: typeof formItems, keyPrefix: string) => {
                              const runs = partitionRuns(items).map((run, idx) =>
                                run.length === 1
                                  ? renderSingleItemRow(run[0], `${keyPrefix}-${idx}`)
                                  : renderGridRow(run, `${keyPrefix}-${idx}`)
                              );
                              if (formSpacedDefinitionsGap > 0 && runs.length > 1) {
                                const interleaved = [];
                                for (let i = 0; i < runs.length; i++) {
                                  interleaved.push(runs[i]);
                                  if (i < runs.length - 1) {
                                    interleaved.push(
                                      <tr key={`${keyPrefix}-gap-${i}`}>
                                        <td colSpan={4} style={{ padding: 0, border: 'none' }}>
                                          <div style={{ height: `${formSpacedDefinitionsGap * 1.5}em` }}></div>
                                        </td>
                                      </tr>
                                    );
                                  }
                                }
                                return interleaved;
                              }
                              return runs;
                            };

                            if (formShowSubgroups) {
                              // Group by subGroup
                              const groups: Record<string, typeof formItems> = {};
                              formItems.forEach(item => {
                                const g = item.subGroup || '';
                                if (!groups[g]) groups[g] = [];
                                groups[g].push(item);
                              });
                              return Object.entries(groups).map(([group, items]) => (
                                <Fragment key={group || '__none'}>
                                  {group && (
                                    <tr>
                                      <td colSpan={colCount} className="py-1 font-bold bg-muted text-[10px] uppercase tracking-wide">
                                        {group}
                                      </td>
                                    </tr>
                                  )}
                                  {group && formSubgroupMethods[group] && (
                                    <tr>
                                      <td colSpan={colCount} className="py-0.5 text-[9px] italic text-muted-foreground pl-3">
                                        Method : {formSubgroupMethods[group]}
                                      </td>
                                    </tr>
                                  )}
                                  {renderRuns(items, group || '__none')}
                                </Fragment>
                              ));
                            }
                            // Flat list
                            return renderRuns(formItems, 'flat');
                          })() : (
                            <tr>
                              <td colSpan={4} className="text-center py-4 text-muted-foreground">
                                No items
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </>
                  )}

                  {/* Comments / Interpretation preview — all layouts */}
                  {formShowInterpretation && (hasMeaningfulRichText(formInterpretation) || hasMeaningfulRichText(formComments)) && (
                    <div className="mt-2 pt-2 border-t space-y-2">
                      {hasMeaningfulRichText(formInterpretation) && (
                        <div>
                          <div className="font-semibold text-[11px]">INTERPRETATION:</div>
                          <div className="rich-text-preview text-[12px] leading-[1.45] mt-1" dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(formInterpretation) }} />
                        </div>
                      )}
                      {hasMeaningfulRichText(formComments) && (
                        <div>
                          <div className="font-semibold text-[11px]">COMMENTS:</div>
                          <div className="rich-text-preview text-[12px] leading-[1.45] mt-1" dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(formComments) }} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Layout type indicator */}
                  <div className="mt-3 pt-2 border-t flex items-center gap-1.5">
                    <Badge className={[layoutBadge(formLayout), 'text-[10px]'].join(' ')}>
                      {formLayout.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {formItems.length} item{formItems.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editingPanel ? 'Update Panel' : 'Create Panel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Saved Panel Preview Dialog ─────────────────────────────────── */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Eye className="h-4 w-4" /> Panel Preview</DialogTitle>
            <DialogDescription>Report rendering preview with mock values</DialogDescription>
          </DialogHeader>
          {previewData ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><strong>Panel:</strong> {previewData.panel?.displayName || previewData.panel?.name}</div>
                <div><strong>Layout:</strong> <Badge className={layoutBadge(previewData.panel?.layoutType)}>{previewData.panel?.layoutType?.replace(/_/g, ' ')}</Badge></div>
                <div><strong>Department:</strong> {previewData.department?.name || '\u2014'}</div>
                <div><strong>Inline Methods:</strong> {previewData.panel?.showMethodColumn ? 'Enabled' : 'Off'}</div>
                <div className="col-span-2">
                  <strong>Panel Method:</strong> {previewData.panel?.panelMethodText || '\u2014'}
                  {previewData.panel?.panelMethodText && previewData.panel?.panelMethodItalic ? ' (italic)' : ''}
                </div>
                {supportsRichTextTemplate(previewData.panel?.layoutType) && (
                  <div className="col-span-2">
                    <strong>Template:</strong> {hasMeaningfulRichText(previewData.panel?.narrativeTemplateHtml) ? 'Configured' : '\u2014'}
                  </div>
                )}
              </div>
              <Separator />
              {/* Render mock table matching the layout */}
              <div className="border rounded p-3 bg-white">
                <div className="font-bold text-sm border-b pb-1 mb-2">
                  {previewData.panel?.displayName || previewData.panel?.name}
                  {renderPanelMethodPreview(previewData.panel?.panelMethodText, !!previewData.panel?.panelMethodItalic)}
                </div>
                {(previewData.panel?.layoutType === 'TEXT_ONLY' || previewData.panel?.layoutType === 'IMAGING_NARRATIVE') ? (
                  <div className="space-y-2 text-xs">
                    {previewData.tests?.length ? (
                      <>
                        <div className="font-medium">{previewData.tests[0]?.name || 'Test Name'}</div>
                        <div className="min-h-[96px] rounded border border-dashed bg-muted p-3 text-foreground">
                          {hasMeaningfulRichText(previewData.panel?.narrativeTemplateHtml) ? (
                            <div
                              className="rich-text-preview"
                              dangerouslySetInnerHTML={{
                                __html: sanitizeRichTextHtml(previewData.panel?.narrativeTemplateHtml),
                              }}
                            />
                          ) : (
                            <div className="italic text-muted-foreground">
                              {previewData.panel?.layoutType === 'IMAGING_NARRATIVE'
                                ? 'Narrative text will appear here...'
                                : 'Text result template will appear here...'}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="py-4 text-center text-muted-foreground">No backing test item configured</p>
                    )}
                  </div>
                ) : previewData.panel?.layoutType === 'PROCEDURE_STRUCTURED' ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-1">PARAMETER</th>
                        <th className="text-left py-1">RESULT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewData.tests?.map((test: any, i: number) => (
                        <tr key={i} className="border-b border-dashed">
                          <td className="align-top">
                            {renderPreviewLabel(test.name, {
                              isBold: test.isBold,
                              isItalic: test.isItalic,
                              method: test.method,
                              paddingLeft: (test.indentLevel || 0) * 12,
                              bodyClassName: 'py-1 text-xs',
                            })}
                          </td>
                          <td className="py-1 text-muted-foreground">\u2014</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-1">TEST</th>
                        <th className="text-left py-1">VALUE</th>
                        <th className="text-left py-1">UNIT</th>
                        <th className="text-left py-1">REFERENCE RANGE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewData.tests?.map((test: any, i: number) => {
                        const gap = previewData.panel?.spacedDefinitionsGap || 0;
                        const isSameSubgroup = i > 0 && test.subGroup === previewData.tests[i - 1]?.subGroup;
                        const shouldAddGap = gap > 0 && isSameSubgroup && !test.joinPrevious;
                        
                        return (
                          <Fragment key={i}>
                            {shouldAddGap && (
                              <tr>
                                <td colSpan={4} style={{ padding: 0, border: 'none' }}>
                                  <div style={{ height: `${gap * 1.5}em` }}></div>
                                </td>
                              </tr>
                            )}
                            {test.subGroup && (i === 0 || test.subGroup !== previewData.tests[i - 1]?.subGroup) && (
                              <tr>
                                <td colSpan={4} className="py-1 font-bold bg-muted text-[10px] uppercase tracking-wide">
                                  {test.subGroup}
                                </td>
                              </tr>
                            )}
                          <tr className="border-b border-dashed">
                            <td className="align-top">
                              {renderPreviewLabel(test.name, {
                                isBold: test.isBold,
                                isItalic: test.isItalic,
                                method: test.method,
                                paddingLeft: (test.indentLevel || 0) * 12,
                                bodyClassName: 'py-1 text-xs',
                              })}
                            </td>
                            <td className="py-1 text-muted-foreground">\u2014</td>
                            <td className="py-1 text-muted-foreground">{test.referenceUnit || '\u2014'}</td>
                            <td className="py-1 text-muted-foreground">{test.referenceText || (test.referenceMin != null && test.referenceMax != null ? `${test.referenceMin}\u2013${test.referenceMax}` : '\u2014')}</td>
                          </tr>
                        </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              {(hasMeaningfulRichText((previewData.panel as any)?.interpretation) || hasMeaningfulRichText((previewData.panel as any)?.comments)) && (
                <div className="space-y-2">
                  {hasMeaningfulRichText((previewData.panel as any)?.interpretation) && (
                    <div>
                      <strong>Interpretation:</strong>
                      <div className="rich-text-preview mt-1 p-2 bg-muted rounded text-[12px] leading-[1.45]" dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml((previewData.panel as any)?.interpretation) }} />
                    </div>
                  )}
                  {hasMeaningfulRichText((previewData.panel as any)?.comments) && (
                    <div>
                      <strong>Comments:</strong>
                      <div className="rich-text-preview mt-1 p-2 bg-muted rounded text-[12px] leading-[1.45]" dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml((previewData.panel as any)?.comments) }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">No preview available</p>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation Dialog ──────────────────────────────────── */}
      <Dialog open={!!deleteConfirm} onOpenChange={open => { if (!open) setDeleteConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Panel</DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete <strong>{deleteConfirm?.name}</strong>?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
