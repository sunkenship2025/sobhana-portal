import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Search, ChevronDown, ChevronRight,
  FlaskConical, Lock, Archive, History, Eye, AlertTriangle,
  CheckCircle2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';

/* ───────── Types ───────── */

interface Department { id: string; name: string }

interface TestDefinitionRange {
  id?: string;
  minAgeDays: number | null;
  maxAgeDays: number | null;
  gender: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
}

interface InterpretationRule {
  id?: string;
  ruleType: 'NUMERIC_RANGE' | 'CATEGORY_MATCH' | 'TEXT_MATCH';
  operator: string;
  value1: number | null;
  value2: number | null;
  textMatch: string | null;
  interpretationText: string;
  severity: string | null;
  displayOrder: number;
  isActive: boolean;
}

interface TestDefinition {
  id: string;
  rootDefinitionId: string;
  version: number;
  isLatest: boolean;
  status: 'ACTIVE' | 'LOCKED' | 'DEPRECATED' | 'ARCHIVED';
  name: string;
  code: string;
  sampleType: string | null;
  method: string | null;
  referenceUnit: string | null;
  departmentId: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceText: string | null;
  formulaExpression: string | null;
  dependsOnCodes: string[] | null;
  interpretationMode: string;
  displayOrder: number;
  updatedAt: string;
  createdAt: string;
  ranges: TestDefinitionRange[];
  interpretationRules: InterpretationRule[];
  department?: { id: string; name: string } | null;
  _count?: { panelItems: number };
}

type FormMode = 'create' | 'edit' | 'new-version';

/* ───────── Constants ───────── */

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  LOCKED: 'bg-yellow-100 text-yellow-800',
  DEPRECATED: 'bg-orange-100 text-orange-800',
  ARCHIVED: 'bg-gray-100 text-gray-800',
};

const SAMPLE_COLORS: Record<string, string> = {
  blood: 'bg-red-500',
  serum: 'bg-amber-500',
  urine: 'bg-yellow-400',
  plasma: 'bg-orange-400',
  csf: 'bg-blue-400',
  stool: 'bg-amber-700',
  swab: 'bg-teal-400',
  sputum: 'bg-lime-500',
};

function sampleDotColor(sampleType: string | null) {
  if (!sampleType) return 'bg-gray-300';
  const lower = sampleType.toLowerCase();
  for (const [key, cls] of Object.entries(SAMPLE_COLORS)) {
    if (lower.includes(key)) return cls;
  }
  return 'bg-gray-400';
}

function formatRange(def: TestDefinition) {
  if (def.referenceText) return def.referenceText;
  if (def.referenceMin != null && def.referenceMax != null) {
    return `${def.referenceMin} – ${def.referenceMax}${def.referenceUnit ? ` ${def.referenceUnit}` : ''}`;
  }
  if (def.referenceMin != null) return `≥ ${def.referenceMin}${def.referenceUnit ? ` ${def.referenceUnit}` : ''}`;
  if (def.referenceMax != null) return `≤ ${def.referenceMax}${def.referenceUnit ? ` ${def.referenceUnit}` : ''}`;
  return '—';
}

const INTERPRETATION_MODES = ['NONE', 'RANGE_BASED', 'CATEGORY_BASED', 'TEXT_ONLY'];
const RULE_TYPES = ['NUMERIC_RANGE', 'CATEGORY_MATCH', 'TEXT_MATCH'];
const OPERATORS = ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'BETWEEN', 'MATCH'];

/* ───────── Accordion Section Indicator ───────── */

function SectionStatus({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
  ) : (
    <AlertCircle className="h-4 w-4 text-orange-500 shrink-0" />
  );
}

/* ───────── Component ───────── */

