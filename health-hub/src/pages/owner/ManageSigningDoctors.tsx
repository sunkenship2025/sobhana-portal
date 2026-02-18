import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Link2 } from 'lucide-react';
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

interface SigningDoctor {
  id: string;
  name: string;
  degrees: string;
  designation: string;
  registrationNumber: string | null;
  signatureImagePath: string | null;
  isActive: boolean;
  _count: { signingRules: number };
}

interface Department {
  id: string;
  name: string;
}

interface SigningRule {
  id: string;
  departmentId: string;
  signingDoctorId: string;
  showLabInchargeNote: boolean;
  displayOrder: number;
  isActive: boolean;
  department: { id: string; name: string };
  signingDoctor: { id: string; name: string; degrees: string; designation: string };
}

export default function ManageSigningDoctors() {
  const { token } = useAuthStore();

  const [doctors, setDoctors] = useState<SigningDoctor[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rules, setRules] = useState<SigningRule[]>([]);
  const [loading, setLoading] = useState(true);

  // Doctor dialog
  const [doctorDialogOpen, setDoctorDialogOpen] = useState(false);
  const [editingDoctorId, setEditingDoctorId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [doctorForm, setDoctorForm] = useState({
    name: '', degrees: '', designation: '', registrationNumber: '',
  });

  // Rule dialog
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    departmentId: '', signingDoctorId: '', showLabInchargeNote: false, displayOrder: '1',
  });

  const getHeaders = () => {
    const { activeBranchId } = useBranchStore.getState();
    return {
      'Authorization': `Bearer ${token}`,
      'X-Branch-Id': activeBranchId || '',
      'Content-Type': 'application/json',
    };
  };

  const fetchAll = async () => {
    if (!token) return;
    try {
      const { activeBranchId } = useBranchStore.getState();
      const headers = {
        'Authorization': `Bearer ${token}`,
        'X-Branch-Id': activeBranchId || '',
      };

      const [docRes, deptRes, rulesRes] = await Promise.all([
        fetch(`${API_BASE}/signing-doctors?active=all`, { headers }),
        fetch(`${API_BASE}/departments`, { headers }),
        fetch(`${API_BASE}/signing-rules?active=all`, { headers }),
      ]);

      if (docRes.ok) setDoctors(await docRes.json());
      if (deptRes.ok) setDepartments(await deptRes.json());
      if (rulesRes.ok) setRules(await rulesRes.json());
    } catch (err) {
      console.error('Error fetching signing data:', err);
      toast.error('Failed to load signing data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, [token]);

  // ── Doctor CRUD ──────────────────────────────────────────────────
  const resetDoctorForm = () => {
    setDoctorForm({ name: '', degrees: '', designation: '', registrationNumber: '' });
    setDoctorDialogOpen(false);
    setEditingDoctorId(null);
  };

  const handleAddDoctor = () => {
    resetDoctorForm();
    setDoctorDialogOpen(true);
  };

  const handleEditDoctor = (doc: SigningDoctor) => {
    setDoctorForm({
      name: doc.name,
      degrees: doc.degrees,
      designation: doc.designation,
      registrationNumber: doc.registrationNumber || '',
    });
    setEditingDoctorId(doc.id);
    setDoctorDialogOpen(true);
  };

  const handleSubmitDoctor = async () => {
    if (!doctorForm.name.trim() || !doctorForm.degrees.trim() || !doctorForm.designation.trim()) {
      toast.error('Name, degrees, and designation are required');
      return;
    }

    try {
      const body = {
        name: doctorForm.name.trim(),
        degrees: doctorForm.degrees.trim(),
        designation: doctorForm.designation.trim(),
        registrationNumber: doctorForm.registrationNumber.trim() || null,
      };

      if (editingDoctorId) {
        const res = await fetch(`${API_BASE}/signing-doctors/${editingDoctorId}`, {
          method: 'PATCH', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to update'); return; }
        toast.success('Signing doctor updated');
      } else {
        const res = await fetch(`${API_BASE}/signing-doctors`, {
          method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to create'); return; }
        toast.success('Signing doctor created');
      }

      await fetchAll();
      resetDoctorForm();
    } catch (err) {
      console.error('Error saving signing doctor:', err);
      toast.error('Failed to save signing doctor');
    }
  };

  const handleToggleDoctor = async (doc: SigningDoctor) => {
    try {
      const res = await fetch(`${API_BASE}/signing-doctors/${doc.id}`, {
        method: 'PATCH', headers: getHeaders(),
        body: JSON.stringify({ isActive: !doc.isActive }),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success(`Doctor ${!doc.isActive ? 'activated' : 'deactivated'}`);
      await fetchAll();
    } catch { toast.error('Failed to update status'); }
  };

  const handleDeleteDoctor = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${API_BASE}/signing-doctors/${deleteId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success('Signing doctor deactivated');
      await fetchAll();
    } catch { toast.error('Failed to delete'); }
    setDeleteId(null);
  };

  // ── Rule CRUD ────────────────────────────────────────────────────
  const handleAddRule = () => {
    setRuleForm({ departmentId: '', signingDoctorId: '', showLabInchargeNote: false, displayOrder: '1' });
    setRuleDialogOpen(true);
  };

  const handleSubmitRule = async () => {
    if (!ruleForm.departmentId || !ruleForm.signingDoctorId) {
      toast.error('Department and doctor are required');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/signing-rules`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          departmentId: ruleForm.departmentId,
          signingDoctorId: ruleForm.signingDoctorId,
          showLabInchargeNote: ruleForm.showLabInchargeNote,
          displayOrder: parseInt(ruleForm.displayOrder) || 1,
        }),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to create rule'); return; }
      toast.success('Signing rule created');
      await fetchAll();
      setRuleDialogOpen(false);
    } catch { toast.error('Failed to create rule'); }
  };

  const handleToggleRule = async (rule: SigningRule) => {
    try {
      const res = await fetch(`${API_BASE}/signing-rules/${rule.id}`, {
        method: 'PATCH', headers: getHeaders(),
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!res.ok) { toast.error('Failed to update rule'); return; }
      await fetchAll();
    } catch { toast.error('Failed to update rule'); }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      const res = await fetch(`${API_BASE}/signing-rules/${ruleId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { toast.error('Failed to deactivate rule'); return; }
      toast.success('Rule deactivated');
      await fetchAll();
    } catch { toast.error('Failed to deactivate rule'); }
  };

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Loading signing data...</div>;
  }

  return (
    <div className="space-y-8">
      {/* ── Signing Doctors ─────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Signing Doctors</h3>
            <p className="text-sm text-muted-foreground">Doctors whose signatures appear on reports.</p>
          </div>
          <Button onClick={handleAddDoctor}>
            <Plus className="h-4 w-4 mr-2" /> Add Doctor
          </Button>
        </div>

        {doctors.length === 0 ? (
          <p className="text-center text-muted-foreground py-6">No signing doctors yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Degrees</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead>Reg. No.</TableHead>
                <TableHead className="text-center">Rules</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {doctors.map((doc) => (
                <TableRow key={doc.id} className={!doc.isActive ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">{doc.name}</TableCell>
                  <TableCell>{doc.degrees}</TableCell>
                  <TableCell>{doc.designation}</TableCell>
                  <TableCell className="text-muted-foreground">{doc.registrationNumber || '---'}</TableCell>
                  <TableCell className="text-center">{doc._count.signingRules}</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={doc.isActive} onCheckedChange={() => handleToggleDoctor(doc)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => handleEditDoctor(doc)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteId(doc.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {/* ── Signing Rules ───────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Signing Rules</h3>
            <p className="text-sm text-muted-foreground">Assign doctors to departments for report signing.</p>
          </div>
          <Button onClick={handleAddRule} variant="outline">
            <Link2 className="h-4 w-4 mr-2" /> Add Rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <p className="text-center text-muted-foreground py-6">No signing rules yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead>Doctor</TableHead>
                <TableHead className="text-center">Lab Incharge Note</TableHead>
                <TableHead className="text-center">Order</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id} className={!rule.isActive ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">{rule.department.name}</TableCell>
                  <TableCell>{rule.signingDoctor.name} — {rule.signingDoctor.degrees}</TableCell>
                  <TableCell className="text-center">{rule.showLabInchargeNote ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-center font-mono">{rule.displayOrder}</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={rule.isActive} onCheckedChange={() => handleToggleRule(rule)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleDeleteRule(rule.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Doctor Create/Edit Dialog */}
      <Dialog open={doctorDialogOpen} onOpenChange={(open) => { if (!open) resetDoctorForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingDoctorId ? 'Edit Signing Doctor' : 'Add Signing Doctor'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="doc-name">Name *</Label>
              <Input id="doc-name" placeholder="Dr. Aruna" value={doctorForm.name}
                onChange={(e) => setDoctorForm({ ...doctorForm, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doc-degrees">Degrees *</Label>
              <Input id="doc-degrees" placeholder="M.D., Pathology" value={doctorForm.degrees}
                onChange={(e) => setDoctorForm({ ...doctorForm, degrees: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doc-designation">Designation *</Label>
              <Input id="doc-designation" placeholder="Consultant Pathologist" value={doctorForm.designation}
                onChange={(e) => setDoctorForm({ ...doctorForm, designation: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doc-reg">Registration Number</Label>
              <Input id="doc-reg" placeholder="TSMC/PATH/2015/0001" value={doctorForm.registrationNumber}
                onChange={(e) => setDoctorForm({ ...doctorForm, registrationNumber: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetDoctorForm}>Cancel</Button>
            <Button onClick={handleSubmitDoctor}>{editingDoctorId ? 'Update' : 'Create'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Signing Rule Dialog */}
      <Dialog open={ruleDialogOpen} onOpenChange={(open) => { if (!open) setRuleDialogOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Signing Rule</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Department *</Label>
              <Select value={ruleForm.departmentId} onValueChange={(v) => setRuleForm({ ...ruleForm, departmentId: v })}>
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Signing Doctor *</Label>
              <Select value={ruleForm.signingDoctorId} onValueChange={(v) => setRuleForm({ ...ruleForm, signingDoctorId: v })}>
                <SelectTrigger><SelectValue placeholder="Select doctor" /></SelectTrigger>
                <SelectContent>
                  {doctors.filter(d => d.isActive).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name} — {d.degrees}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox id="rule-incharge" checked={ruleForm.showLabInchargeNote}
                onCheckedChange={(checked) => setRuleForm({ ...ruleForm, showLabInchargeNote: checked === true })} />
              <Label htmlFor="rule-incharge">Show lab incharge note on report</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-order">Display Order</Label>
              <Input id="rule-order" type="number" min={0} value={ruleForm.displayOrder}
                onChange={(e) => setRuleForm({ ...ruleForm, displayOrder: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuleDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitRule}>Create Rule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Signing Doctor?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the doctor and all their signing rules. Reports already signed will remain unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteDoctor} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
