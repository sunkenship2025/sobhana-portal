import { useState } from 'react';
import { useApiQuery, useApiMutation, branchRequest, useBranchId, qk } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Building2, Search, Beaker, LayoutGrid,
} from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/* ───────── Types ───────── */

interface Department {
  id: string;
  name: string;
  reportHeaderText: string | null;
  displayOrder: number;
  isActive: boolean;
  showLabIncharge: boolean;
  _count: {
    labTests: number;
    panels: number;
    signingRules: number;
  };
}

/* ───────── Helpers ───────── */

const DEPT_ICONS: Record<string, string> = {
  BIOCHEMISTRY: '🧪',
  HEMATOLOGY: '🩸',
  PATHOLOGY: '🔬',
  MICROBIOLOGY: '🦠',
  IMMUNOLOGY: '🛡️',
  RADIOLOGY: '📷',
  SEROLOGY: '💉',
};

function deptIcon(name: string) {
  const upper = name.toUpperCase();
  for (const [key, icon] of Object.entries(DEPT_ICONS)) {
    if (upper.includes(key)) return icon;
  }
  return '🏥';
}

function deptCode(name: string) {
  return name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map(w => w.substring(0, 3).toUpperCase())
    .join('')
    .substring(0, 6);
}

/* ───────── Component ───────── */

