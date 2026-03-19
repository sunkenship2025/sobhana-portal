import { useState, useEffect, useRef } from 'react';
import { API_BASE, API_BASE_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@/components/ui/sheet';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, UserCheck, Link2, Search, Upload, FileSignature,
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/* ───────── Types ───────── */

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

/* ───────── Helpers ───────── */

function getInitials(name: string) {
  return name
    .replace(/^Dr\.?\s*/i, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

/* ───────── Component ───────── */

export default function ManageSigningDoctors() {
  const { token } = useAuthStore();
  const signatureInputRef = useRef<HTMLInputElement>(null);

  const [doctors, setDoctors] = useState<SigningDoctor[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rules, setRules] = useState<SigningRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pendingSignatureFile, setPendingSignatureFile] = useState<File | null>(null);
  const [pendingSignaturePreview, setPendingSignaturePreview] = useState<string | null>(null);

  // Sheet for doctor edit
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingDoctorId, setEditingDoctorId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [doctorForm, setDoctorForm] = useState({
    name: '', degrees: '', designation: '', registrationNumber: '', isActive: true,
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
    setDoctorForm({ name: '', degrees: '', designation: '', registrationNumber: '', isActive: true });
    setPendingSignatureFile(null);
    if (pendingSignaturePreview) URL.revokeObjectURL(pendingSignaturePreview);
    setPendingSignaturePreview(null);
    setSheetOpen(false);
    setEditingDoctorId(null);
  };

  const handleAddDoctor = () => {
    resetDoctorForm();
    setDoctorForm({ name: '', degrees: '', designation: '', registrationNumber: '', isActive: true });
    setSheetOpen(true);
  };

  const handleEditDoctor = (doc: SigningDoctor) => {
    setDoctorForm({
      name: doc.name,
      degrees: doc.degrees,
      designation: doc.designation,
      registrationNumber: doc.registrationNumber || '',
      isActive: doc.isActive,
    });
    setEditingDoctorId(doc.id);
    setSheetOpen(true);
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
        isActive: doctorForm.isActive,
      };

      if (editingDoctorId) {
        const res = await fetch(`${API_BASE}/signing-doctors/${editingDoctorId}`, {
          method: 'PATCH', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to update'); return; }
        toast.success('Signing doctor updated');
        await fetchAll();
        resetDoctorForm();
      } else {
        const res = await fetch(`${API_BASE}/signing-doctors`, {
          method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to create'); return; }
        const created = await res.json();
        toast.success('Signing doctor created');

        // Auto-upload pending signature if one was selected
        if (pendingSignatureFile && created.id) {
          try {
            const { activeBranchId } = useBranchStore.getState();
            const formData = new FormData();
            formData.append('signature', pendingSignatureFile);
            const uploadRes = await fetch(`${API_BASE}/signing-doctors/${created.id}/upload-signature`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'X-Branch-Id': activeBranchId || '',
              },
              body: formData,
            });
            if (uploadRes.ok) {
              toast.success('Signature uploaded successfully');
            } else {
              toast.error('Doctor created but signature upload failed — edit the doctor to retry');
            }
          } catch {
            toast.error('Doctor created but signature upload failed — edit the doctor to retry');
          }
        }

        await fetchAll();
        resetDoctorForm();
      }
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
      const result = await res.json();
      toast.success(result.message || 'Signing doctor deleted');
      await fetchAll();
    } catch { toast.error('Failed to delete'); }
    setDeleteId(null);
  };

  // ── Signature Upload ─────────────────────────────────────────────
  const handleSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      toast.error('Only PNG, JPG, or WebP images are allowed');
      return;
    }

    // Validate file size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      toast.error('File size must be under 2MB');
      return;
    }

    // If adding a new doctor (not yet saved), store file for later upload
    if (!editingDoctorId) {
      setPendingSignatureFile(file);
      if (pendingSignaturePreview) URL.revokeObjectURL(pendingSignaturePreview);
      setPendingSignaturePreview(URL.createObjectURL(file));
      toast.success('Signature selected — it will be uploaded when you save the doctor');
      if (signatureInputRef.current) signatureInputRef.current.value = '';
      return;
    }

    setUploading(true);
    try {
      const { activeBranchId } = useBranchStore.getState();
      const formData = new FormData();
      formData.append('signature', file);

      const res = await fetch(`${API_BASE}/signing-doctors/${editingDoctorId}/upload-signature`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId || '',
          // Don't set Content-Type — browser sets it with boundary for FormData
        },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.message || 'Upload failed');
        return;
      }

      toast.success('Signature uploaded successfully');
      await fetchAll();
    } catch (err) {
      console.error('Signature upload error:', err);
      toast.error('Failed to upload signature');
    } finally {
      setUploading(false);
      // Reset file input so same file can be re-selected
      if (signatureInputRef.current) signatureInputRef.current.value = '';
    }
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
      if (!res.ok) { toast.error('Failed to delete rule'); return; }
      toast.success('Rule deleted');
      await fetchAll();
    } catch { toast.error('Failed to delete rule'); }
  };

  // ─── Filter ──────────────────────────────────────────────────────
  const filteredDoctors = doctors.filter(d => {
    if (!search) return true;
    const q = search.toLowerCase();
    return d.name.toLowerCase().includes(q) || d.designation.toLowerCase().includes(q)
      || d.degrees.toLowerCase().includes(q);
  });

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">Loading signing data...</div>;
  }

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* ── Signing Doctors ─────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <UserCheck className="h-5 w-5" /> Signing Doctors
            </h2>
            <p className="text-sm text-muted-foreground">
              Doctors whose signatures appear on reports
            </p>
          </div>
          <Button onClick={handleAddDoctor} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Doctor
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search doctors..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {filteredDoctors.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No signing doctors found.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Doctor</TableHead>
                  <TableHead>Designation</TableHead>
                  <TableHead>Reg. No.</TableHead>
                  <TableHead className="text-center">Signature</TableHead>
                  <TableHead className="text-center">Rules</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDoctors.map(doc => (
                  <TableRow key={doc.id} className={!doc.isActive ? 'opacity-50' : ''}>
                    {/* Doctor with avatar */}
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9 bg-primary/10 text-primary">
                          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                            {getInitials(doc.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium">{doc.name}</div>
                          <div className="text-xs text-muted-foreground">{doc.degrees}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{doc.designation}</TableCell>
                    <TableCell>
                      {doc.registrationNumber ? (
                        <Badge variant="outline" className="font-mono text-xs">
                          {doc.registrationNumber}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">                      {doc.signatureImagePath ? (
                        <img
                          src={`${API_BASE_URL}${doc.signatureImagePath}`}
                          alt="Sig"
                          className="h-8 mx-auto"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">No signature</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">                      <Badge variant="secondary">{doc._count.signingRules}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch checked={doc.isActive} onCheckedChange={() => handleToggleDoctor(doc)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="icon" onClick={() => handleEditDoctor(doc)} className="h-8 w-8">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleteId(doc.id)} className="h-8 w-8">
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
      </section>

      <Separator />

      {/* ── Signing Rules ───────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Link2 className="h-5 w-5" /> Signing Rules
            </h2>
            <p className="text-sm text-muted-foreground">
              Assign doctors to departments for report signing
            </p>
          </div>
          <Button onClick={handleAddRule} size="sm" variant="outline">
            <Plus className="h-4 w-4 mr-1" /> Add Rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No signing rules yet.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Department</TableHead>
                  <TableHead>Doctor</TableHead>
                  <TableHead className="text-center">Lab Incharge Note</TableHead>
                  <TableHead className="text-center">Order</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map(rule => (
                  <TableRow key={rule.id} className={!rule.isActive ? 'opacity-50' : ''}>
                    <TableCell>
                      <Badge variant="secondary">{rule.department.name}</Badge>
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="font-medium">{rule.signingDoctor.name}</span>
                        <span className="text-muted-foreground text-sm"> — {rule.signingDoctor.degrees}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {rule.showLabInchargeNote ? (
                        <Badge className="bg-green-100 text-green-800 text-xs">Yes</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">No</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center font-mono text-sm">{rule.displayOrder}</TableCell>
                    <TableCell className="text-center">
                      <Switch checked={rule.isActive} onCheckedChange={() => handleToggleRule(rule)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => handleDeleteRule(rule.id)} className="h-8 w-8">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* ── Doctor Sheet (Side Panel) ───────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={(open) => { if (!open) resetDoctorForm(); }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto overflow-x-hidden">
          <SheetHeader>
            <SheetTitle>{editingDoctorId ? 'Edit Signing Doctor' : 'Add Signing Doctor'}</SheetTitle>
            <SheetDescription>
              {editingDoctorId
                ? 'Update doctor details and signature information.'
                : 'Add a new doctor who can sign lab reports.'}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 py-6">
            {/* Avatar preview */}
            {doctorForm.name && (
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12 bg-primary/10 text-primary">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
                    {getInitials(doctorForm.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="text-sm">
                  <div className="font-medium">{doctorForm.name}</div>
                  {doctorForm.degrees && (
                    <div className="text-muted-foreground">{doctorForm.degrees}</div>
                  )}
                </div>
              </div>
            )}

            <Separator />

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="doc-name">Doctor Name *</Label>
              <Input
                id="doc-name"
                placeholder="Dr. Aruna Reddy"
                value={doctorForm.name}
                onChange={e => setDoctorForm({ ...doctorForm, name: e.target.value })}
              />
            </div>

            {/* Degrees */}
            <div className="space-y-1.5">
              <Label htmlFor="doc-degrees">Degree / Qualification *</Label>
              <Input
                id="doc-degrees"
                placeholder="M.D., Pathology"
                value={doctorForm.degrees}
                onChange={e => setDoctorForm({ ...doctorForm, degrees: e.target.value })}
              />
            </div>

            {/* Designation */}
            <div className="space-y-1.5">
              <Label htmlFor="doc-designation">Designation *</Label>
              <Input
                id="doc-designation"
                placeholder="Consultant Pathologist"
                value={doctorForm.designation}
                onChange={e => setDoctorForm({ ...doctorForm, designation: e.target.value })}
              />
            </div>

            {/* Registration */}
            <div className="space-y-1.5">
              <Label htmlFor="doc-reg">Registration Number</Label>
              <Input
                id="doc-reg"
                placeholder="TSMC/PATH/2015/0001"
                value={doctorForm.registrationNumber}
                onChange={e => setDoctorForm({ ...doctorForm, registrationNumber: e.target.value })}
              />
            </div>

            <Separator />

            {/* Digital Signature Upload */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <FileSignature className="h-4 w-4" /> Digital Signature
              </Label>

              {/* Hidden file input */}
              <input
                ref={signatureInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={handleSignatureUpload}
              />

              {/* Current / pending signature preview */}
              {(editingDoctorId && doctors.find(d => d.id === editingDoctorId)?.signatureImagePath) || pendingSignaturePreview ? (
                <div className="space-y-2">
                  <div className="border rounded-lg p-3 bg-muted/30">
                    <img
                      src={pendingSignaturePreview || `${API_BASE_URL}${doctors.find(d => d.id === editingDoctorId)!.signatureImagePath}`}
                      alt={pendingSignaturePreview ? 'Selected signature' : 'Current signature'}
                      className="h-16 mx-auto"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    <p className="text-xs text-center text-muted-foreground mt-1">
                      {pendingSignaturePreview ? 'Selected signature (will upload on save)' : 'Current signature'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={uploading}
                    onClick={() => signatureInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4 mr-1" />
                    {uploading ? 'Uploading...' : 'Replace Signature'}
                  </Button>
                </div>
              ) : (
                <div
                  className="border-2 border-dashed rounded-lg p-6 text-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => signatureInputRef.current?.click()}
                >
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {uploading ? 'Uploading...' : 'Click to upload signature image'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    PNG or JPG, transparent background preferred
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Signature will appear on printed reports for this doctor
              </p>
            </div>

            {/* Active toggle */}
            <div className="flex items-center gap-3">
              <Switch
                checked={doctorForm.isActive}
                onCheckedChange={v => setDoctorForm({ ...doctorForm, isActive: v })}
              />
              <Label>Active</Label>
            </div>
          </div>

          <SheetFooter className="mt-4">
            <Button variant="outline" onClick={resetDoctorForm}>Cancel</Button>
            <Button onClick={handleSubmitDoctor}>
              {editingDoctorId ? 'Update Doctor' : 'Add Doctor'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ── Signing Rule Dialog ─────────────────────────────────── */}
      <Dialog open={ruleDialogOpen} onOpenChange={(open) => { if (!open) setRuleDialogOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Signing Rule</DialogTitle>
            <DialogDescription>
              Assign a doctor to sign reports for a specific department.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Department *</Label>
              <Select value={ruleForm.departmentId} onValueChange={v => setRuleForm({ ...ruleForm, departmentId: v })}>
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Signing Doctor *</Label>
              <Select value={ruleForm.signingDoctorId} onValueChange={v => setRuleForm({ ...ruleForm, signingDoctorId: v })}>
                <SelectTrigger><SelectValue placeholder="Select doctor" /></SelectTrigger>
                <SelectContent>
                  {doctors.filter(d => d.isActive).map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name} — {d.degrees}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="rule-incharge"
                checked={ruleForm.showLabInchargeNote}
                onCheckedChange={(checked) => setRuleForm({ ...ruleForm, showLabInchargeNote: checked === true })}
              />
              <Label htmlFor="rule-incharge">Show lab incharge note on report</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-order">Display Order</Label>
              <Input
                id="rule-order" type="number" min={0}
                value={ruleForm.displayOrder}
                onChange={e => setRuleForm({ ...ruleForm, displayOrder: e.target.value })}
                className="max-w-[120px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuleDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitRule}>Create Rule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ─────────────────────────────────── */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Signing Doctor?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteId && doctors.find(d => d.id === deleteId)?._count.signingRules === 0 ? (
                <>This will permanently delete the doctor. This action cannot be undone.</>
              ) : (
                <>This will deactivate the doctor and remove all their signing rules. Reports already signed will remain unchanged.</>
              )}
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