export default function ManageClinicalDefinitions() {
  const { token } = useAuthStore();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // State
  const [definitions, setDefinitions] = useState<TestDefinition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('__all__');
  const [deptFilter, setDeptFilter] = useState<string>('__all__');
  const [expandedRoot, setExpandedRoot] = useState<string | null>(null);
  const [versions, setVersions] = useState<TestDefinition[]>([]);

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('create');
  const [editingDef, setEditingDef] = useState<TestDefinition | null>(null);
  const [saving, setSaving] = useState(false);

  // Impact dialog
  const [impactOpen, setImpactOpen] = useState(false);
  const [impactData, setImpactData] = useState<any>(null);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formSampleType, setFormSampleType] = useState('');
  const [formMethod, setFormMethod] = useState('');
  const [formUnit, setFormUnit] = useState('');
  const [formDepartmentId, setFormDepartmentId] = useState('');
  const [formRefMin, setFormRefMin] = useState('');
  const [formRefMax, setFormRefMax] = useState('');
  const [formRefText, setFormRefText] = useState('');
  const [formFormula, setFormFormula] = useState('');
  const [formDependsOn, setFormDependsOn] = useState('');
  const [formInterpMode, setFormInterpMode] = useState('NONE');
  const [formDisplayOrder, setFormDisplayOrder] = useState('0');
  const [formRanges, setFormRanges] = useState<TestDefinitionRange[]>([]);
  const [formRules, setFormRules] = useState<InterpretationRule[]>([]);

  // ─── Data fetching ──────────────────────────────────────────────────────

  const fetchDefinitions = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter && statusFilter !== '__all__') params.set('status', statusFilter);
      if (deptFilter && deptFilter !== '__all__') params.set('departmentId', deptFilter);
      const res = await fetch(`${API_BASE}/clinical-definitions?${params}`, { headers });
      if (!res.ok) throw new Error('Failed to fetch');
      setDefinitions(await res.json());
    } catch {
      toast.error('Failed to load clinical definitions');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, deptFilter]);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/departments`, { headers });
      if (!res.ok) throw new Error('Failed');
      setDepartments(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchVersions = useCallback(async (rootId: string) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-definitions/${rootId}/versions`, { headers });
      if (!res.ok) throw new Error('Failed');
      setVersions(await res.json());
    } catch {
      toast.error('Failed to load version history');
    }
  }, []);

  useEffect(() => { fetchDefinitions(); }, [fetchDefinitions]);
  useEffect(() => { fetchDepartments(); }, [fetchDepartments]);

  // ─── Form reset ─────────────────────────────────────────────────────────

  const resetForm = () => {
    setFormName(''); setFormCode(''); setFormSampleType(''); setFormMethod('');
    setFormUnit(''); setFormDepartmentId(''); setFormRefMin(''); setFormRefMax('');
    setFormRefText(''); setFormFormula(''); setFormDependsOn('');
    setFormInterpMode('NONE'); setFormDisplayOrder('0');
    setFormRanges([]); setFormRules([]);
    setEditingDef(null);
  };

  const populateForm = (def: TestDefinition) => {
    setFormName(def.name);
    setFormCode(def.code);
    setFormSampleType(def.sampleType || '');
    setFormMethod(def.method || '');
    setFormUnit(def.referenceUnit || '');
    setFormDepartmentId(def.departmentId || '');
    setFormRefMin(def.referenceMin?.toString() || '');
    setFormRefMax(def.referenceMax?.toString() || '');
    setFormRefText(def.referenceText || '');
    setFormFormula(def.formulaExpression || '');
    setFormDependsOn(def.dependsOnCodes ? def.dependsOnCodes.join(', ') : '');
    setFormInterpMode(def.interpretationMode || 'NONE');
    setFormDisplayOrder(def.displayOrder?.toString() || '0');
    setFormRanges(def.ranges || []);
    setFormRules(def.interpretationRules || []);
  };

  // ─── Handlers ───────────────────────────────────────────────────────────

  const openCreate = () => {
    resetForm();
    setFormMode('create');
    setDialogOpen(true);
  };

  const openNewVersion = (def: TestDefinition) => {
    populateForm(def);
    setEditingDef(def);
    setFormMode('new-version');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formCode.trim()) {
      toast.error('Name and Code are required');
      return;
    }

    setSaving(true);
    try {
      const body: any = {
        name: formName.trim(),
        code: formCode.trim(),
        sampleType: formSampleType || null,
        method: formMethod || null,
        referenceUnit: formUnit || null,
        departmentId: formDepartmentId || null,
        referenceMin: formRefMin ? parseFloat(formRefMin) : null,
        referenceMax: formRefMax ? parseFloat(formRefMax) : null,
        referenceText: formRefText || null,
        formulaExpression: formFormula || null,
        dependsOnCodes: formDependsOn ? formDependsOn.split(',').map(s => s.trim()).filter(Boolean) : null,
        interpretationMode: formInterpMode,
        displayOrder: parseInt(formDisplayOrder) || 0,
        ranges: formRanges.map(r => ({
          minAgeDays: r.minAgeDays,
          maxAgeDays: r.maxAgeDays,
          gender: r.gender || null,
          referenceMin: r.referenceMin,
          referenceMax: r.referenceMax,
          referenceUnit: r.referenceUnit || null,
          referenceText: r.referenceText || null,
        })),
        interpretationRules: formRules.map(r => ({
          ruleType: r.ruleType,
          operator: r.operator,
          value1: r.value1,
          value2: r.value2,
          textMatch: r.textMatch || null,
          interpretationText: r.interpretationText,
          severity: r.severity || null,
          displayOrder: r.displayOrder,
          isActive: r.isActive,
        })),
      };

      let res: Response;
      if (formMode === 'create') {
        res = await fetch(`${API_BASE}/clinical-definitions`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
      } else {
        const ifMatch = editingDef?.updatedAt || '';
        res = await fetch(`${API_BASE}/clinical-definitions/${editingDef!.rootDefinitionId}/new-version`, {
          method: 'POST',
          headers: { ...headers, 'If-Match': ifMatch },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Save failed');
      }

      toast.success(formMode === 'create' ? 'Definition created' : 'New version created');
      setDialogOpen(false);
      resetForm();
      fetchDefinitions();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusTransition = async (def: TestDefinition, newStatus: string) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-definitions/${def.id}/status`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Transition failed');
      }
      toast.success(`Status changed to ${newStatus}`);
      fetchDefinitions();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleViewImpact = async (def: TestDefinition) => {
    try {
      const res = await fetch(`${API_BASE}/clinical-definitions/${def.rootDefinitionId}/impact`, { headers });
      if (!res.ok) throw new Error('Failed to fetch impact');
      setImpactData(await res.json());
      setImpactOpen(true);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const toggleVersionHistory = async (rootId: string) => {
    if (expandedRoot === rootId) {
      setExpandedRoot(null);
      setVersions([]);
    } else {
      setExpandedRoot(rootId);
      await fetchVersions(rootId);
    }
  };

  // ─── Range/Rule helpers ─────────────────────────────────────────────────

  const addRange = () => {
    setFormRanges([...formRanges, {
      minAgeDays: null, maxAgeDays: null, gender: null,
      referenceMin: null, referenceMax: null, referenceUnit: null, referenceText: null,
    }]);
  };

  const updateRange = (idx: number, field: string, val: any) => {
    const updated = [...formRanges];
    (updated[idx] as any)[field] = val;
    setFormRanges(updated);
  };

  const removeRange = (idx: number) => {
    setFormRanges(formRanges.filter((_, i) => i !== idx));
  };

  const addRule = () => {
    setFormRules([...formRules, {
      ruleType: 'NUMERIC_RANGE', operator: 'BETWEEN',
      value1: null, value2: null, textMatch: null,
      interpretationText: '', severity: null,
      displayOrder: formRules.length, isActive: true,
    }]);
  };

  const updateRule = (idx: number, field: string, val: any) => {
    const updated = [...formRules];
    (updated[idx] as any)[field] = val;
    setFormRules(updated);
  };

  const removeRule = (idx: number) => {
    setFormRules(formRules.filter((_, i) => i !== idx));
  };

  // ─── Status actions ─────────────────────────────────────────────────────

  const statusActions = (def: TestDefinition) => {
    const actions: { label: string; status: string; variant: any }[] = [];
    if (def.status === 'ACTIVE') actions.push({ label: 'Lock', status: 'LOCKED', variant: 'outline' });
    if (def.status === 'LOCKED') actions.push({ label: 'Deprecate', status: 'DEPRECATED', variant: 'outline' });
    if (def.status === 'DEPRECATED') actions.push({ label: 'Archive', status: 'ARCHIVED', variant: 'outline' });
    return actions;
  };

  // ─── Accordion validity checks ──────────────────────────────────────────

  const coreIdentityOk = Boolean(formName.trim() && formCode.trim());
  const defaultRangeOk = Boolean(
    formRefMin || formRefMax || formRefText || formUnit
  );
  const ageGenderOk = formRanges.length > 0;
  const derivedOk = Boolean(formFormula);
  const interpOk = formInterpMode !== 'NONE' && formRules.length > 0;

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FlaskConical className="h-5 w-5" /> Clinical Test Definitions
          </h2>
          <p className="text-sm text-muted-foreground">
            Versioned test definitions with reference ranges, interpretations, and derived formulas
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Definition
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or code..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="LOCKED">Locked</SelectItem>
            <SelectItem value="DEPRECATED">Deprecated</SelectItem>
            <SelectItem value="ARCHIVED">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Select value={deptFilter} onValueChange={setDeptFilter}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Department" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All depts</SelectItem>
            {departments.map(d => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Loading...</div>
      ) : definitions.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">No definitions found</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-8"></TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Test Name</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Sample</TableHead>
                <TableHead>Default Range</TableHead>
                <TableHead className="text-center">Ranges</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {definitions.map(def => (
                <>
                  <TableRow key={def.id} className="hover:bg-muted/50">
                    {/* Expand toggle */}
                    <TableCell className="pl-3 pr-0">
                      <button
                        onClick={() => toggleVersionHistory(def.rootDefinitionId)}
                        className="p-0.5 hover:bg-muted rounded"
                      >
                        {expandedRoot === def.rootDefinitionId
                          ? <ChevronDown className="h-4 w-4" />
                          : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </TableCell>

                    {/* Code badge */}
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {def.code}
                      </Badge>
                    </TableCell>

                    {/* Name with subtitle */}
                    <TableCell>
                      <div>
                        <div className="font-medium">{def.name}</div>
                        <div className="text-xs text-muted-foreground">
                          v{def.version}
                          {def.method && <> · {def.method}</>}
                        </div>
                      </div>
                    </TableCell>

                    {/* Department */}
                    <TableCell className="text-sm">
                      {def.department?.name || <span className="text-muted-foreground">—</span>}
                    </TableCell>

                    {/* Sample type with colored dot */}
                    <TableCell>
                      {def.sampleType ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block h-2 w-2 rounded-full ${sampleDotColor(def.sampleType)}`} />
                          <span className="text-sm">{def.sampleType}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>

                    {/* Default range */}
                    <TableCell className="text-sm font-mono">
                      {formatRange(def)}
                    </TableCell>

                    {/* Ranges count */}
                    <TableCell className="text-center">
                      {def.ranges?.length > 0 ? (
                        <Badge variant="outline" className="text-xs">
                          {def.ranges.length}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">0</span>
                      )}
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <Badge className={STATUS_COLORS[def.status] || ''}>{def.status}</Badge>
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="text-right">
                      <div className="flex items-center gap-0.5 justify-end">
                        {def.status === 'ACTIVE' && (
                          <Button size="sm" variant="ghost" onClick={() => openNewVersion(def)} title="New Version" className="h-7 w-7 p-0">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => handleViewImpact(def)} title="View Impact" className="h-7 w-7 p-0">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        {statusActions(def).map(a => (
                          <Button
                            key={a.status} size="sm" variant={a.variant}
                            onClick={() => handleStatusTransition(def, a.status)}
                            className="h-7 text-xs px-2"
                          >
                            {a.status === 'LOCKED' && <Lock className="h-3 w-3 mr-1" />}
                            {a.status === 'ARCHIVED' && <Archive className="h-3 w-3 mr-1" />}
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>

                  {/* Version history rows */}
                  {expandedRoot === def.rootDefinitionId && versions.length > 0 && versions.map(v => (
                    <TableRow key={v.id} className="bg-muted/20">
                      <TableCell></TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <History className="h-3 w-3" /> v{v.version}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{v.name}</TableCell>
                      <TableCell></TableCell>
                      <TableCell></TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {formatRange(v)}
                      </TableCell>
                      <TableCell className="text-center text-xs text-muted-foreground">
                        {v.ranges?.length || 0}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_COLORS[v.status] || ''} variant="outline">{v.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {new Date(v.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-right">
        Showing {definitions.length} definition{definitions.length !== 1 ? 's' : ''}
      </p>

      {/* ─── Create/New-Version Dialog (Accordion Layout) ─────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {formMode === 'create' ? 'New Clinical Definition' : `New Version of "${editingDef?.name}"`}
            </DialogTitle>
            <DialogDescription>
              {formMode === 'create'
                ? 'Define a new clinical test with reference ranges and interpretation rules.'
                : 'Clone the current version with your changes. The old version will be locked.'}
            </DialogDescription>
          </DialogHeader>

          <Accordion type="multiple" defaultValue={['core-identity']} className="w-full">
            {/* ─── Core Identity ─────────────────────────────────────── */}
            <AccordionItem value="core-identity">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <SectionStatus ok={coreIdentityOk} />
                  <span className="font-medium">Core Identity</span>
                  {coreIdentityOk && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {formCode || '...'} · {formName || '...'}
                    </span>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="space-y-1.5">
                    <Label>Test Code *</Label>
                    <Input
                      value={formCode}
                      onChange={e => setFormCode(e.target.value)}
                      placeholder="e.g., HB, FBS, TSH"
                      disabled={formMode === 'new-version'}
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Test Name *</Label>
                    <Input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g., Haemoglobin" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Department</Label>
                    <Select value={formDepartmentId || '__none__'} onValueChange={v => setFormDepartmentId(v === '__none__' ? '' : v)}>
                      <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Sample Type</Label>
                    <Input value={formSampleType} onChange={e => setFormSampleType(e.target.value)} placeholder="e.g., Blood, Serum" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Method</Label>
                    <Input value={formMethod} onChange={e => setFormMethod(e.target.value)} placeholder="e.g., ECLIA, GOD-POD" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Display Order</Label>
                    <Input type="number" value={formDisplayOrder} onChange={e => setFormDisplayOrder(e.target.value)} />
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ─── Default Reference Range ──────────────────────────── */}
            <AccordionItem value="default-range">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <SectionStatus ok={defaultRangeOk} />
                  <span className="font-medium">Default Reference Range</span>
                  {defaultRangeOk && (
                    <span className="text-xs text-muted-foreground ml-2">
                      {formRefMin || '?'} – {formRefMax || '?'} {formUnit}
                    </span>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-3 gap-4 pt-2">
                  <div className="space-y-1.5">
                    <Label>Min Value</Label>
                    <Input type="number" value={formRefMin} onChange={e => setFormRefMin(e.target.value)} placeholder="e.g., 12" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Max Value</Label>
                    <Input type="number" value={formRefMax} onChange={e => setFormRefMax(e.target.value)} placeholder="e.g., 16" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Unit</Label>
                    <Input value={formUnit} onChange={e => setFormUnit(e.target.value)} placeholder="e.g., g/dL" />
                  </div>
                  <div className="col-span-3 space-y-1.5">
                    <Label>Reference Text</Label>
                    <Input value={formRefText} onChange={e => setFormRefText(e.target.value)} placeholder="e.g., Negative, Non-reactive" />
                    <p className="text-xs text-muted-foreground">For qualitative tests, use text instead of min/max values</p>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ─── Age/Gender Ranges ────────────────────────────────── */}
            <AccordionItem value="age-gender-ranges">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <SectionStatus ok={ageGenderOk} />
                  <span className="font-medium">Age/Gender Specific Ranges</span>
                  <Badge variant="outline" className="text-xs ml-2">
                    {formRanges.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">Define different reference ranges for specific age groups or genders</p>
                    <Button size="sm" variant="outline" onClick={addRange}>
                      <Plus className="h-3 w-3 mr-1" /> Add Range
                    </Button>
                  </div>

                  {formRanges.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No age/gender ranges configured. The default range will be used for all patients.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {/* Header */}
                      <div className="grid grid-cols-8 gap-1 text-xs font-medium text-muted-foreground px-1">
                        <span>Min Days</span>
                        <span>Max Days</span>
                        <span>Gender</span>
                        <span>Min</span>
                        <span>Max</span>
                        <span>Unit</span>
                        <span>Text</span>
                        <span></span>
                      </div>
                      {formRanges.map((r, i) => (
                        <div key={i} className="grid grid-cols-8 gap-1 items-center">
                          <Input type="number" placeholder="0" value={r.minAgeDays ?? ''} onChange={e => updateRange(i, 'minAgeDays', e.target.value ? parseInt(e.target.value) : null)} className="h-8 text-xs" />
                          <Input type="number" placeholder="∞" value={r.maxAgeDays ?? ''} onChange={e => updateRange(i, 'maxAgeDays', e.target.value ? parseInt(e.target.value) : null)} className="h-8 text-xs" />
                          <Select value={r.gender || '__any__'} onValueChange={v => updateRange(i, 'gender', v === '__any__' ? null : v)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Any" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__any__">Any</SelectItem>
                              <SelectItem value="M">Male</SelectItem>
                              <SelectItem value="F">Female</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input type="number" placeholder="Min" value={r.referenceMin ?? ''} onChange={e => updateRange(i, 'referenceMin', e.target.value ? parseFloat(e.target.value) : null)} className="h-8 text-xs" />
                          <Input type="number" placeholder="Max" value={r.referenceMax ?? ''} onChange={e => updateRange(i, 'referenceMax', e.target.value ? parseFloat(e.target.value) : null)} className="h-8 text-xs" />
                          <Input placeholder="Unit" value={r.referenceUnit ?? ''} onChange={e => updateRange(i, 'referenceUnit', e.target.value || null)} className="h-8 text-xs" />
                          <Input placeholder="Text" value={r.referenceText ?? ''} onChange={e => updateRange(i, 'referenceText', e.target.value || null)} className="h-8 text-xs" />
                          <Button size="sm" variant="ghost" onClick={() => removeRange(i)} className="h-8 w-8 p-0 text-red-500">✕</Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ─── Derived Formula ──────────────────────────────────── */}
            <AccordionItem value="derived-formula">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <SectionStatus ok={derivedOk} />
                  <span className="font-medium">Derived Formula</span>
                  {derivedOk && (
                    <span className="text-xs text-muted-foreground ml-2 font-mono truncate max-w-[200px]">
                      {formFormula}
                    </span>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4 pt-2">
                  <div className="space-y-1.5">
                    <Label>Formula Expression</Label>
                    <Textarea
                      value={formFormula}
                      onChange={e => setFormFormula(e.target.value)}
                      placeholder="e.g., MCV * RDW / 100"
                      rows={3}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Use test codes as variables. Supported operators: +, -, *, /, (, )
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Depends On Codes</Label>
                    <Input
                      value={formDependsOn}
                      onChange={e => setFormDependsOn(e.target.value)}
                      placeholder="MCV, RDW"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated list of test codes this formula depends on
                    </p>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* ─── Interpretation Rules ─────────────────────────────── */}
            <AccordionItem value="interpretation-rules">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <SectionStatus ok={interpOk} />
                  <span className="font-medium">Interpretation Rules</span>
                  <Badge variant="outline" className="text-xs ml-2">
                    {formRules.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4 pt-2">
                  {/* Interp mode */}
                  <div className="space-y-1.5 max-w-xs">
                    <Label>Interpretation Mode</Label>
                    <Select value={formInterpMode} onValueChange={setFormInterpMode}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {INTERPRETATION_MODES.map(m => <SelectItem key={m} value={m}>{m.replace(/_/g, ' ')}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  {formInterpMode !== 'NONE' && (
                    <>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          Define conditions and the interpretation text to display when matched
                        </p>
                        <Button size="sm" variant="outline" onClick={addRule}>
                          <Plus className="h-3 w-3 mr-1" /> Add Rule
                        </Button>
                      </div>

                      {formRules.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          No interpretation rules. Add rules to auto-generate interpretations.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {formRules.map((r, i) => (
                            <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/20">
                              <div className="grid grid-cols-4 gap-2">
                                <div className="space-y-1">
                                  <Label className="text-xs">Type</Label>
                                  <Select value={r.ruleType} onValueChange={v => updateRule(i, 'ruleType', v)}>
                                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      {RULE_TYPES.map(t => <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Operator</Label>
                                  <Select value={r.operator} onValueChange={v => updateRule(i, 'operator', v)}>
                                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      {OPERATORS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Value 1</Label>
                                  <Input type="number" value={r.value1 ?? ''} onChange={e => updateRule(i, 'value1', e.target.value ? parseFloat(e.target.value) : null)} className="h-8 text-xs" />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Value 2</Label>
                                  <Input type="number" value={r.value2 ?? ''} onChange={e => updateRule(i, 'value2', e.target.value ? parseFloat(e.target.value) : null)} className="h-8 text-xs" />
                                </div>
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                <div className="space-y-1">
                                  <Label className="text-xs">Text Match</Label>
                                  <Input placeholder="Pattern" value={r.textMatch ?? ''} onChange={e => updateRule(i, 'textMatch', e.target.value || null)} className="h-8 text-xs" />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Severity</Label>
                                  <Input placeholder="e.g., HIGH, LOW" value={r.severity ?? ''} onChange={e => updateRule(i, 'severity', e.target.value || null)} className="h-8 text-xs" />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Order</Label>
                                  <Input type="number" value={r.displayOrder} onChange={e => updateRule(i, 'displayOrder', parseInt(e.target.value) || 0)} className="h-8 text-xs" />
                                </div>
                              </div>
                              <div className="flex gap-2 items-start">
                                <div className="flex-1 space-y-1">
                                  <Label className="text-xs">Interpretation Text *</Label>
                                  <Textarea value={r.interpretationText} onChange={e => updateRule(i, 'interpretationText', e.target.value)} className="text-xs min-h-[50px]" />
                                </div>
                                <Button size="sm" variant="ghost" onClick={() => removeRule(i)} className="text-red-500 shrink-0 mt-5">
                                  ✕
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <DialogFooter className="pt-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : formMode === 'create' ? 'Create Definition' : 'Create New Version'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Impact Dialog ────────────────────────────────────────────────── */}
      <Dialog open={impactOpen} onOpenChange={setImpactOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500" /> Impact Analysis
            </DialogTitle>
          </DialogHeader>
          {impactData && (
            <div className="space-y-4 text-sm">
              <div>
                <p className="font-semibold mb-1">Panels using this definition:</p>
                {impactData.panels?.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-0.5">
                    {impactData.panels.map((p: any) => <li key={p.id}>{p.name}</li>)}
                  </ul>
                ) : <p className="text-muted-foreground">None</p>}
              </div>
              <Separator />
              <div>
                <p className="font-semibold mb-1">Products using this definition:</p>
                {impactData.products?.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-0.5">
                    {impactData.products.map((p: any) => (
                      <li key={p.id}>{p.name} <Badge variant="outline" className="text-xs ml-1">{p.code}</Badge></li>
                    ))}
                  </ul>
                ) : <p className="text-muted-foreground">None</p>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
