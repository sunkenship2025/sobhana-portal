import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronRight, ArrowLeft } from 'lucide-react';
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

interface LabTestSummary {
  id: string;
  name: string;
  code: string;
  isPanel: boolean;
  department: { id: string; name: string } | null;
  _count: { ageRanges: number; stockRequirements: number; interpretations: number };
}

interface InterpretationTemplate {
  id: string;
  testId: string;
  minValue: number | null;
  maxValue: number | null;
  interpretationText: string;
  displayOrder: number;
  isActive: boolean;
}

export default function ManageInterpretations() {
  const { token } = useAuthStore();
  const [tests, setTests] = useState<LabTestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Selected test for interpretation editing
  const [selectedTest, setSelectedTest] = useState<LabTestSummary | null>(null);
  const [templates, setTemplates] = useState<InterpretationTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // Form
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({
    minValue: '', maxValue: '', interpretationText: '', displayOrder: '0',
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

  const fetchTests = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests?includeInactive=true`, { headers: getHeaders(false) });
      if (res.ok) setTests(await res.json());
    } catch (err) {
      console.error('Error fetching tests:', err);
      toast.error('Failed to load tests');
    } finally {
      setLoading(false);
    }
  };

  const fetchTemplates = async (testId: string) => {
    setTemplatesLoading(true);
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${testId}/interpretations`, { headers: getHeaders(false) });
      if (res.ok) setTemplates(await res.json());
    } catch (err) {
      console.error('Error fetching interpretations:', err);
      toast.error('Failed to load interpretations');
    } finally {
      setTemplatesLoading(false);
    }
  };

  useEffect(() => { fetchTests(); }, [token]);

  const handleSelectTest = (test: LabTestSummary) => {
    setSelectedTest(test);
    fetchTemplates(test.id);
  };

  const handleBack = () => {
    setSelectedTest(null);
    setTemplates([]);
  };

  const resetForm = () => {
    setForm({ minValue: '', maxValue: '', interpretationText: '', displayOrder: '0' });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleEdit = (tpl: InterpretationTemplate) => {
    setForm({
      minValue: tpl.minValue !== null ? tpl.minValue.toString() : '',
      maxValue: tpl.maxValue !== null ? tpl.maxValue.toString() : '',
      interpretationText: tpl.interpretationText,
      displayOrder: tpl.displayOrder.toString(),
    });
    setEditingId(tpl.id);
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!selectedTest) return;
    if (!form.interpretationText.trim()) {
      toast.error('Interpretation text is required');
      return;
    }

    const body: any = {
      interpretationText: form.interpretationText.trim(),
      displayOrder: parseInt(form.displayOrder) || 0,
    };
    if (form.minValue !== '') body.minValue = parseFloat(form.minValue);
    if (form.maxValue !== '') body.maxValue = parseFloat(form.maxValue);

    try {
      if (editingId) {
        const res = await fetch(`${API_BASE}/lab-tests/${selectedTest.id}/interpretations/${editingId}`, {
          method: 'PATCH', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Interpretation updated');
      } else {
        const res = await fetch(`${API_BASE}/lab-tests/${selectedTest.id}/interpretations`, {
          method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Interpretation created');
      }

      await fetchTemplates(selectedTest.id);
      await fetchTests();
      resetForm();
    } catch (err) {
      toast.error('Failed to save interpretation');
    }
  };

  const handleDelete = async () => {
    if (!deleteId || !selectedTest) return;
    try {
      const res = await fetch(`${API_BASE}/lab-tests/${selectedTest.id}/interpretations/${deleteId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { toast.error('Failed to deactivate'); return; }
      toast.success('Interpretation deactivated');
      await fetchTemplates(selectedTest.id);
      await fetchTests();
    } catch { toast.error('Failed to deactivate'); }
    setDeleteId(null);
  };

  const filteredTests = tests.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.code.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading tests...</div>;
  }

  // ── Detail view: interpretations for a selected test ────────────
  if (selectedTest) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h3 className="text-lg font-semibold">{selectedTest.name} ({selectedTest.code})</h3>
            <p className="text-sm text-muted-foreground">Manage interpretation templates for this test.</p>
          </div>
          <div className="ml-auto">
            <Button onClick={handleAdd}>
              <Plus className="h-4 w-4 mr-2" /> Add Interpretation
            </Button>
          </div>
        </div>

        {templatesLoading ? (
          <div className="py-8 text-center text-muted-foreground">Loading...</div>
        ) : templates.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No interpretations yet for this test.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Min</TableHead>
                <TableHead className="text-center">Max</TableHead>
                <TableHead>Interpretation Text</TableHead>
                <TableHead className="text-center">Order</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((tpl) => (
                <TableRow key={tpl.id}>
                  <TableCell className="text-center font-mono">{tpl.minValue ?? '---'}</TableCell>
                  <TableCell className="text-center font-mono">{tpl.maxValue ?? '---'}</TableCell>
                  <TableCell className="max-w-xs truncate">{tpl.interpretationText}</TableCell>
                  <TableCell className="text-center font-mono">{tpl.displayOrder}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(tpl)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteId(tpl.id)}>
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
              <DialogTitle>{editingId ? 'Edit Interpretation' : 'Add Interpretation'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tpl-min">Min Value (optional)</Label>
                  <Input id="tpl-min" type="number" step="0.01" placeholder="e.g. 0"
                    value={form.minValue}
                    onChange={(e) => setForm({ ...form, minValue: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tpl-max">Max Value (optional)</Label>
                  <Input id="tpl-max" type="number" step="0.01" placeholder="e.g. 5.0"
                    value={form.maxValue}
                    onChange={(e) => setForm({ ...form, maxValue: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-text">Interpretation Text *</Label>
                <Textarea id="tpl-text" rows={4}
                  placeholder="When value falls in this range, this interpretation is shown on the report."
                  value={form.interpretationText}
                  onChange={(e) => setForm({ ...form, interpretationText: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-order">Display Order</Label>
                <Input id="tpl-order" type="number" min={0} value={form.displayOrder}
                  onChange={(e) => setForm({ ...form, displayOrder: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={resetForm}>Cancel</Button>
              <Button onClick={handleSubmit}>{editingId ? 'Update' : 'Create'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Interpretation?</AlertDialogTitle>
              <AlertDialogDescription>
                This will deactivate the interpretation template. It will no longer appear on new reports.
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

  // ── List view: all tests with interpretation counts ─────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground">
          Select a test to manage its interpretation templates (auto-text based on value ranges).
        </p>
        <Input
          placeholder="Search tests..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {filteredTests.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">No tests found.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Test</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="text-center">Interpretations</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTests.map((test) => (
              <TableRow key={test.id} className="cursor-pointer hover:bg-muted/50" onClick={() => handleSelectTest(test)}>
                <TableCell className="font-medium">
                  {test.name}
                  {test.isPanel && <Badge variant="outline" className="ml-2 text-xs">Panel</Badge>}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">{test.code}</TableCell>
                <TableCell>{test.department?.name || '---'}</TableCell>
                <TableCell className="text-center">
                  {test._count.interpretations > 0 ? (
                    <Badge variant="secondary">{test._count.interpretations}</Badge>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
