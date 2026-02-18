import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
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

interface Department {
  id: string;
  name: string;
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

const SAMPLE_TYPES = [
  'EDTA_BLOOD', 'SERUM', 'CITRATE_BLOOD', 'URINE', 'STOOL',
  'CSF', 'SPUTUM', 'SWAB', 'OTHER',
];

const emptyForm = {
  name: '',
  code: '',
  price: '',
  departmentId: '',
  sampleType: '',
  method: '',
  isPanel: false,
  displayOrder: '0',
  refMin: '',
  refMax: '',
  refUnit: '',
  refText: '',
};

function getHeaders(token: string | null) {
  const { activeBranchId } = useBranchStore.getState();
  return {
    'Authorization': `Bearer ${token}`,
    'X-Branch-Id': activeBranchId || '',
    'Content-Type': 'application/json',
  };
}

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

  // Collapsed departments
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());

  const fetchDepartments = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/departments`, {
        headers: getHeaders(token),
      });
      if (res.ok) {
        const data = await res.json();
        setDepartments(data);
      }
    } catch (err) {
      console.error('Error fetching departments:', err);
    }
  };

  const fetchTests = async () => {
    if (!token) return;
    try {
      const params = new URLSearchParams();
      if (showInactive) params.set('includeInactive', 'true');
      params.set('includeSubTests', 'false');

      const res = await fetch(`${API_BASE}/lab-tests?${params}`, {
        headers: getHeaders(token),
      });
      if (res.ok) {
        const data = await res.json();
        setTests(data);
      }
    } catch (err) {
      console.error('Error fetching tests:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDepartments();
    fetchTests();
  }, [token, showInactive]);

  // Filter tests
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

  // Group by department
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
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  };

  const openCreate = () => {
    setFormData(emptyForm);
    setEditingId(null);
    setDialogOpen(true);
  };

  const openEdit = (t: LabTestItem) => {
    setFormData({
      name: t.name,
      code: t.code,
      price: (t.priceInPaise / 100).toString(),
      departmentId: t.departmentId || '',
      sampleType: t.sampleType || '',
      method: t.method || '',
      isPanel: t.isPanel,
      displayOrder: t.displayOrder.toString(),
      refMin: t.referenceRange.min?.toString() ?? '',
      refMax: t.referenceRange.max?.toString() ?? '',
      refUnit: t.referenceRange.unit || '',
      refText: t.referenceRange.text || '',
    });
    setEditingId(t.id);
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.name || !formData.code || !formData.price) {
      toast.error('Name, code, and price are required');
      return;
    }

    const price = parseFloat(formData.price);
    if (isNaN(price) || price < 0) {
      toast.error('Price must be a non-negative number');
      return;
    }

    const body: any = {
      name: formData.name,
      code: formData.code.toUpperCase(),
      price,
      departmentId: formData.departmentId || null,
      sampleType: formData.sampleType || null,
      method: formData.method || null,
      isPanel: formData.isPanel,
      displayOrder: parseInt(formData.displayOrder) || 0,
      referenceRange: {
        min: formData.refMin ? parseFloat(formData.refMin) : null,
        max: formData.refMax ? parseFloat(formData.refMax) : null,
        unit: formData.refUnit || '',
        text: formData.refText || '',
      },
    };

    try {
      const url = editingId
        ? `${API_BASE}/lab-tests/${editingId}`
        : `${API_BASE}/lab-tests`;
      const method = editingId ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: getHeaders(token),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.message || `Failed to ${editingId ? 'update' : 'create'} test`);
        return;
      }

      toast.success(`Test ${editingId ? 'updated' : 'created'}`);
      setDialogOpen(false);
      await fetchTests();
    } catch (err) {
      console.error('Error saving test:', err);
      toast.error('Failed to save test');
    }
  };

  const handleToggleActive = async (t: LabTestItem) => {
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${t.id}`, {
        method: 'PATCH',
        headers: getHeaders(token),
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      if (!res.ok) {
        toast.error('Failed to toggle active status');
        return;
      }
      toast.success(`Test ${!t.isActive ? 'activated' : 'deactivated'}`);
      await fetchTests();
    } catch {
      toast.error('Failed to toggle active status');
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${deleteId}`, {
        method: 'DELETE',
        headers: getHeaders(token),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.message || 'Failed to delete test');
        return;
      }
      toast.success('Test deleted');
      await fetchTests();
    } catch {
      toast.error('Failed to delete test');
    }
    setDeleteId(null);
  };

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
      <TableCell className="text-right font-mono">
        {(t.priceInPaise / 100).toFixed(0)}
      </TableCell>
      <TableCell className="text-right text-muted-foreground text-xs">
        {t.referenceRange.min !== null || t.referenceRange.max !== null
          ? `${t.referenceRange.min ?? ''}–${t.referenceRange.max ?? ''} ${t.referenceRange.unit}`
          : t.referenceRange.text || '—'}
      </TableCell>
      <TableCell>
        <Switch
          checked={t.isActive}
          onCheckedChange={() => handleToggleActive(t)}
        />
      </TableCell>
      <TableCell>
        <div className="flex gap-1 justify-end">
          <Button variant="ghost" size="icon" onClick={() => openEdit(t)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setDeleteId(t.id)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
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
          <Input
            placeholder="Search by name or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterDept} onValueChange={setFilterDept}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterPanel} onValueChange={setFilterPanel}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
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
        <Button onClick={openCreate} className="ml-auto">
          <Plus className="h-4 w-4 mr-2" />
          Add Test
        </Button>
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
                <>{/* Fragment key on the group header row */}
                  <TableRow
                    key={`dept-${deptId}`}
                    className="bg-muted/50 cursor-pointer hover:bg-muted"
                    onClick={() => toggleCollapse(deptId)}
                  >
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
                    <span className="flex items-center gap-2">
                      No Department
                      <Badge variant="secondary" className="text-xs">{ungrouped.length}</Badge>
                    </span>
                  </TableCell>
                </TableRow>
                {ungrouped.map(renderTestRow)}
              </>
            )}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No tests found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Test' : 'Add New Test'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Test Name *</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Haemoglobin"
                />
              </div>
              <div className="space-y-2">
                <Label>Code *</Label>
                <Input
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  placeholder="e.g. HGB"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Price (INR) *</Label>
                <Input
                  type="number"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  placeholder="e.g. 150"
                  min={0}
                />
              </div>
              <div className="space-y-2">
                <Label>Department</Label>
                <Select
                  value={formData.departmentId || 'none'}
                  onValueChange={(v) => setFormData({ ...formData, departmentId: v === 'none' ? '' : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sample Type</Label>
                <Select
                  value={formData.sampleType || 'none'}
                  onValueChange={(v) => setFormData({ ...formData, sampleType: v === 'none' ? '' : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {SAMPLE_TYPES.map((s) => (
                      <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Method</Label>
                <Input
                  value={formData.method}
                  onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                  placeholder="e.g. Colorimetric"
                />
              </div>
              <div className="space-y-2">
                <Label>Display Order</Label>
                <Input
                  type="number"
                  value={formData.displayOrder}
                  onChange={(e) => setFormData({ ...formData, displayOrder: e.target.value })}
                />
              </div>
              <div className="flex items-end gap-2 pb-2">
                <Switch
                  checked={formData.isPanel}
                  onCheckedChange={(v) => setFormData({ ...formData, isPanel: v })}
                  id="is-panel"
                />
                <Label htmlFor="is-panel">Is Panel</Label>
              </div>
            </div>
            <div className="border-t pt-4">
              <Label className="text-sm font-medium text-muted-foreground mb-2 block">Reference Range</Label>
              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Min</Label>
                  <Input
                    type="number"
                    value={formData.refMin}
                    onChange={(e) => setFormData({ ...formData, refMin: e.target.value })}
                    placeholder="e.g. 12"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Max</Label>
                  <Input
                    type="number"
                    value={formData.refMax}
                    onChange={(e) => setFormData({ ...formData, refMax: e.target.value })}
                    placeholder="e.g. 17"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Unit</Label>
                  <Input
                    value={formData.refUnit}
                    onChange={(e) => setFormData({ ...formData, refUnit: e.target.value })}
                    placeholder="e.g. g/dL"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Text</Label>
                  <Input
                    value={formData.refText}
                    onChange={(e) => setFormData({ ...formData, refText: e.target.value })}
                    placeholder="e.g. Negative"
                  />
                </div>
              </div>
            </div>
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
