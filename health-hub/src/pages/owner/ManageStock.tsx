import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ArrowUpCircle, ArrowDownCircle, AlertTriangle } from 'lucide-react';
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

interface StockItem {
  id: string;
  name: string;
  unit: string;
  currentQuantity: number;
  reorderLevel: number;
  isActive: boolean;
  branchId: string;
  _count: { transactions: number; requirements: number; alerts: number };
}

export default function ManageStock() {
  const { token } = useAuthStore();

  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);

  // Item dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '', unit: '', currentQuantity: '0', reorderLevel: '10',
  });

  // Transaction dialog
  const [txDialogOpen, setTxDialogOpen] = useState(false);
  const [txItemId, setTxItemId] = useState<string | null>(null);
  const [txForm, setTxForm] = useState({
    type: 'CREDIT' as 'CREDIT' | 'DEBIT' | 'ADJUSTMENT',
    quantity: '',
    notes: '',
  });

  const getHeaders = (includeContent = true) => {
    const { activeBranchId } = useBranchStore.getState();
    const h: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'X-Branch-Id': activeBranchId || '',
    };
    if (includeContent) h['Content-Type'] = 'application/json';
    return h;
  };

  const fetchItems = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/stock?includeInactive=true`, { headers: getHeaders(false) });
      if (res.ok) setItems(await res.json());
    } catch (err) {
      console.error('Error fetching stock:', err);
      toast.error('Failed to load stock items');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchItems(); }, [token]);

  const resetForm = () => {
    setForm({ name: '', unit: '', currentQuantity: '0', reorderLevel: '10' });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleEdit = (item: StockItem) => {
    setForm({
      name: item.name,
      unit: item.unit,
      currentQuantity: item.currentQuantity.toString(),
      reorderLevel: item.reorderLevel.toString(),
    });
    setEditingId(item.id);
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.unit.trim()) {
      toast.error('Name and unit are required');
      return;
    }

    try {
      if (editingId) {
        const res = await fetch(`${API_BASE}/stock/${editingId}`, {
          method: 'PATCH', headers: getHeaders(),
          body: JSON.stringify({
            name: form.name.trim(),
            unit: form.unit.trim(),
            reorderLevel: parseInt(form.reorderLevel) || 10,
          }),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Stock item updated');
      } else {
        const res = await fetch(`${API_BASE}/stock`, {
          method: 'POST', headers: getHeaders(),
          body: JSON.stringify({
            name: form.name.trim(),
            unit: form.unit.trim(),
            currentQuantity: parseInt(form.currentQuantity) || 0,
            reorderLevel: parseInt(form.reorderLevel) || 10,
          }),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Stock item created');
      }

      await fetchItems();
      resetForm();
    } catch (err) {
      toast.error('Failed to save stock item');
    }
  };

  const handleToggleActive = async (item: StockItem) => {
    try {
      const res = await fetch(`${API_BASE}/stock/${item.id}`, {
        method: 'PATCH', headers: getHeaders(),
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      if (!res.ok) { toast.error('Failed to update status'); return; }
      toast.success(`Item ${!item.isActive ? 'activated' : 'deactivated'}`);
      await fetchItems();
    } catch { toast.error('Failed to update status'); }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${API_BASE}/stock/${deleteId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { toast.error('Failed to deactivate'); return; }
      toast.success('Stock item deactivated');
      await fetchItems();
    } catch { toast.error('Failed to deactivate'); }
    setDeleteId(null);
  };

  // ── Transactions ─────────────────────────────────────────────
  const openTxDialog = (itemId: string) => {
    setTxItemId(itemId);
    setTxForm({ type: 'CREDIT', quantity: '', notes: '' });
    setTxDialogOpen(true);
  };

  const handleSubmitTx = async () => {
    if (!txItemId) return;
    const qty = parseInt(txForm.quantity);
    if (isNaN(qty) || qty <= 0) {
      toast.error('Quantity must be a positive number');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/stock/${txItemId}/transactions`, {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({
          type: txForm.type,
          quantity: qty,
          notes: txForm.notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        toast.error(e.message || 'Transaction failed');
        return;
      }
      toast.success(`Stock ${txForm.type.toLowerCase()} recorded`);
      await fetchItems();
      setTxDialogOpen(false);
    } catch (err) {
      toast.error('Failed to record transaction');
    }
  };

  const filtered = items
    .filter(i =>
      i.name.toLowerCase().includes(search.toLowerCase()) ||
      i.unit.toLowerCase().includes(search.toLowerCase())
    )
    .filter(i => !showLowOnly || i.currentQuantity < i.reorderLevel);

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading stock items...</div>;
  }

  const lowStockCount = items.filter(i => i.isActive && i.currentQuantity < i.reorderLevel).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground">
            Manage reagents, consumables, and lab supplies.
          </p>
          {lowStockCount > 0 && (
            <Badge variant="destructive" className="flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {lowStockCount} low
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Switch checked={showLowOnly} onCheckedChange={setShowLowOnly} />
            Low stock only
          </label>
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48"
          />
          <Button onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-2" /> Add Item
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">No stock items found.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-center">Qty</TableHead>
              <TableHead className="text-center">Reorder At</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => {
              const isLow = item.currentQuantity < item.reorderLevel;
              return (
                <TableRow key={item.id} className={!item.isActive ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="text-muted-foreground">{item.unit}</TableCell>
                  <TableCell className="text-center font-mono font-bold">
                    {item.currentQuantity}
                  </TableCell>
                  <TableCell className="text-center font-mono">{item.reorderLevel}</TableCell>
                  <TableCell className="text-center">
                    {isLow ? (
                      <Badge variant="destructive" className="text-xs">Low Stock</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">OK</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch checked={item.isActive} onCheckedChange={() => handleToggleActive(item)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" title="Add stock"
                        onClick={() => openTxDialog(item.id)}>
                        <ArrowUpCircle className="h-4 w-4 text-green-600" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(item)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteId(item.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Create / Edit Item Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Stock Item' : 'Add Stock Item'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="stock-name">Name *</Label>
              <Input id="stock-name" placeholder="e.g. EDTA Vacutainer" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stock-unit">Unit *</Label>
              <Input id="stock-unit" placeholder="e.g. tubes, mL, pieces" value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </div>
            {!editingId && (
              <div className="space-y-2">
                <Label htmlFor="stock-qty">Initial Quantity</Label>
                <Input id="stock-qty" type="number" min={0} value={form.currentQuantity}
                  onChange={(e) => setForm({ ...form, currentQuantity: e.target.value })} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="stock-reorder">Reorder Level</Label>
              <Input id="stock-reorder" type="number" min={0} value={form.reorderLevel}
                onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetForm}>Cancel</Button>
            <Button onClick={handleSubmit}>{editingId ? 'Update' : 'Create'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transaction Dialog */}
      <Dialog open={txDialogOpen} onOpenChange={(open) => { if (!open) setTxDialogOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Stock Transaction</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Transaction Type</Label>
              <Select value={txForm.type} onValueChange={(v: any) => setTxForm({ ...txForm, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CREDIT">Credit (Add Stock)</SelectItem>
                  <SelectItem value="DEBIT">Debit (Use Stock)</SelectItem>
                  <SelectItem value="ADJUSTMENT">Adjustment (Set Quantity)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tx-qty">Quantity *</Label>
              <Input id="tx-qty" type="number" min={1} value={txForm.quantity}
                onChange={(e) => setTxForm({ ...txForm, quantity: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tx-notes">Notes</Label>
              <Input id="tx-notes" placeholder="Optional notes" value={txForm.notes}
                onChange={(e) => setTxForm({ ...txForm, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTxDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitTx}>Record</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Stock Item?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the stock item. Transaction history will be preserved.
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