export default function ManageDepartments() {
  const branchId = useBranchId();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [formData, setFormData] = useState({
    name: '',
    reportHeaderText: '',
    displayOrder: '0',
    showLabIncharge: true,
  });

  // Branch-scoped list (X-Branch-Id header) → branchId belongs in the key.
  const { data: departments = [], isLoading: loading } = useApiQuery<Department[]>({
    branchScoped: true,
    queryKey: qk.departments(branchId),
    queryFn: () =>
      branchRequest<Department[]>('/departments?includeInactive=true', branchId!),
  });

  const saveMutation = useApiMutation<
    Department,
    { editingId: string | null; payload: Record<string, unknown> }
  >({
    mutationFn: ({ editingId, payload }) =>
      branchRequest<Department>(
        editingId ? `/departments/${editingId}` : '/departments',
        branchId!,
        { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    invalidate: [qk.departments(branchId)],
    onSuccess: (_data, { editingId }) => {
      toast.success(editingId ? 'Department updated' : 'Department created');
      resetForm();
    },
    onError: (err) => toast.error(err.message || 'Failed to save department'),
  });

  const toggleMutation = useApiMutation<Department, Department>({
    mutationFn: (dept) =>
      branchRequest<Department>(`/departments/${dept.id}`, branchId!, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !dept.isActive }),
      }),
    invalidate: [qk.departments(branchId)],
    onSuccess: (_data, dept) =>
      toast.success(`Department ${!dept.isActive ? 'activated' : 'deactivated'}`),
    onError: (err) => toast.error(err.message || 'Failed to update status'),
  });

  const deleteMutation = useApiMutation<void, string>({
    mutationFn: (id) =>
      branchRequest<void>(`/departments/${id}`, branchId!, { method: 'DELETE' }),
    invalidate: [qk.departments(branchId)],
    onSuccess: () => toast.success('Department deactivated'),
    onError: (err) => toast.error(err.message || 'Failed to delete department'),
    onSettled: () => setDeleteId(null),
  });

  const resetForm = () => {
    setFormData({ name: '', reportHeaderText: '', displayOrder: '0', showLabIncharge: true });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    setFormData({ name: '', reportHeaderText: '', displayOrder: '0', showLabIncharge: true });
    setEditingId(null);
    setDialogOpen(true);
  };

  const handleEdit = (dept: Department) => {
    setFormData({
      name: dept.name,
      reportHeaderText: dept.reportHeaderText || '',
      displayOrder: dept.displayOrder.toString(),
      showLabIncharge: dept.showLabIncharge ?? true,
    });
    setEditingId(dept.id);
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast.error('Department name is required');
      return;
    }

    const order = parseInt(formData.displayOrder) || 0;

    saveMutation.mutate({
      editingId,
      payload: {
        name: formData.name.trim(),
        reportHeaderText: formData.reportHeaderText.trim() || null,
        displayOrder: order,
        showLabIncharge: formData.showLabIncharge,
      },
    });
  };

  const handleToggleActive = (dept: Department) => {
    toggleMutation.mutate(dept);
  };

  const handleDelete = () => {
    if (deleteId) deleteMutation.mutate(deleteId);
  };

  // ─── Filter ─────────────────────────────────────────────────────────────

  const filtered = departments.filter(d => {
    if (!search) return true;
    const q = search.toLowerCase();
    return d.name.toLowerCase().includes(q) || (d.reportHeaderText || '').toLowerCase().includes(q);
  });

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">Loading departments...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Departments
          </h2>
          <p className="text-sm text-muted-foreground">
            Organize tests, panels and signing rules by department
          </p>
        </div>
        <Button onClick={handleAdd} size="sm">
          <Plus className="h-4 w-4 mr-1" /> Add Department
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search departments..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          {search ? 'No departments match your search' : 'No departments yet. Create one to get started.'}
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>Department</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Report Header</TableHead>
                <TableHead className="text-center">Tests</TableHead>
                <TableHead className="text-center">Panels</TableHead>
                <TableHead className="text-center">Order</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(dept => (
                <TableRow key={dept.id} className={!dept.isActive ? 'opacity-50' : ''}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span className="text-lg">{deptIcon(dept.name)}</span>
                      <div>
                        <div className="font-medium">{dept.name}</div>
                        {dept._count.signingRules > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {dept._count.signingRules} signing rule{dept._count.signingRules > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {deptCode(dept.name)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
                    {dept.reportHeaderText || '—'}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1 text-sm">
                      <Beaker className="h-3.5 w-3.5 text-muted-foreground" />
                      {dept._count.labTests}
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1 text-sm">
                      <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
                      {dept._count.panels}
                    </div>
                  </TableCell>
                  <TableCell className="text-center font-mono text-sm">{dept.displayOrder}</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={dept.isActive} onCheckedChange={() => handleToggleActive(dept)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(dept)} className="h-8 w-8" aria-label="Edit department">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteId(dept.id)} className="h-8 w-8" aria-label="Delete department">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-right">
        Showing {filtered.length} of {departments.length} departments
      </p>

      {/* ─── Create / Edit Dialog ─────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Department' : 'Add Department'}</DialogTitle>
            <DialogDescription>
              {editingId
                ? 'Update department details below.'
                : 'Create a new department to organize tests and panels.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">Department Name *</Label>
              <Input
                id="dept-name"
                placeholder="e.g. BIOCHEMISTRY"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
              />
              {formData.name && (
                <p className="text-xs text-muted-foreground">
                  Auto-code: <Badge variant="secondary" className="font-mono text-xs ml-1">{deptCode(formData.name)}</Badge>
                </p>
              )}
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="dept-header">Report Header Text</Label>
              <p className="text-xs text-muted-foreground">
                Displayed as the department heading on printed reports
              </p>
              <Textarea
                id="dept-header"
                placeholder="e.g. Biochemistry Report"
                value={formData.reportHeaderText}
                onChange={e => setFormData({ ...formData, reportHeaderText: e.target.value })}
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dept-order">Display Order</Label>
              <p className="text-xs text-muted-foreground">
                Controls the sort order on reports (lower numbers appear first)
              </p>
              <Input
                id="dept-order"
                type="number"
                placeholder="0"
                value={formData.displayOrder}
                onChange={e => setFormData({ ...formData, displayOrder: e.target.value })}
                min={0}
                className="max-w-[120px]"
              />
            </div>
            {/* "Show Lab Incharge on report" now lives on the Signing Rules page
                (per-department "Show lab incharge" checkbox), so this per-department
                toggle was retired to avoid two controls for the same thing. */}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetForm} disabled={saveMutation.isPending}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving...' : (editingId ? 'Update' : 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation ──────────────────────────────────────────── */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Department?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the department. Any linked tests and panels will remain but
              the department will no longer appear in active lists.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleteMutation.isPending} className="bg-destructive text-destructive-foreground">
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
