import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Department {
  id: string;
  name: string;
  reportHeaderText: string | null;
  displayOrder: number;
  isActive: boolean;
  _count: {
    labTests: number;
    panels: number;
    signingRules: number;
  };
}

export default function ManageDepartments() {
  const { token } = useAuthStore();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    reportHeaderText: '',
    displayOrder: '0',
  });

  const getHeaders = () => {
    const { activeBranchId } = useBranchStore.getState();
    return {
      'Authorization': `Bearer ${token}`,
      'X-Branch-Id': activeBranchId || '',
      'Content-Type': 'application/json',
    };
  };

  const fetchDepartments = async () => {
    if (!token) return;
    try {
      const { activeBranchId } = useBranchStore.getState();
      const res = await fetch(`${API_BASE}/departments?includeInactive=true`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId || '',
        },
      });
      if (res.ok) {
        const data = await res.json();
        setDepartments(data);
      } else {
        toast.error('Failed to load departments');
      }
    } catch (err) {
      console.error('Error fetching departments:', err);
      toast.error('Failed to load departments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDepartments();
  }, [token]);

  const resetForm = () => {
    setFormData({ name: '', reportHeaderText: '', displayOrder: '0' });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    setFormData({ name: '', reportHeaderText: '', displayOrder: '0' });
    setEditingId(null);
    setDialogOpen(true);
  };

  const handleEdit = (dept: Department) => {
    setFormData({
      name: dept.name,
      reportHeaderText: dept.reportHeaderText || '',
      displayOrder: dept.displayOrder.toString(),
    });
    setEditingId(dept.id);
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      toast.error('Department name is required');
      return;
    }

    const order = parseInt(formData.displayOrder) || 0;

    try {
      if (editingId) {
        const res = await fetch(`${API_BASE}/departments/${editingId}`, {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({
            name: formData.name.trim(),
            reportHeaderText: formData.reportHeaderText.trim() || null,
            displayOrder: order,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to update department');
          return;
        }

        toast.success('Department updated');
      } else {
        const res = await fetch(`${API_BASE}/departments`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            name: formData.name.trim(),
            reportHeaderText: formData.reportHeaderText.trim() || null,
            displayOrder: order,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to create department');
          return;
        }

        toast.success('Department created');
      }

      await fetchDepartments();
      resetForm();
    } catch (err) {
      console.error('Error saving department:', err);
      toast.error('Failed to save department');
    }
  };

  const handleToggleActive = async (dept: Department) => {
    try {
      const res = await fetch(`${API_BASE}/departments/${dept.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ isActive: !dept.isActive }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.message || 'Failed to update status');
        return;
      }

      toast.success(`Department ${!dept.isActive ? 'activated' : 'deactivated'}`);
      await fetchDepartments();
    } catch (err) {
      console.error('Error toggling department active:', err);
      toast.error('Failed to update status');
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${API_BASE}/departments/${deleteId}`, {
        method: 'DELETE',
        headers: getHeaders(),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.message || 'Failed to delete department');
        return;
      }

      toast.success('Department deactivated');
      await fetchDepartments();
    } catch (err) {
      console.error('Error deleting department:', err);
      toast.error('Failed to delete department');
    }
    setDeleteId(null);
  };

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading departments...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground">
          Manage departments for organizing tests, panels, and signing rules.
        </p>
        <Button onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-2" />
          Add Department
        </Button>
      </div>

      {departments.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">No departments yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Report Header</TableHead>
              <TableHead className="text-center">Order</TableHead>
              <TableHead className="text-center">Tests</TableHead>
              <TableHead className="text-center">Panels</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((dept) => (
              <TableRow key={dept.id} className={!dept.isActive ? 'opacity-50' : ''}>
                <TableCell className="font-medium">{dept.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {dept.reportHeaderText || '---'}
                </TableCell>
                <TableCell className="text-center font-mono">{dept.displayOrder}</TableCell>
                <TableCell className="text-center">{dept._count.labTests}</TableCell>
                <TableCell className="text-center">{dept._count.panels}</TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={dept.isActive}
                    onCheckedChange={() => handleToggleActive(dept)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(dept)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteId(dept.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Department' : 'Add Department'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="dept-name">Name *</Label>
              <Input
                id="dept-name"
                placeholder="e.g. BIOCHEMISTRY"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dept-header">Report Header Text</Label>
              <Input
                id="dept-header"
                placeholder="e.g. Biochemistry Report"
                value={formData.reportHeaderText}
                onChange={(e) => setFormData({ ...formData, reportHeaderText: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dept-order">Display Order</Label>
              <Input
                id="dept-order"
                type="number"
                placeholder="0"
                value={formData.displayOrder}
                onChange={(e) => setFormData({ ...formData, displayOrder: e.target.value })}
                min={0}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetForm}>Cancel</Button>
            <Button onClick={handleSubmit}>
              {editingId ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Department?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the department. Any linked tests and panels will remain but the department will no longer appear in active lists.
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
