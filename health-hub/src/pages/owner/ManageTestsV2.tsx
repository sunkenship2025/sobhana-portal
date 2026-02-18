import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Search, ChevronDown, ChevronRight,
  X, FlaskConical, Calculator, ListOrdered, AlertTriangle, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/* ───────── Types ───────── */

interface Department { id: string; name: string }

interface StockRequirement {
  id: string;
  stockItemId: string;
  quantityPerTest: number;
  stockItem: { id: string; name: string; unit: string };
}

interface StockItem { id: string; name: string; unit: string }

interface DerivedParam {
  id: string;
  parameterName: string;
  formula: string;
  dependsOnTestCodes: string[];
  displayOrder: number;
}

interface AgeRange {
  id: string;
  minAgeDays: number | null;
  maxAgeDays: number | null;
  gender: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
}

interface PanelDef {
  id: string;
  name: string;
  displayName: string;
  layoutType: string;
  showMethodColumn: boolean;
  departmentId: string;
}

interface PanelTestItem {
  id: string;
  testId: string;
  displayOrder: number;
  indentLevel: number;
  isBold: boolean;
  subGroup: string | null;
  showMethod: boolean;
  test: { id: string; name: string; code: string };
}

interface LabTestItem {
  id: string;
  name: string;
  code: string;
  priceInPaise: number;
  isPanel: boolean;
  isActive: boolean;
  displayOrder: number;
  sampleType: string | null;
  method: string | null;
  departmentId: string | null;
  department: Department | null;
  referenceRange: {
    min: number | null;
    max: number | null;
    unit: string;
    text: string;
  };
  _count?: { ageRanges: number; stockRequirements: number; interpretations: number };
}

/* ───────── Constants ───────── */

const SAMPLE_TYPES = [
  'EDTA_BLOOD', 'SERUM', 'CITRATE_BLOOD', 'URINE', 'STOOL',
  'CSF', 'SPUTUM', 'SWAB', 'OTHER',
];

const LAYOUT_TYPES = [
  'STANDARD_TABLE', 'CBP', 'WIDAL', 'INTERPRETATION_SINGLE', 'TEXT_ONLY',
];

const emptyForm = {
  name: '', code: '', price: '', departmentId: '', sampleType: '',
  method: '', isPanel: false, displayOrder: '0',
  refMin: '', refMax: '', refUnit: '', refText: '',
};

const emptyAgeForm = {
  minAge: '', maxAge: '', ageUnit: 'years' as 'days' | 'months' | 'years',
  gender: '', refMin: '', refMax: '', refUnit: '', refText: '',
};

/* ───────── Helpers ───────── */

function getHeaders(token: string | null) {
  const { activeBranchId } = useBranchStore.getState();
  return {
    'Authorization': `Bearer ${token}`,
    'X-Branch-Id': activeBranchId || '',
    'Content-Type': 'application/json',
  };
}

function ageToDays(value: number, unit: 'days' | 'months' | 'years'): number {
  if (unit === 'days') return value;
  if (unit === 'months') return Math.round(value * 30.44);
  return Math.round(value * 365.25);
}

function formatAgeDaysLabel(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return '0d';
  if (days < 30) return `${days}d`;
  if (days < 365) {
    const m = Math.round(days / 30.44);
    return `${m}mo`;
  }
  const y = Math.round((days / 365.25) * 10) / 10;
  return y % 1 === 0 ? `${y}y` : `${y}y`;
}

function formatAgeRangeLabel(r: AgeRange): string {
  const min = r.minAgeDays;
  const max = r.maxAgeDays;
  if (min !== null && max !== null) return `${formatAgeDaysLabel(min)} – ${formatAgeDaysLabel(max)}`;
  if (min !== null) return `${formatAgeDaysLabel(min)}+`;
  if (max !== null) return `0 – ${formatAgeDaysLabel(max)}`;
  return 'All ages';
}

/* ═══════════════════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */

