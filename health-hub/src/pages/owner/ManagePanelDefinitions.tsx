import { useState, useEffect, useCallback, Fragment, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Search, Eye, LayoutGrid, GripVertical, Trash2,
  ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
  summaryInterpretationTemplate: string | null;
  subgroupMethods: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  department?: { id: string; name: string } | null;
  items: ClinicalPanelItem[];
  itemCount?: number;
}

const LAYOUT_TYPES = [
  { value: 'STANDARD_TABLE', label: 'Standard Table – configurable test table', hint: '', color: 'bg-blue-100 text-blue-800' },
  { value: 'TEXT_ONLY', label: 'Text Only – free text result', hint: 'Max 1 item', color: 'bg-gray-100 text-gray-800' },
  { value: 'IMAGING_NARRATIVE', label: 'Imaging Narrative – radiology reports', hint: '', color: 'bg-purple-100 text-purple-800' },
  { value: 'PROCEDURE_STRUCTURED', label: 'Procedure Structured – procedure reports', hint: '', color: 'bg-amber-100 text-amber-800' },
];

function layoutBadge(layoutType: string) {
  const lt = LAYOUT_TYPES.find(l => l.value === layoutType);
  return lt ? lt.color : 'bg-gray-100 text-gray-800';
}

const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

const SAMPLE_TYPES = ['WB-EDTA', 'Serum', 'Plasma', 'Urine', 'CSF', 'Synovial Fluid', 'Other'];

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
  const [formTemplate, setFormTemplate] = useState('');
  const [formItems, setFormItems] = useState<ClinicalPanelItem[]>([]);

  // Code validation
  const [codeAvailable, setCodeAvailable] = useState<boolean | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);
  const codeCheckTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Layout config flags
  const [formShowMethod, setFormShowMethod] = useState(false);
  const [formShowSubgroups, setFormShowSubgroups] = useState(false);
  const [formShowInterpretation, setFormShowInterpretation] = useState(false);
  const [formValuePrefix, setFormValuePrefix] = useState('');

  // Drag-and-drop
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Expanded items (for per-item display controls)
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  // Subgroup management (panel-level defined groups)
  const [formSubgroups, setFormSubgroups] = useState<string[]>([]);
  const [newSubgroupInput, setNewSubgroupInput] = useState('');
  const [formSubgroupMethods, setFormSubgroupMethods] = useState<Record<string, string>>({});
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
    const sg = newSubgroupInput.trim().toUpperCase();
    if (!sg) return;
    if (formSubgroups.includes(sg)) { toast.error('Subgroup already exists'); return; }
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
    setFormSampleType(''); setFormActive(true); setFormTemplate(''); setFormItems([]);
    setFormShowMethod(false); setFormShowSubgroups(false);
    setFormShowInterpretation(false); setFormValuePrefix('');
    setFormSubgroups([]); setNewSubgroupInput('');
    setFormSubgroupMethods({}); setFormShowSubgroupMethods(false); setNewSubgroupMethodInput('');
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
    setFormTemplate(p.summaryInterpretationTemplate || '');
    setFormShowMethod(p.showMethodColumn ?? false);
    setFormShowSubgroups(p.showSubgroups ?? false);
    setFormShowInterpretation(p.showInterpretation ?? false);
    setFormValuePrefix(p.valueDisplayPrefix || '');
    const items = (p.items || []).map(item => ({
      testDefinitionId: item.testDefinitionId,
      displayOrder: item.displayOrder,
      showMethod: item.showMethod ?? false,
      methodText: item.methodText ?? item.testDefinition?.method ?? null,
      indentLevel: item.indentLevel ?? 0,
      isBold: item.isBold ?? false,
      isItalic: item.isItalic ?? false,
      subGroup: item.subGroup ?? null,
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
        valueDisplayPrefix: formValuePrefix || null,
        summaryInterpretationTemplate: formTemplate || null,
        subgroupMethods: (() => {
          // Filter out empty method strings
          const filtered = Object.fromEntries(
            Object.entries(formSubgroupMethods).filter(([, v]) => v.trim())
          );
          return Object.keys(filtered).length > 0 ? filtered : null;
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
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      ) : panels.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">No panels found</div>
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
                    <Badge className={panel.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}>
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
                      <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(panel)} title="Delete panel" className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50">
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
                         !CODE_REGEX.test(formCode.trim()) ? <AlertCircle className="h-4 w-4 text-red-500" /> :
                         codeAvailable === true ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
                         codeAvailable === false ? <AlertCircle className="h-4 w-4 text-red-500" /> : null}
                      </span>
                    )}
                  </div>
                  {!editingPanel && formCode.trim() && !CODE_REGEX.test(formCode.trim()) && (
                    <p className="text-xs text-red-500 mt-0.5">2-20 uppercase letters, digits, or underscores</p>
                  )}
                  {!editingPanel && codeAvailable === false && (
                    <p className="text-xs text-red-500 mt-0.5">Code already in use</p>
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
                    <Label className="text-sm">Show Interpretation</Label>
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
                      <div className="flex flex-wrap gap-1.5">
                        {formSubgroups.map(sg => {
                          const method = formSubgroupMethods[sg];
                          return (
                            <Badge key={sg} variant="secondary" className="text-xs gap-1 pr-1 max-w-full">
                              <span className="font-semibold">{sg}</span>
                              {formShowSubgroupMethods && method && (
                                <span className="text-muted-foreground font-normal truncate max-w-[140px]" title={method}>
                                  · {method}
                                </span>
                              )}
                              <button
                                onClick={() => removeSubgroup(sg)}
                                className="text-red-400 hover:text-red-600 ml-0.5 leading-none shrink-0"
                              >
                                ×
                              </button>
                            </Badge>
                          );
                        })}
                      </div>
                    )}

                    {/* Input row */}
                    <div className="flex gap-1.5">
                      <Input
                        value={newSubgroupInput}
                        onChange={e => setNewSubgroupInput(e.target.value.toUpperCase())}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubgroup(); } }}
                        placeholder="e.g. DIFFERENTIAL"
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

              {/* Summary Interpretation Template */}
              {formShowInterpretation && (
                <div>
                  <Label>Summary Interpretation Template</Label>
                  <Textarea
                    value={formTemplate}
                    onChange={e => setFormTemplate(e.target.value)}
                    placeholder="Use {{TEST_CODE}} placeholders for dynamic values"
                    rows={2}
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

                {formItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded">
                    Add clinical tests to this panel.
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
                            <Button size="sm" variant="ghost" onClick={() => removeItem(i)} className="text-red-500 shrink-0 h-7 w-7 p-0">
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
                  </div>

                  {/* Layout-specific preview */}
                  {(formLayout === 'TEXT_ONLY' || formLayout === 'IMAGING_NARRATIVE') ? (
                    <div className="space-y-2">
                      {formItems.length > 0 ? (
                        <div>
                          <div className="font-medium text-xs mb-1">
                            {availableDefs.find(d => d.id === formItems[0]?.testDefinitionId)?.name || 'Test Name'}
                          </div>
                          <div className="border border-dashed rounded p-2 text-muted-foreground italic text-[11px] min-h-[40px]">
                            {formLayout === 'IMAGING_NARRATIVE' ? 'Narrative text will appear here...' : 'Free text result...'}
                          </div>
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-center py-4">Add a test item</p>
                      )}
                    </div>
                  ) : formLayout === 'PROCEDURE_STRUCTURED' ? (
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-1 font-semibold">PARAMETER</th>
                          <th className="text-left py-1 font-semibold">RESULT</th>
                          {formShowMethod && <th className="text-left py-1 font-semibold">METHOD</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {formItems.length > 0 ? formItems.map((item, i) => {
                          const td = availableDefs.find(d => d.id === item.testDefinitionId);
                          return (
                            <tr key={i} className="border-b border-dashed">
                              <td className={['py-1', item.isBold ? 'font-bold' : '', item.isItalic ? 'italic' : ''].join(' ')}>
                                {td?.name || '\u2014'}
                              </td>
                              <td className="py-1 text-muted-foreground">\u2014</td>
                              {formShowMethod && <td className="py-1 text-muted-foreground">{item.showMethod ? (item.methodText || '\u2014') : ''}</td>}
                            </tr>
                          );
                        }) : (
                          <tr><td colSpan={formShowMethod ? 3 : 2} className="text-center py-4 text-muted-foreground">No items</td></tr>
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
                            {formShowMethod && <th className="text-left py-1 font-semibold">METHOD</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {formItems.length > 0 ? (() => {
                            const colCount = 4 + (formShowMethod ? 1 : 0);
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
                                      <td colSpan={colCount} className="py-1 font-bold bg-gray-50 text-[10px] uppercase tracking-wide">
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
                                  {items.map((item, j) => {
                                    const td = availableDefs.find(d => d.id === item.testDefinitionId);
                                    return (
                                      <tr key={j} className="border-b border-dashed">
                                        <td
                                          className={['py-1', item.isBold ? 'font-bold' : '', item.isItalic ? 'italic' : ''].join(' ')}
                                          style={{ paddingLeft: (item.indentLevel || 0) * 12 }}
                                        >
                                          {td?.name || '\u2014'}
                                        </td>
                                        <td className="py-1 text-muted-foreground">{formValuePrefix}\u2014</td>
                                        <td className="py-1 text-muted-foreground">{td?.referenceUnit || '\u2014'}</td>
                                        <td className="py-1 text-muted-foreground">{td?.referenceText || (td?.referenceMin != null && td?.referenceMax != null ? `${td.referenceMin}\u2013${td.referenceMax}` : '\u2014')}</td>
                                        {formShowMethod && <td className="py-1 text-muted-foreground">{item.showMethod ? (item.methodText || '\u2014') : ''}</td>}
                                      </tr>
                                    );
                                  })}
                                </Fragment>
                              ));
                            }
                            // Flat list
                            return formItems.map((item, i) => {
                              const td = availableDefs.find(d => d.id === item.testDefinitionId);
                              return (
                                <tr key={i} className="border-b border-dashed">
                                  <td
                                    className={['py-1', item.isBold ? 'font-bold' : '', item.isItalic ? 'italic' : ''].join(' ')}
                                    style={{ paddingLeft: (item.indentLevel || 0) * 12 }}
                                  >
                                    {td?.name || '\u2014'}
                                  </td>
                                  <td className="py-1 text-muted-foreground">{formValuePrefix}\u2014</td>
                                  <td className="py-1 text-muted-foreground">{td?.referenceUnit || '\u2014'}</td>
                                  <td className="py-1 text-muted-foreground">{td?.referenceText || (td?.referenceMin != null && td?.referenceMax != null ? `${td.referenceMin}\u2013${td.referenceMax}` : '\u2014')}</td>
                                  {formShowMethod && <td className="py-1 text-muted-foreground">{item.showMethod ? (item.methodText || '\u2014') : ''}</td>}
                                </tr>
                              );
                            });
                          })() : (
                            <tr>
                              <td colSpan={4 + (formShowMethod ? 1 : 0)} className="text-center py-4 text-muted-foreground">
                                No items
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                      {formShowInterpretation && (
                        <div className="mt-2 pt-2 border-t">
                          <div className="font-semibold text-[11px]">Interpretation:</div>
                          <p className="text-muted-foreground italic text-[10px] mt-0.5">
                            {formTemplate || 'Interpretation text will appear here based on results...'}
                          </p>
                        </div>
                      )}
                    </>
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
                <div><strong>Method Col:</strong> {previewData.panel?.showMethodColumn ? 'Yes' : 'No'}</div>
              </div>
              <Separator />
              {/* Render mock table matching the layout */}
              <div className="border rounded p-3 bg-white">
                <div className="font-bold text-sm border-b pb-1 mb-2">{previewData.panel?.displayName || previewData.panel?.name}</div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-1">TEST</th>
                      <th className="text-left py-1">VALUE</th>
                      <th className="text-left py-1">UNIT</th>
                      <th className="text-left py-1">REFERENCE RANGE</th>
                      {previewData.panel?.showMethodColumn && <th className="text-left py-1">METHOD</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.tests?.map((test: any, i: number) => (
                      <Fragment key={i}>
                        {test.subGroup && (i === 0 || test.subGroup !== previewData.tests[i-1]?.subGroup) && (
                          <tr>
                            <td colSpan={previewData.panel?.showMethodColumn ? 5 : 4} className="py-1 font-bold bg-gray-50 text-[10px] uppercase tracking-wide">
                              {test.subGroup}
                            </td>
                          </tr>
                        )}
                        <tr className="border-b border-dashed">
                          <td className={['py-1', test.isBold ? 'font-bold' : '', test.isItalic ? 'italic' : ''].join(' ')} style={{ paddingLeft: (test.indentLevel || 0) * 12 }}>
                            {test.name}
                          </td>
                          <td className="py-1 text-muted-foreground">\u2014</td>
                          <td className="py-1 text-muted-foreground">{test.referenceUnit || '\u2014'}</td>
                          <td className="py-1 text-muted-foreground">{test.referenceText || (test.referenceMin != null && test.referenceMax != null ? `${test.referenceMin}\u2013${test.referenceMax}` : '\u2014')}</td>
                          {previewData.panel?.showMethodColumn && <td className="py-1 text-muted-foreground">{test.method || '\u2014'}</td>}
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              {previewData.panel?.summaryInterpretationTemplate && (
                <div>
                  <strong>Interpretation Template:</strong>
                  <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap">
                    {previewData.panel.summaryInterpretationTemplate}
                  </pre>
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
