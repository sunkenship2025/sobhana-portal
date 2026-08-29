import { useState } from 'react';
import { useApiQuery, useApiMutation, branchRequest, useBranchId, qk } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
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

interface DiagnosticCenter {
  id: string;
  centerNumber: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  commissionPercent: number;
  isActive: boolean;
}

const EMPTY_FORM = {
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  commissionPercent: '0',
};

export default function ManageDiagnosticCenters() {
  const branchId = useBranchId();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [formData, setFormData] = useState({ ...EMPTY_FORM });

  // Branch-scoped list (X-Branch-Id header) → branchId belongs in the key.
  const { data: centers = [], isLoading: loading } = useApiQuery<DiagnosticCenter[]>({
    branchScoped: true,
    // "all" — see OutsideLabs: includeInactive must not share the dropdown's key.
    queryKey: [...qk.diagnosticCenters(branchId), "all"],
    queryFn: () =>
      branchRequest<DiagnosticCenter[]>(
        '/diagnostic-centers?includeInactive=true',
        branchId!,
      ),
  });

  const saveMutation = useApiMutation<
    DiagnosticCenter,
    { editingId: string | null; payload: Record<string, unknown> }
  >({
    mutationFn: ({ editingId, payload }) =>
      branchRequest<DiagnosticCenter>(
        editingId ? `/diagnostic-centers/${editingId}` : '/diagnostic-centers',
        branchId!,
        { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    invalidate: [qk.diagnosticCenters(branchId)],
    onSuccess: (_data, { editingId }) => {
      toast.success(editingId ? 'Diagnostic center updated' : 'Diagnostic center created');
      resetForm();
    },
    onError: (err) => toast.error(err.message || 'Failed to save diagnostic center'),
  });

  const toggleMutation = useApiMutation<DiagnosticCenter, DiagnosticCenter>({
    mutationFn: (center) =>
      branchRequest<DiagnosticCenter>(`/diagnostic-centers/${center.id}`, branchId!, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !center.isActive }),
      }),
    invalidate: [qk.diagnosticCenters(branchId)],
    onSuccess: (_data, center) =>
      toast.success(`Center ${!center.isActive ? 'activated' : 'deactivated'}`),
    onError: (err) => toast.error(err.message || 'Failed to update status'),
  });

  const deleteMutation = useApiMutation<void, string>({
    mutationFn: (id) =>
      branchRequest<void>(`/diagnostic-centers/${id}`, branchId!, { method: 'DELETE' }),
    invalidate: [qk.diagnosticCenters(branchId)],
    onSuccess: () => toast.success('Diagnostic center deactivated'),
    onError: (err) => toast.error(err.message || 'Failed to delete center'),
    onSettled: () => setDeleteId(null),
  });

  const resetForm = () => {
    setFormData({ ...EMPTY_FORM });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    setFormData({ ...EMPTY_FORM });
    setEditingId(null);
    setDialogOpen(true);
  };

  const handleEdit = (center: DiagnosticCenter) => {
    setFormData({
      name: center.name,
      contactPerson: center.contactPerson || '',
      phone: center.phone || '',
      email: center.email || '',
      address: center.address || '',
      commissionPercent: center.commissionPercent.toString(),
    });
    setEditingId(center.id);
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast.error('Center name is required');
      return;
    }

    const commission = parseFloat(formData.commissionPercent);
    if (isNaN(commission) || commission < 0 || commission > 100) {
      toast.error('Commission must be between 0 and 100');
      return;
    }

    saveMutation.mutate({
      editingId,
      payload: {
        name: formData.name.trim(),
        contactPerson: formData.contactPerson.trim() || null,
        phone: formData.phone.trim() || null,
        email: formData.email.trim() || null,
        address: formData.address.trim() || null,
        commissionPercent: commission,
      },
    });
  };

  const handleToggleActive = (center: DiagnosticCenter) => {
    toggleMutation.mutate(center);
  };

  const handleDelete = () => {
    if (deleteId) deleteMutation.mutate(deleteId);
  };

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading diagnostic centers...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground">
          Manage external diagnostic referral centers and their commission rates.
        </p>
        <Button onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-2" />
          Add Center
        </Button>
      </div>

      {centers.length === 0 ? (
        <EmptyState title="No diagnostic centers yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Center #</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Contact Person</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="text-right">Commission %</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {centers.map((center) => (
              <TableRow key={center.id} className={!center.isActive ? 'opacity-50' : ''}>
                <TableCell className="font-mono">{center.centerNumber}</TableCell>
                <TableCell className="font-medium">{center.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {center.contactPerson || '---'}
                </TableCell>
                <TableCell>{center.phone || '---'}</TableCell>
                <TableCell className="text-right font-mono">{center.commissionPercent}%</TableCell>
                <TableCell className="text-center">
                  <Switch
                    checked={center.isActive}
                    onCheckedChange={() => handleToggleActive(center)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(center)} aria-label="Edit center">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteId(center.id)} aria-label="Delete center">
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
            <DialogTitle>{editingId ? 'Edit Diagnostic Center' : 'Add Diagnostic Center'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="center-name">Name *</Label>
              <Input
                id="center-name"
                placeholder="e.g. City Diagnostics Lab"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="center-contact">Contact Person</Label>
                <Input
                  id="center-contact"
                  placeholder="e.g. Dr. Sharma"
                  value={formData.contactPerson}
                  onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="center-phone">Phone</Label>
                <Input
                  id="center-phone"
                  placeholder="e.g. 9876543210"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  maxLength={10}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="center-email">Email</Label>
              <Input
                id="center-email"
                type="email"
                placeholder="e.g. info@citydiagnostics.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="center-address">Address</Label>
              <Input
                id="center-address"
                placeholder="e.g. 123 Main Street, City"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="center-commission">Commission %</Label>
              <Input
                id="center-commission"
                type="number"
                placeholder="0"
                value={formData.commissionPercent}
                onChange={(e) => setFormData({ ...formData, commissionPercent: e.target.value })}
                min={0}
                max={100}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetForm} disabled={saveMutation.isPending}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving...' : (editingId ? 'Update' : 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Diagnostic Center?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the diagnostic center. It will no longer appear in active lists but existing referral records will be preserved.
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