export default function ManageTestsV2() {
  const { token } = useAuthStore();

  const [tests, setTests] = useState<LabTestItem[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState('all');
  const [filterPanel, setFilterPanel] = useState('all');
  const [showInactive, setShowInactive] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(emptyForm);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Stock requirements
  const [stockReqs, setStockReqs] = useState<StockRequirement[]>([]);
  const [allStockItems, setAllStockItems] = useState<StockItem[]>([]);
  const [newStockItemId, setNewStockItemId] = useState('');
  const [newStockQty, setNewStockQty] = useState('1');

  // Derived parameter
  const [derivedParam, setDerivedParam] = useState<DerivedParam | null>(null);
  const [derivedForm, setDerivedForm] = useState({ formula: '', dependsOn: '', displayOrder: '0' });
  const [showDerivedSection, setShowDerivedSection] = useState(false);
  const [derivedWarnings, setDerivedWarnings] = useState<string[]>([]);

  // Age ranges
  const [ageRanges, setAgeRanges] = useState<AgeRange[]>([]);
  const [showAgeSection, setShowAgeSection] = useState(false);
  const [ageForm, setAgeForm] = useState(emptyAgeForm);

  // Panel management
  const [panelDef, setPanelDef] = useState<PanelDef | null>(null);
  const [panelItems, setPanelItems] = useState<PanelTestItem[]>([]);
  const [panelDisplayName, setPanelDisplayName] = useState('');
  const [panelLayoutType, setPanelLayoutType] = useState('STANDARD_TABLE');
  const [panelShowMethod, setPanelShowMethod] = useState(false);
  const [addTestId, setAddTestId] = useState('');
  const [allTestsForPanel, setAllTestsForPanel] = useState<{ id: string; name: string; code: string }[]>([]);

  // Collapsed departments
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());

  /* ─── Data fetching (main list) ─── */

  const fetchDepartments = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/departments`, { headers: getHeaders(token) });
      if (res.ok) setDepartments(await res.json());
    } catch (err) { console.error('Error fetching departments:', err); }
  };

  const fetchTests = async () => {
    if (!token) return;
    try {
      const params = new URLSearchParams();
      if (showInactive) params.set('includeInactive', 'true');
      params.set('includeSubTests', 'false');
      const res = await fetch(`${API_BASE}/lab-tests?${params}`, { headers: getHeaders(token) });
      if (res.ok) setTests(await res.json());
    } catch (err) { console.error('Error fetching tests:', err); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchDepartments(); fetchTests(); }, [token, showInactive]);

  /* ─── Dialog-level fetchers ─── */

  const fetchStockItems = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/stock`, { headers: getHeaders(token) });
      if (res.ok) setAllStockItems(await res.json());
    } catch (err) { console.error(err); }
  };

  const fetchStockReqs = async (testId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${testId}/stock-requirements`, { headers: getHeaders(token) });
      if (res.ok) setStockReqs(await res.json());
    } catch (err) { console.error(err); }
  };

  const fetchDerivedParam = async (testId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${testId}/derived-parameter`, { headers: getHeaders(token) });
      if (res.ok) {
        const data = await res.json();
        setDerivedParam(data);
        setDerivedForm({ formula: data.formula, dependsOn: data.dependsOnTestCodes.join(', '), displayOrder: data.displayOrder.toString() });
        setShowDerivedSection(true);
      } else {
        setDerivedParam(null);
        setDerivedForm({ formula: '', dependsOn: '', displayOrder: '0' });
        setShowDerivedSection(false);
      }
    } catch { setDerivedParam(null); setShowDerivedSection(false); }
  };

  const fetchAgeRanges = async (testId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${testId}/age-ranges`, { headers: getHeaders(token) });
      if (res.ok) {
        const data = await res.json();
        setAgeRanges(data);
        if (data.length > 0) setShowAgeSection(true);
      }
    } catch (err) { console.error(err); }
  };

  const fetchPanelDef = useCallback(async (code: string) => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/panels?search=${encodeURIComponent(code)}`, { headers: getHeaders(token) });
      if (!res.ok) return;
      const panels = await res.json();
      const match = panels.find((p: any) => p.name === code.toUpperCase());
      if (match) {
        setPanelDef(match);
        setPanelDisplayName(match.displayName);
        setPanelLayoutType(match.layoutType);
        setPanelShowMethod(match.showMethodColumn);
        // Fetch panel items
        const itemsRes = await fetch(`${API_BASE}/panels/${match.id}/tests`, { headers: getHeaders(token) });
        if (itemsRes.ok) setPanelItems(await itemsRes.json());
      } else {
        setPanelDef(null);
        setPanelItems([]);
      }
    } catch (err) { console.error(err); }
  }, [token]);

  const fetchAllTestsForPanel = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests?includeSubTests=true`, { headers: getHeaders(token) });
      if (res.ok) {
        const data: LabTestItem[] = await res.json();
        setAllTestsForPanel(data.filter(t => !t.isPanel).map(t => ({ id: t.id, name: t.name, code: t.code })));
      }
    } catch (err) { console.error(err); }
  };

  /* ─── Filter & Group ─── */

  const filtered = tests.filter((t) => {
    if (search) {
      const q = search.toLowerCase();
      if (!t.name.toLowerCase().includes(q) && !t.code.toLowerCase().includes(q)) return false;
    }
    if (filterDept !== 'all' && t.departmentId !== filterDept) return false;
    if (filterPanel === 'panels' && !t.isPanel) return false;
    if (filterPanel === 'tests' && t.isPanel) return false;
    return true;
  });

  const grouped = new Map<string, LabTestItem[]>();
  const ungrouped: LabTestItem[] = [];
  for (const t of filtered) {
    if (t.department) {
      const key = t.department.id;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  const toggleCollapse = (deptId: string) => {
    setCollapsedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId); else next.add(deptId);
      return next;
    });
  };

  /* ─── Dialog open/close ─── */

  const resetDialogState = () => {
    setStockReqs([]); setNewStockItemId(''); setNewStockQty('1');
    setDerivedParam(null); setDerivedForm({ formula: '', dependsOn: '', displayOrder: '0' });
    setShowDerivedSection(false); setDerivedWarnings([]);
    setAgeRanges([]); setShowAgeSection(false); setAgeForm(emptyAgeForm);
    setPanelDef(null); setPanelItems([]); setPanelDisplayName('');
    setPanelLayoutType('STANDARD_TABLE'); setPanelShowMethod(false);
    setAddTestId(''); setAllTestsForPanel([]);
  };

  const openCreate = () => {
    setFormData(emptyForm);
    setEditingId(null);
    resetDialogState();
    setDialogOpen(true);
  };

  const openEdit = (t: LabTestItem) => {
    setFormData({
      name: t.name, code: t.code, price: (t.priceInPaise / 100).toString(),
      departmentId: t.departmentId || '', sampleType: t.sampleType || '',
      method: t.method || '', isPanel: t.isPanel,
      displayOrder: t.displayOrder.toString(),
      refMin: t.referenceRange.min?.toString() ?? '', refMax: t.referenceRange.max?.toString() ?? '',
      refUnit: t.referenceRange.unit || '', refText: t.referenceRange.text || '',
    });
    setEditingId(t.id);
    resetDialogState();
    fetchStockItems();
    fetchStockReqs(t.id);
    fetchDerivedParam(t.id);
    fetchAgeRanges(t.id);
    if (t.isPanel) {
      fetchPanelDef(t.code);
      fetchAllTestsForPanel();
    }
    setDialogOpen(true);
  };

  /* ─── Test CRUD ─── */

  const handleSubmit = async () => {
    if (!formData.name || !formData.code || !formData.price) {
      toast.error('Name, code, and price are required'); return;
    }
    const price = parseFloat(formData.price);
    if (isNaN(price) || price < 0) { toast.error('Price must be a non-negative number'); return; }

    const body: any = {
      name: formData.name, code: formData.code.toUpperCase(), price,
      departmentId: formData.departmentId || null,
      sampleType: formData.sampleType || null, method: formData.method || null,
      isPanel: formData.isPanel, displayOrder: parseInt(formData.displayOrder) || 0,
      referenceRange: {
        min: formData.refMin ? parseFloat(formData.refMin) : null,
        max: formData.refMax ? parseFloat(formData.refMax) : null,
        unit: formData.refUnit || '', text: formData.refText || '',
      },
    };

    try {
      const url = editingId ? `${API_BASE}/lab-tests/${editingId}` : `${API_BASE}/lab-tests`;
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: getHeaders(token), body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.message || `Failed to ${editingId ? 'update' : 'create'} test`); return;
      }
      toast.success(`Test ${editingId ? 'updated' : 'created'}`);
      setDialogOpen(false);
      await fetchTests();
    } catch (err) { console.error(err); toast.error('Failed to save test'); }
  };

  const handleToggleActive = async (t: LabTestItem) => {
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${t.id}`, {
        method: 'PATCH', headers: getHeaders(token),
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      if (!res.ok) { toast.error('Failed to toggle active status'); return; }
      toast.success(`Test ${!t.isActive ? 'activated' : 'deactivated'}`);
      await fetchTests();
    } catch { toast.error('Failed to toggle active status'); }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${deleteId}`, { method: 'DELETE', headers: getHeaders(token) });
      if (!res.ok) { const err = await res.json(); toast.error(err.message || 'Failed to delete test'); return; }
      toast.success('Test deleted'); await fetchTests();
    } catch { toast.error('Failed to delete test'); }
    setDeleteId(null);
  };

  /* ─── Stock requirement handlers ─── */

  const handleAddStockReq = async () => {
    if (!editingId || !newStockItemId) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${editingId}/stock-requirements`, {
        method: 'POST', headers: getHeaders(token),
        body: JSON.stringify({ stockItemId: newStockItemId, quantityPerTest: parseFloat(newStockQty) || 1 }),
      });
      if (res.status === 409) { toast.error('Already linked'); return; }
      if (!res.ok) { toast.error('Failed to add'); return; }
      const added = await res.json();
      setStockReqs(prev => [...prev, added]);
      setNewStockItemId(''); setNewStockQty('1');
      toast.success('Stock requirement added');
    } catch { toast.error('Failed to add stock requirement'); }
  };

  const handleRemoveStockReq = async (reqId: string) => {
    if (!editingId) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${editingId}/stock-requirements/${reqId}`, {
        method: 'DELETE', headers: getHeaders(token),
      });
      if (!res.ok) { toast.error('Failed to remove'); return; }
      setStockReqs(prev => prev.filter(r => r.id !== reqId));
      toast.success('Removed');
    } catch { toast.error('Failed to remove'); }
  };

  /* ─── Derived parameter handlers ─── */

  const validateDerived = () => {
    const warnings: string[] = [];
    const codes = derivedForm.dependsOn.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    const knownCodes = new Set(tests.map(t => t.code));

    // Check each dependency code exists
    for (const c of codes) {
      if (!knownCodes.has(c)) warnings.push(`Code "${c}" not found in test list`);
    }

    // Check formula references match dependsOn
    const formulaCodes = derivedForm.formula.match(/[A-Z_][A-Z0-9_]*/g) || [];
    for (const fc of formulaCodes) {
      if (!codes.includes(fc)) warnings.push(`Formula uses "${fc}" but it's not in depends-on list`);
    }

    setDerivedWarnings(warnings);
    return warnings;
  };

  const handleSaveDerived = async () => {
    if (!editingId || !derivedForm.formula) { toast.error('Formula is required'); return; }
    const warnings = validateDerived();
    if (warnings.some(w => w.includes('not found'))) {
      toast.error('Fix dependency errors before saving'); return;
    }

    try {
      const codes = derivedForm.dependsOn.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
      const res = await fetch(`${API_BASE}/lab-tests/${editingId}/derived-parameter`, {
        method: 'PUT', headers: getHeaders(token),
        body: JSON.stringify({
          parameterName: formData.name || 'Derived', formula: derivedForm.formula,
          dependsOnTestCodes: codes, displayOrder: parseInt(derivedForm.displayOrder) || 0,
        }),
      });
      if (!res.ok) { toast.error('Failed to save'); return; }
      setDerivedParam(await res.json());
      toast.success('Derived parameter saved');
    } catch { toast.error('Failed to save'); }
  };

  const handleDeleteDerived = async () => {
    if (!editingId) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${editingId}/derived-parameter`, {
        method: 'DELETE', headers: getHeaders(token),
      });
      if (!res.ok) { toast.error('Failed to delete'); return; }
      setDerivedParam(null); setDerivedForm({ formula: '', dependsOn: '', displayOrder: '0' });
      setShowDerivedSection(false); setDerivedWarnings([]);
      toast.success('Derived parameter removed');
    } catch { toast.error('Failed to delete'); }
  };

  /* ─── Age range handlers ─── */

  const handleAddAgeRange = async () => {
    if (!editingId) return;
    const unit = ageForm.ageUnit;
    const body: any = {
      minAgeDays: ageForm.minAge ? ageToDays(parseFloat(ageForm.minAge), unit) : null,
      maxAgeDays: ageForm.maxAge ? ageToDays(parseFloat(ageForm.maxAge), unit) : null,
      gender: ageForm.gender || null,
      referenceMin: ageForm.refMin ? parseFloat(ageForm.refMin) : null,
      referenceMax: ageForm.refMax ? parseFloat(ageForm.refMax) : null,
      referenceUnit: ageForm.refUnit || null,
      referenceText: ageForm.refText || null,
    };
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${editingId}/age-ranges`, {
        method: 'POST', headers: getHeaders(token), body: JSON.stringify(body),
      });
      if (res.status === 409) { toast.error('This age/gender combo already exists'); return; }
      if (!res.ok) { toast.error('Failed to add age range'); return; }
      const added = await res.json();
      setAgeRanges(prev => [...prev, added]);
      setAgeForm(emptyAgeForm);
      toast.success('Age range added');
    } catch { toast.error('Failed to add'); }
  };

  const handleRemoveAgeRange = async (rangeId: string) => {
    if (!editingId) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${editingId}/age-ranges/${rangeId}`, {
        method: 'DELETE', headers: getHeaders(token),
      });
      if (!res.ok) { toast.error('Failed to remove'); return; }
      setAgeRanges(prev => prev.filter(r => r.id !== rangeId));
      toast.success('Removed');
    } catch { toast.error('Failed to remove'); }
  };

  /* ─── Panel management handlers ─── */

  const handleCreatePanelDef = async () => {
    if (!formData.code || !formData.departmentId) {
      toast.error('Code and department are required to create a panel definition'); return;
    }
    try {
      const res = await fetch(`${API_BASE}/panels`, {
        method: 'POST', headers: getHeaders(token),
        body: JSON.stringify({
          name: formData.code.toUpperCase(),
          displayName: panelDisplayName || formData.name,
          departmentId: formData.departmentId,
          layoutType: panelLayoutType,
          showMethodColumn: panelShowMethod,
        }),
      });
      if (res.status === 409) { toast.error('A panel with this name already exists'); return; }
      if (!res.ok) { toast.error('Failed to create panel definition'); return; }
      const created = await res.json();
      setPanelDef(created);
      toast.success('Panel definition created');
    } catch { toast.error('Failed to create panel definition'); }
  };

  const handleUpdatePanelDef = async () => {
    if (!panelDef) return;
    try {
      const res = await fetch(`${API_BASE}/panels/${panelDef.id}`, {
        method: 'PATCH', headers: getHeaders(token),
        body: JSON.stringify({
          displayName: panelDisplayName, layoutType: panelLayoutType,
          showMethodColumn: panelShowMethod,
        }),
      });
      if (!res.ok) { toast.error('Failed to update panel'); return; }
      setPanelDef(await res.json());
      toast.success('Panel updated');
    } catch { toast.error('Failed to update'); }
  };

  const handleAddTestToPanel = async () => {
    if (!panelDef || !addTestId) return;
    try {
      const nextOrder = panelItems.length > 0 ? Math.max(...panelItems.map(i => i.displayOrder)) + 1 : 1;
      const res = await fetch(`${API_BASE}/panels/${panelDef.id}/tests`, {
        method: 'POST', headers: getHeaders(token),
        body: JSON.stringify({ testId: addTestId, displayOrder: nextOrder }),
      });
      if (res.status === 409) { toast.error('Test already in panel'); return; }
      if (!res.ok) { toast.error('Failed to add test'); return; }
      const added = await res.json();
      setPanelItems(prev => [...prev, added]);
      setAddTestId('');
      toast.success('Test added to panel');
    } catch { toast.error('Failed to add'); }
  };

  const handleRemovePanelItem = async (itemId: string) => {
    if (!panelDef) return;
    try {
      const res = await fetch(`${API_BASE}/panels/${panelDef.id}/tests/${itemId}`, {
        method: 'DELETE', headers: getHeaders(token),
      });
      if (!res.ok) { toast.error('Failed to remove'); return; }
      setPanelItems(prev => prev.filter(i => i.id !== itemId));
      toast.success('Test removed from panel');
    } catch { toast.error('Failed to remove'); }
  };

  const handleUpdatePanelItem = async (itemId: string, updates: Record<string, any>) => {
    if (!panelDef) return;
    try {
      const res = await fetch(`${API_BASE}/panels/${panelDef.id}/tests/${itemId}`, {
        method: 'PATCH', headers: getHeaders(token), body: JSON.stringify(updates),
      });
      if (!res.ok) { toast.error('Failed to update'); return; }
      const updated = await res.json();
      setPanelItems(prev => prev.map(i => i.id === itemId ? updated : i));
    } catch { toast.error('Failed to update'); }
  };

  /* ═══════════════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════════════ */

  const renderTestRow = (t: LabTestItem) => (
    <TableRow key={t.id} className={!t.isActive ? 'opacity-50' : ''}>
      <TableCell className="font-mono text-xs">{t.code}</TableCell>
      <TableCell className="font-medium">
        {t.name}
        {t.isPanel && <Badge variant="secondary" className="ml-2 text-xs">Panel</Badge>}
      </TableCell>
      <TableCell>
        {t.sampleType ? (
          <Badge variant="outline" className="text-xs">{t.sampleType.replace(/_/g, ' ')}</Badge>
        ) : '—'}
      </TableCell>
      <TableCell className="text-right font-mono">{(t.priceInPaise / 100).toFixed(0)}</TableCell>
      <TableCell className="text-right text-muted-foreground text-xs">
        {t.referenceRange.min !== null || t.referenceRange.max !== null
          ? `${t.referenceRange.min ?? ''}–${t.referenceRange.max ?? ''} ${t.referenceRange.unit}`
          : t.referenceRange.text || '—'}
      </TableCell>
      <TableCell>
        <Switch checked={t.isActive} onCheckedChange={() => handleToggleActive(t)} />
      </TableCell>
      <TableCell>
        <div className="flex gap-1 justify-end">
          <Button variant="ghost" size="icon" onClick={() => openEdit(t)}><Pencil className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={() => setDeleteId(t.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
        </div>
      </TableCell>
    </TableRow>
  );

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading tests...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by name or code..." value={search}
            onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={filterDept} onValueChange={setFilterDept}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="All Departments" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterPanel} onValueChange={setFilterPanel}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="All Types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="tests">Tests Only</SelectItem>
            <SelectItem value="panels">Panels Only</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} id="show-inactive" />
          <Label htmlFor="show-inactive" className="text-sm">Show Inactive</Label>
        </div>
        <Button onClick={openCreate} className="ml-auto"><Plus className="h-4 w-4 mr-2" />Add Test</Button>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-[140px]">Sample Type</TableHead>
              <TableHead className="text-right w-[80px]">Price</TableHead>
              <TableHead className="text-right w-[160px]">Reference</TableHead>
              <TableHead className="w-[70px]">Active</TableHead>
              <TableHead className="text-right w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(grouped.entries()).map(([deptId, deptTests]) => {
              const deptName = deptTests[0]?.department?.name || 'Unknown';
              const isCollapsed = collapsedDepts.has(deptId);
              return (
                <>{/* Fragment */}
                  <TableRow key={`dept-${deptId}`} className="bg-muted/50 cursor-pointer hover:bg-muted"
                    onClick={() => toggleCollapse(deptId)}>
                    <TableCell colSpan={7} className="font-semibold text-sm">
                      <span className="flex items-center gap-2">
                        {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        {deptName}
                        <Badge variant="secondary" className="text-xs">{deptTests.length}</Badge>
                      </span>
                    </TableCell>
                  </TableRow>
                  {!isCollapsed && deptTests.map(renderTestRow)}
                </>
              );
            })}
            {ungrouped.length > 0 && (
              <>
                <TableRow className="bg-muted/50">
                  <TableCell colSpan={7} className="font-semibold text-sm">
                    <span className="flex items-center gap-2">No Department
                      <Badge variant="secondary" className="text-xs">{ungrouped.length}</Badge>
                    </span>
                  </TableCell>
                </TableRow>
                {ungrouped.map(renderTestRow)}
              </>
            )}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No tests found.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ════════ Create/Edit Dialog ════════ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Test' : 'Add New Test'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* Basic fields */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Test Name *</Label>
                <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Haemoglobin" />
              </div>
              <div className="space-y-2">
                <Label>Code *</Label>
                <Input value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  placeholder="e.g. HGB" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Price (INR) *</Label>
                <Input type="number" value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  placeholder="e.g. 150" min={0} />
              </div>
              <div className="space-y-2">
                <Label>Department</Label>
                <Select value={formData.departmentId || 'none'}
                  onValueChange={(v) => setFormData({ ...formData, departmentId: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sample Type</Label>
                <Select value={formData.sampleType || 'none'}
                  onValueChange={(v) => setFormData({ ...formData, sampleType: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {SAMPLE_TYPES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Method</Label>
                <Input value={formData.method} onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                  placeholder="e.g. Colorimetric" />
              </div>
              <div className="space-y-2">
                <Label>Display Order</Label>
                <Input type="number" value={formData.displayOrder}
                  onChange={(e) => setFormData({ ...formData, displayOrder: e.target.value })} />
              </div>
              <div className="flex items-end gap-2 pb-2">
                <Switch checked={formData.isPanel}
                  onCheckedChange={(v) => {
                    setFormData({ ...formData, isPanel: v });
                    if (v && editingId) { fetchPanelDef(formData.code); fetchAllTestsForPanel(); }
                    if (v && !editingId) { fetchAllTestsForPanel(); }
                  }}
                  id="is-panel" />
                <Label htmlFor="is-panel">Is Panel</Label>
              </div>
            </div>

            {/* ──── PANEL CONTENTS (D1 + D4) ──── */}
            {formData.isPanel && (
              <div className="border-t pt-4 space-y-4">
                <Label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <ListOrdered className="h-4 w-4" />
                  Panel Contents
                </Label>

                {/* Panel definition config */}
                <div className="p-3 bg-muted/30 rounded-md space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Display Name</Label>
                      <Input value={panelDisplayName}
                        onChange={(e) => setPanelDisplayName(e.target.value)}
                        placeholder="e.g. LIVER FUNCTION TEST" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Layout Type</Label>
                      <Select value={panelLayoutType} onValueChange={setPanelLayoutType}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {LAYOUT_TYPES.map(lt => <SelectItem key={lt} value={lt}>{lt}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end gap-2 pb-1">
                      <Checkbox checked={panelShowMethod}
                        onCheckedChange={(v) => setPanelShowMethod(!!v)} id="panel-show-method" />
                      <Label htmlFor="panel-show-method" className="text-xs">Show Method Col</Label>
                    </div>
                  </div>

                  {panelDef ? (
                    <Button variant="outline" size="sm" onClick={handleUpdatePanelDef}>
                      Save Panel Settings
                    </Button>
                  ) : editingId ? (
                    <Button size="sm" onClick={handleCreatePanelDef}>
                      Create Panel Definition
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Save the test first, then edit it to configure panel definition and add sub-tests.
                    </p>
                  )}
                </div>

                {/* Panel items list */}
                {panelDef && (
                  <div className="space-y-2">
                    {panelItems.length > 0 ? (
                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[40px]">#</TableHead>
                              <TableHead>Test</TableHead>
                              <TableHead className="w-[70px]">Indent</TableHead>
                              <TableHead className="w-[100px]">SubGroup</TableHead>
                              <TableHead className="w-[50px]">Bold</TableHead>
                              <TableHead className="w-[50px]"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {panelItems.map((item) => (
                              <TableRow key={item.id}>
                                <TableCell>
                                  <Input type="number" className="h-7 w-12 text-xs" value={item.displayOrder}
                                    onChange={(e) => handleUpdatePanelItem(item.id, { displayOrder: parseInt(e.target.value) || 0 })} />
                                </TableCell>
                                <TableCell className="text-sm">
                                  <span className={item.isBold ? 'font-bold' : ''} style={{ paddingLeft: item.indentLevel * 16 }}>
                                    {item.test.name} <span className="text-muted-foreground">({item.test.code})</span>
                                  </span>
                                </TableCell>
                                <TableCell>
                                  <Input type="number" className="h-7 w-12 text-xs" value={item.indentLevel}
                                    onChange={(e) => handleUpdatePanelItem(item.id, { indentLevel: parseInt(e.target.value) || 0 })} />
                                </TableCell>
                                <TableCell>
                                  <Input className="h-7 text-xs" value={item.subGroup || ''}
                                    onChange={(e) => handleUpdatePanelItem(item.id, { subGroup: e.target.value || null })}
                                    placeholder="—" />
                                </TableCell>
                                <TableCell>
                                  <Checkbox checked={item.isBold}
                                    onCheckedChange={(v) => handleUpdatePanelItem(item.id, { isBold: !!v })} />
                                </TableCell>
                                <TableCell>
                                  <Button variant="ghost" size="icon" className="h-7 w-7"
                                    onClick={() => handleRemovePanelItem(item.id)}>
                                    <X className="h-3 w-3" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground py-2">No tests added to this panel yet.</p>
                    )}

                    {/* Add test to panel */}
                    <div className="flex gap-2 items-end">
                      <div className="flex-1">
                        <Select value={addTestId} onValueChange={setAddTestId}>
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="Select test to add..." />
                          </SelectTrigger>
                          <SelectContent>
                            {allTestsForPanel
                              .filter(t => !panelItems.some(pi => pi.testId === t.id))
                              .map(t => (
                                <SelectItem key={t.id} value={t.id}>{t.name} ({t.code})</SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button variant="secondary" size="sm" className="h-9" onClick={handleAddTestToPanel}
                        disabled={!addTestId}>
                        <Plus className="h-3 w-3 mr-1" /> Add
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ──── REFERENCE RANGE ──── */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium text-muted-foreground mb-2 block">Reference Range (Default)</Label>
              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Min</Label>
                  <Input type="number" value={formData.refMin}
                    onChange={(e) => setFormData({ ...formData, refMin: e.target.value })} placeholder="e.g. 12" />
                </div>
                <div className="space-y-2">
                  <Label>Max</Label>
                  <Input type="number" value={formData.refMax}
                    onChange={(e) => setFormData({ ...formData, refMax: e.target.value })} placeholder="e.g. 17" />
                </div>
                <div className="space-y-2">
                  <Label>Unit</Label>
                  <Input value={formData.refUnit}
                    onChange={(e) => setFormData({ ...formData, refUnit: e.target.value })} placeholder="e.g. g/dL" />
                </div>
                <div className="space-y-2">
                  <Label>Text</Label>
                  <Input value={formData.refText}
                    onChange={(e) => setFormData({ ...formData, refText: e.target.value })} placeholder="e.g. Negative" />
                </div>
              </div>
            </div>

            {/* ──── AGE/GENDER RANGES (D2) ──── */}
            {editingId && (
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Age / Gender Ranges
                    {ageRanges.length > 0 && <Badge variant="secondary" className="text-xs">{ageRanges.length}</Badge>}
                  </Label>
                  {!showAgeSection && (
                    <Button variant="outline" size="sm" onClick={() => setShowAgeSection(true)}>
                      <Plus className="h-3 w-3 mr-1" /> Add Range
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Override reference ranges for specific age groups or genders.
                </p>

                {showAgeSection && (
                  <div className="space-y-3">
                    {/* Existing ranges */}
                    {ageRanges.length > 0 && (
                      <div className="space-y-1">
                        {ageRanges.map((r) => (
                          <div key={r.id} className="flex items-center gap-3 p-2 bg-muted/50 rounded-md text-sm">
                            <span className="font-medium min-w-[80px]">{formatAgeRangeLabel(r)}</span>
                            <Badge variant="outline" className="text-xs">
                              {r.gender === 'M' ? 'Male' : r.gender === 'F' ? 'Female' : 'All'}
                            </Badge>
                            <span className="text-muted-foreground flex-1">
                              {r.referenceMin ?? ''}–{r.referenceMax ?? ''} {r.referenceUnit || ''}
                              {r.referenceText ? ` (${r.referenceText})` : ''}
                            </span>
                            <Button variant="ghost" size="icon" className="h-7 w-7"
                              onClick={() => handleRemoveAgeRange(r.id)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add new range form */}
                    <div className="p-3 bg-muted/30 rounded-md space-y-2">
                      <div className="grid grid-cols-4 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Min Age</Label>
                          <Input type="number" className="h-8 text-sm" value={ageForm.minAge}
                            onChange={(e) => setAgeForm({ ...ageForm, minAge: e.target.value })}
                            placeholder="e.g. 0" min={0} step="any" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Max Age</Label>
                          <Input type="number" className="h-8 text-sm" value={ageForm.maxAge}
                            onChange={(e) => setAgeForm({ ...ageForm, maxAge: e.target.value })}
                            placeholder="e.g. 12" min={0} step="any" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Unit</Label>
                          <Select value={ageForm.ageUnit}
                            onValueChange={(v) => setAgeForm({ ...ageForm, ageUnit: v as 'days' | 'months' | 'years' })}>
                            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="days">Days</SelectItem>
                              <SelectItem value="months">Months</SelectItem>
                              <SelectItem value="years">Years</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Gender</Label>
                          <Select value={ageForm.gender || 'all'}
                            onValueChange={(v) => setAgeForm({ ...ageForm, gender: v === 'all' ? '' : v })}>
                            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All</SelectItem>
                              <SelectItem value="M">Male</SelectItem>
                              <SelectItem value="F">Female</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Ref Min</Label>
                          <Input type="number" className="h-8 text-sm" value={ageForm.refMin}
                            onChange={(e) => setAgeForm({ ...ageForm, refMin: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Ref Max</Label>
                          <Input type="number" className="h-8 text-sm" value={ageForm.refMax}
                            onChange={(e) => setAgeForm({ ...ageForm, refMax: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Unit</Label>
                          <Input className="h-8 text-sm" value={ageForm.refUnit}
                            onChange={(e) => setAgeForm({ ...ageForm, refUnit: e.target.value })}
                            placeholder="e.g. g/dL" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Text</Label>
                          <Input className="h-8 text-sm" value={ageForm.refText}
                            onChange={(e) => setAgeForm({ ...ageForm, refText: e.target.value })} />
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button variant="outline" size="sm" onClick={() => setShowAgeSection(false)}>Done</Button>
                        <Button size="sm" onClick={handleAddAgeRange}>
                          <Plus className="h-3 w-3 mr-1" /> Add Range
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ──── STOCK REQUIREMENTS ──── */}
            {editingId && (
              <div className="border-t pt-4">
                <Label className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
                  <FlaskConical className="h-4 w-4" />
                  Stock Requirements
                </Label>
                <p className="text-xs text-muted-foreground mb-3">
                  Define how much of each stock item this test consumes per run.
                </p>
                {stockReqs.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {stockReqs.map((req) => (
                      <div key={req.id} className="flex items-center gap-3 p-2 bg-muted/50 rounded-md">
                        <span className="flex-1 text-sm font-medium">{req.stockItem.name}</span>
                        <span className="text-sm text-muted-foreground">
                          {req.quantityPerTest} {req.stockItem.unit}
                        </span>
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => handleRemoveStockReq(req.id)}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <Select value={newStockItemId} onValueChange={setNewStockItemId}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select stock item..." /></SelectTrigger>
                      <SelectContent>
                        {allStockItems.filter(si => !stockReqs.some(r => r.stockItemId === si.id)).map(si => (
                          <SelectItem key={si.id} value={si.id}>{si.name} ({si.unit})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-20">
                    <Input type="number" min={0.1} step={0.1} value={newStockQty}
                      onChange={(e) => setNewStockQty(e.target.value)} placeholder="Qty" className="h-9" />
                  </div>
                  <Button variant="secondary" size="sm" className="h-9" onClick={handleAddStockReq}
                    disabled={!newStockItemId}>
                    <Plus className="h-3 w-3 mr-1" /> Add
                  </Button>
                </div>
              </div>
            )}

            {/* ──── DERIVED PARAMETER (D3 validation) ──── */}
            {editingId && (
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Calculator className="h-4 w-4" />
                    Derived Calculation
                  </Label>
                  {!showDerivedSection && (
                    <Button variant="outline" size="sm" onClick={() => setShowDerivedSection(true)}>
                      <Plus className="h-3 w-3 mr-1" /> Add Formula
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Auto-calculate this test's value from other test results using a formula.
                </p>
                {showDerivedSection && (
                  <div className="space-y-3 p-3 bg-muted/30 rounded-md">
                    <div className="space-y-2">
                      <Label className="text-xs">Formula</Label>
                      <Input value={derivedForm.formula}
                        onChange={(e) => { setDerivedForm({ ...derivedForm, formula: e.target.value }); setDerivedWarnings([]); }}
                        placeholder="e.g. TP - ALB or CHOL / HDL" />
                      <p className="text-xs text-muted-foreground">
                        Use test codes with +, -, *, / and parentheses. E.g. <code className="bg-muted px-1 rounded">CHOL - HDL - (TGL / 5)</code>
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label className="text-xs">Depends On (test codes)</Label>
                        <Input value={derivedForm.dependsOn}
                          onChange={(e) => { setDerivedForm({ ...derivedForm, dependsOn: e.target.value }); setDerivedWarnings([]); }}
                          placeholder="e.g. TP, ALB" />
                        <p className="text-xs text-muted-foreground">Comma-separated test codes</p>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Display Order</Label>
                        <Input type="number" value={derivedForm.displayOrder}
                          onChange={(e) => setDerivedForm({ ...derivedForm, displayOrder: e.target.value })} />
                      </div>
                    </div>
                    {/* Validation warnings */}
                    {derivedWarnings.length > 0 && (
                      <div className="space-y-1">
                        {derivedWarnings.map((w, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs text-amber-600">
                            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                            {w}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2 justify-end">
                      {derivedParam && (
                        <Button variant="destructive" size="sm" onClick={handleDeleteDerived}>
                          Remove Formula
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => {
                        setShowDerivedSection(false);
                        if (!derivedParam) setDerivedForm({ formula: '', dependsOn: '', displayOrder: '0' });
                        setDerivedWarnings([]);
                      }}>Cancel</Button>
                      <Button size="sm" onClick={handleSaveDerived}>
                        {derivedParam ? 'Update' : 'Save'} Formula
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit}>{editingId ? 'Update' : 'Create'} Test</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Test?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the test. It can be reactivated later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
