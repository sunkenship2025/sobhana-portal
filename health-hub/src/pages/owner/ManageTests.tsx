import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

const ManageTests = () => {
  const { token } = useAuthStore();
  
  const [labTests, setLabTests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  
  // Fetch lab tests from API
  const fetchLabTests = async () => {
    if (!token) return;
    try {
      const res = await fetch('http://localhost:3000/api/lab-tests', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const tests = await res.json();
        setLabTests(tests);
      }
    } catch (err) {
      console.error('Error fetching lab tests:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLabTests();
  }, [token]);
  
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    price: '',
    min: '',
    max: '',
    unit: '',
  });

  const resetForm = () => {
    setFormData({ name: '', code: '', price: '', min: '', max: '', unit: '' });
    setShowForm(false);
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!formData.name || !formData.code || !formData.price) {
      toast.error('Please fill required fields');
      return;
    }

    const price = parseFloat(formData.price);
    if (isNaN(price) || price <= 0) {
      toast.error('Price must be a positive number');
      return;
    }

    const testData = {
      name: formData.name,
      code: formData.code.toUpperCase(),
      price,
      referenceRange: {
        min: parseFloat(formData.min) || 0,
        max: parseFloat(formData.max) || 0,
        unit: formData.unit || '',
      },
    };

    try {
      if (editingId) {
        // Update existing test via API
        const res = await fetch(`http://localhost:3000/api/lab-tests/${editingId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(testData)
        });
        
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to update test');
          return;
        }
        
        toast.success('Test updated');
      } else {
        // Create new test via API
        const res = await fetch('http://localhost:3000/api/lab-tests', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(testData)
        });
        
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to add test');
          return;
        }
        
        toast.success('Test added');
      }
      
      // Refresh the list
      await fetchLabTests();
      resetForm();
    } catch (err) {
      console.error('Error saving test:', err);
      toast.error('Failed to save test');
    }
  };

  const handleEdit = (test: typeof labTests[0]) => {
    setFormData({
      name: test.name,
      code: test.code,
      price: test.price.toString(),
      min: test.referenceRange.min.toString(),
      max: test.referenceRange.max.toString(),
      unit: test.referenceRange.unit,
    });
    setEditingId(test.id);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (deleteId) {
      try {
        const res = await fetch(`http://localhost:3000/api/lab-tests/${deleteId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to delete test');
          return;
        }
        
        toast.success('Test deleted');
        await fetchLabTests();
      } catch (err) {
        console.error('Error deleting test:', err);
        toast.error('Failed to delete test');
      }
      setDeleteId(null);
    }
  };

  return (
    <AppLayout context="owner">
      <div className="max-w-5xl mx-auto space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Manage Lab Tests</h1>
            <p className="text-muted-foreground">Add and configure lab tests with pricing and reference ranges.</p>
          </div>
          {!showForm && (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Test
            </Button>
          )}
        </div>

        {showForm && (
          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle>{editingId ? 'Edit Test' : 'Add New Test'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="name">Test Name *</Label>
                  <Input
                    id="name"
                    placeholder="e.g. Complete Blood Count"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Code *</Label>
                  <Input
                    id="code"
                    placeholder="e.g. CBC"
                    value={formData.code}
                    onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="price">Price (₹) *</Label>
                  <Input
                    id="price"
                    type="number"
                    placeholder="e.g. 350"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    min={0}
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="min">Reference Min</Label>
                  <Input
                    id="min"
                    type="number"
                    placeholder="e.g. 0"
                    value={formData.min}
                    onChange={(e) => setFormData({ ...formData, min: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max">Reference Max</Label>
                  <Input
                    id="max"
                    type="number"
                    placeholder="e.g. 100"
                    value={formData.max}
                    onChange={(e) => setFormData({ ...formData, max: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unit">Unit</Label>
                  <Input
                    id="unit"
                    placeholder="e.g. mg/dL"
                    value={formData.unit}
                    onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={resetForm}>
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
                <Button onClick={handleSubmit}>
                  <Check className="h-4 w-4 mr-2" />
                  {editingId ? 'Update' : 'Add'} Test
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Lab Tests ({labTests.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {labTests.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No tests added yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Range</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {labTests.map((test) => (
                    <TableRow key={test.id}>
                      <TableCell className="font-medium">{test.name}</TableCell>
                      <TableCell className="font-mono">{test.code}</TableCell>
                      <TableCell className="text-right">₹{test.price}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {test.referenceRange.min > 0 || test.referenceRange.max > 0
                          ? `${test.referenceRange.min}–${test.referenceRange.max} ${test.referenceRange.unit}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-2 justify-end">
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(test)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(test.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Test?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The test will be removed from the list.
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
    </AppLayout>
  );
};

export default ManageTests;
