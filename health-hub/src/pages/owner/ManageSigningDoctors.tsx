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
import { EmptyState } from '@/components/ui/empty-state';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@/components/ui/sheet';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { useConfirm } from '@/hooks/use-confirm';
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

interface SigningLabIncharge {
  id: string;
  name: string;
  designation: string;
  signatureImagePath: string | null;
  showSignatureOnPrint: boolean;
  isActive: boolean;
  _count: { labInchargeRules: number };
}

interface BranchOption {
  id: string;
  name: string;
}

interface LabInchargeRule {
  id: string;
  signingLabInchargeId: string;
  branchId: string | null;
  displayOrder: number;
  isActive: boolean;
  branch: { id: string; name: string } | null;
  signingLabIncharge: { id: string; name: string; designation: string };
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
  const { confirm, ConfirmDialog } = useConfirm();
  const signatureInputRef = useRef<HTMLInputElement>(null);

  const [doctors, setDoctors] = useState<SigningDoctor[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rules, setRules] = useState<SigningRule[]>([]);
  const [labIncharges, setLabIncharges] = useState<SigningLabIncharge[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [labInchargeRules, setLabInchargeRules] = useState<LabInchargeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [labInchargeSearch, setLabInchargeSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submittingDoctor, setSubmittingDoctor] = useState(false);
  const [deletingDoctor, setDeletingDoctor] = useState(false);
  const [submittingRule, setSubmittingRule] = useState(false);
  const [deletingRuleIds, setDeletingRuleIds] = useState<Set<string>>(() => new Set());
  const [deletingLabInchargeIds, setDeletingLabInchargeIds] = useState<Set<string>>(() => new Set());
  const [deletingLabInchargeRuleIds, setDeletingLabInchargeRuleIds] = useState<Set<string>>(() => new Set());
  const [pendingSignatureFile, setPendingSignatureFile] = useState<File | null>(null);
  const [pendingSignaturePreview, setPendingSignaturePreview] = useState<string | null>(null);

  // Sheet for doctor edit
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingDoctorId, setEditingDoctorId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [doctorForm, setDoctorForm] = useState({
    name: '', degrees: '', designation: '', registrationNumber: '', isActive: true,
  });

  // Lab incharge sheet
  const [labInchargeSheetOpen, setLabInchargeSheetOpen] = useState(false);
  const [editingLabInchargeId, setEditingLabInchargeId] = useState<string | null>(null);
  const [deleteLabInchargeId, setDeleteLabInchargeId] = useState<string | null>(null);
  const [labInchargeForm, setLabInchargeForm] = useState({
    name: '', designation: 'Lab Incharge', showSignatureOnPrint: false, isActive: true,
  });
  const [labInchargePendingSignatureFile, setLabInchargePendingSignatureFile] = useState<File | null>(null);
  const [labInchargePendingSignaturePreview, setLabInchargePendingSignaturePreview] = useState<string | null>(null);
  const labInchargeSignatureInputRef = useRef<HTMLInputElement>(null);

  // Rule dialog
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    departmentId: '', signingDoctorId: '', showLabInchargeNote: false, displayOrder: '1',
  });

  // Lab incharge rule dialog
  const [labInchargeRuleDialogOpen, setLabInchargeRuleDialogOpen] = useState(false);
  const [labInchargeRuleForm, setLabInchargeRuleForm] = useState({
    signingLabInchargeId: '', branchId: '__all__', displayOrder: '1',
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

      const [docRes, deptRes, rulesRes, liRes, branchRes, liRuleRes] = await Promise.all([
        fetch(`${API_BASE}/signing-doctors?active=all`, { headers }),
        fetch(`${API_BASE}/departments`, { headers }),
        fetch(`${API_BASE}/signing-rules?active=all`, { headers }),
        fetch(`${API_BASE}/signing-lab-incharges?active=all`, { headers }),
        fetch(`${API_BASE}/branches?active=true`, { headers }),
        fetch(`${API_BASE}/lab-incharge-rules?active=all`, { headers }),
      ]);

      if (docRes.ok) setDoctors(await docRes.json());
      if (deptRes.ok) setDepartments(await deptRes.json());
      if (rulesRes.ok) setRules(await rulesRes.json());
      if (liRes.ok) setLabIncharges(await liRes.json());
      if (branchRes.ok) setBranches(await branchRes.json());
      if (liRuleRes.ok) setLabInchargeRules(await liRuleRes.json());
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

    if (submittingDoctor) return;
    setSubmittingDoctor(true);
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
    } finally {
      setSubmittingDoctor(false);
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
    if (deletingDoctor) return;
    setDeletingDoctor(true);
    try {
      const res = await fetch(`${API_BASE}/signing-doctors/${deleteId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      const result = await res.json();
      toast.success(result.message || 'Signing doctor deleted');
      await fetchAll();
    } catch { toast.error('Failed to delete'); }
    finally { setDeletingDoctor(false); }
    setDeleteId(null);
  };

  // ── Lab Incharge CRUD ──────────────────────────────────────────
  const resetLabInchargeForm = () => {
    setLabInchargeForm({ name: '', designation: 'Lab Incharge', showSignatureOnPrint: false, isActive: true });
    setLabInchargePendingSignatureFile(null);
    if (labInchargePendingSignaturePreview) URL.revokeObjectURL(labInchargePendingSignaturePreview);
    setLabInchargePendingSignaturePreview(null);
    setLabInchargeSheetOpen(false);
    setEditingLabInchargeId(null);
  };

  const handleAddLabIncharge = () => {
    resetLabInchargeForm();
    setLabInchargeForm({ name: '', designation: 'Lab Incharge', showSignatureOnPrint: false, isActive: true });
    setLabInchargeSheetOpen(true);
  };

  const handleEditLabIncharge = (li: SigningLabIncharge) => {
    setLabInchargeForm({
      name: li.name,
      designation: li.designation,
      showSignatureOnPrint: li.showSignatureOnPrint,
      isActive: li.isActive,
    });
    setEditingLabInchargeId(li.id);
    setLabInchargeSheetOpen(true);
  };

  const handleSubmitLabIncharge = async () => {
    if (!labInchargeForm.name.trim()) {
      toast.error('Name is required');
      return;
    }

    setSubmittingDoctor(true); // reuse loading state
    try {
      const body = {
        name: labInchargeForm.name.trim(),
        designation: labInchargeForm.designation.trim(),
        showSignatureOnPrint: labInchargeForm.showSignatureOnPrint,
        isActive: labInchargeForm.isActive,
      };

      if (editingLabInchargeId) {
        const res = await fetch(`${API_BASE}/signing-lab-incharges/${editingLabInchargeId}`, {
          method: 'PATCH', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to update'); return; }
        toast.success('Lab incharge updated');
        await fetchAll();
        resetLabInchargeForm();
      } else {
        const res = await fetch(`${API_BASE}/signing-lab-incharges`, {
          method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to create'); return; }
        const created = await res.json();
        toast.success('Lab incharge created');

        if (labInchargePendingSignatureFile && created.id) {
          try {
            const { activeBranchId } = useBranchStore.getState();
            const formData = new FormData();
            formData.append('signature', labInchargePendingSignatureFile);
            const uploadRes = await fetch(`${API_BASE}/signing-lab-incharges/${created.id}/upload-signature`, {
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
              toast.error('Lab incharge created but signature upload failed — edit to retry');
            }
          } catch {
            toast.error('Lab incharge created but signature upload failed — edit to retry');
          }
        }

        await fetchAll();
        resetLabInchargeForm();
      }
    } catch (err) {
      console.error('Error saving lab incharge:', err);
      toast.error('Failed to save lab incharge');
    } finally {
      setSubmittingDoctor(false);
    }
  };

  const handleToggleLabIncharge = async (li: SigningLabIncharge) => {
    try {
      const res = await fetch(`${API_BASE}/signing-lab-incharges/${li.id}`, {
        method: 'PATCH', headers: getHeaders(),
        body: JSON.stringify({ isActive: !li.isActive }),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success(`Lab incharge ${!li.isActive ? 'activated' : 'deactivated'}`);
      await fetchAll();
    } catch { toast.error('Failed to update status'); }
  };

  const handleDeleteLabIncharge = async () => {
    if (!deleteLabInchargeId) return;
    setDeletingLabInchargeIds((prev) => { const next = new Set(prev); next.add(deleteLabInchargeId); return next; });
    try {
      const res = await fetch(`${API_BASE}/signing-lab-incharges/${deleteLabInchargeId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success('Lab incharge deleted');
      await fetchAll();
    } catch { toast.error('Failed to delete'); }
    finally {
      setDeletingLabInchargeIds((prev) => { const next = new Set(prev); next.delete(deleteLabInchargeId!); return next; });
    }
    setDeleteLabInchargeId(null);
  };

  // ── Lab Incharge Signature Upload ────────────────────────────────
  const handleLabInchargeSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      toast.error('Only PNG, JPG, or WebP images are allowed');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast.error('File size must be under 2MB');
      return;
    }

    if (!editingLabInchargeId) {
      setLabInchargePendingSignatureFile(file);
      if (labInchargePendingSignaturePreview) URL.revokeObjectURL(labInchargePendingSignaturePreview);
      setLabInchargePendingSignaturePreview(URL.createObjectURL(file));
      toast.success('Signature selected — it will be uploaded when you save the lab incharge');
      if (labInchargeSignatureInputRef.current) labInchargeSignatureInputRef.current.value = '';
      return;
    }

    setUploading(true);
    try {
      const { activeBranchId } = useBranchStore.getState();
      const formData = new FormData();
      formData.append('signature', file);
      const res = await fetch(`${API_BASE}/signing-lab-incharges/${editingLabInchargeId}/upload-signature`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId || '',
        },
        body: formData,
      });
      if (!res.ok) { const err = await res.json(); toast.error(err.message || 'Upload failed'); return; }
      toast.success('Signature uploaded successfully');
      await fetchAll();
    } catch (err) {
      console.error('Signature upload error:', err);
      toast.error('Failed to upload signature');
    } finally {
      setUploading(false);
      if (labInchargeSignatureInputRef.current) labInchargeSignatureInputRef.current.value = '';
    }
  };

  // ── Lab Incharge Rule CRUD ───────────────────────────────────────
  const handleAddLabInchargeRule = () => {
    setLabInchargeRuleForm({ signingLabInchargeId: '', branchId: '__all__', displayOrder: '1' });
    setLabInchargeRuleDialogOpen(true);
  };

  const handleSubmitLabInchargeRule = async () => {
    if (!labInchargeRuleForm.signingLabInchargeId) {
      toast.error('Lab incharge is required');
      return;
    }
    setSubmittingRule(true);
    try {
      const res = await fetch(`${API_BASE}/lab-incharge-rules`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          signingLabInchargeId: labInchargeRuleForm.signingLabInchargeId,
          branchId: labInchargeRuleForm.branchId === '__all__' ? null : labInchargeRuleForm.branchId,
          displayOrder: parseInt(labInchargeRuleForm.displayOrder) || 1,
        }),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed to create rule'); return; }
      toast.success('Lab incharge rule created');
      await fetchAll();
      setLabInchargeRuleDialogOpen(false);
    } catch { toast.error('Failed to create rule'); }
    finally { setSubmittingRule(false); }
  };

  const handleToggleLabInchargeRule = async (rule: LabInchargeRule) => {
    try {
      const res = await fetch(`${API_BASE}/lab-incharge-rules/${rule.id}`, {
        method: 'PATCH', headers: getHeaders(),
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!res.ok) { toast.error('Failed to update rule'); return; }
      await fetchAll();
    } catch { toast.error('Failed to update rule'); }
  };

  const handleDeleteLabInchargeRule = async (ruleId: string) => {
    if (deletingLabInchargeRuleIds.has(ruleId)) return;
    const ok = await confirm({
      title: "Delete lab in-charge rule?",
      description:
        "Reports matching this rule will lose their assigned lab in-charge until another rule covers them.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingLabInchargeRuleIds((prev) => { const next = new Set(prev); next.add(ruleId); return next; });
    try {
      const res = await fetch(`${API_BASE}/lab-incharge-rules/${ruleId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { toast.error('Failed to delete rule'); return; }
      toast.success('Rule deleted');
      await fetchAll();
    } catch { toast.error('Failed to delete rule'); }
    finally {
      setDeletingLabInchargeRuleIds((prev) => { const next = new Set(prev); next.delete(ruleId); return next; });
    }
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
    if (submittingRule) return;
    setSubmittingRule(true);
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
    finally { setSubmittingRule(false); }
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
    if (deletingRuleIds.has(ruleId)) return;
    const ok = await confirm({
      title: "Delete signing rule?",
      description:
        "Reports matching this rule will lose their assigned signer until another rule covers them.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingRuleIds((prev) => {
      const next = new Set(prev);
      next.add(ruleId);
      return next;
    });
    try {
      const res = await fetch(`${API_BASE}/signing-rules/${ruleId}`, {
        method: 'DELETE', headers: getHeaders(),
      });
      if (!res.ok) { toast.error('Failed to delete rule'); return; }
      toast.success('Rule deleted');
      await fetchAll();
    } catch { toast.error('Failed to delete rule'); }
    finally {
      setDeletingRuleIds((prev) => {
        const next = new Set(prev);
        next.delete(ruleId);
        return next;
      });
    }
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
      {ConfirmDialog}
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
          <EmptyState title="No signing doctors" />
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
                        <Button variant="ghost" size="icon" onClick={() => handleEditDoctor(doc)} className="h-8 w-8" aria-label="Edit signing doctor">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleteId(doc.id)} className="h-8 w-8" aria-label="Delete signing doctor">
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

      {/* ── Doctor Signing Rules ──────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Link2 className="h-5 w-5" /> Doctor Signing Rules
            </h2>
            <p className="text-sm text-muted-foreground">
              Assign doctors to departments for report signing
            </p>
          </div>
          <Button onClick={handleAddRule} size="sm" variant="outline">
            <Plus className="h-4 w-4 mr-1" /> Add Doctor Rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <EmptyState title="No signing rules yet" />
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
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteRule(rule.id)}
                        disabled={deletingRuleIds.has(rule.id)}
                        className="h-8 w-8"
                        aria-label="Delete signing rule"
                      >
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

      <Separator />

      {/* ── Lab Incharges ───────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <UserCheck className="h-5 w-5" /> Lab Incharges
            </h2>
            <p className="text-sm text-muted-foreground">
              Lab staff whose signatures appear on reports
            </p>
          </div>
          <Button onClick={handleAddLabIncharge} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Lab Incharge
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search lab incharges..."
            value={labInchargeSearch}
            onChange={e => setLabInchargeSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {labIncharges.filter(li => {
          if (!labInchargeSearch) return true;
          const q = labInchargeSearch.toLowerCase();
          return li.name.toLowerCase().includes(q) || li.designation.toLowerCase().includes(q);
        }).length === 0 ? (
          <EmptyState title="No lab incharges" />
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Name</TableHead>
                  <TableHead>Designation</TableHead>
                  <TableHead className="text-center">Signature</TableHead>
                  <TableHead className="text-center">Rules</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {labIncharges.filter(li => {
                  if (!labInchargeSearch) return true;
                  const q = labInchargeSearch.toLowerCase();
                  return li.name.toLowerCase().includes(q) || li.designation.toLowerCase().includes(q);
                }).map(li => (
                  <TableRow key={li.id} className={!li.isActive ? 'opacity-50' : ''}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9 bg-primary/10 text-primary">
                          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                            {getInitials(li.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="font-medium">{li.name}</div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{li.designation}</TableCell>
                    <TableCell className="text-center">
                      {li.signatureImagePath ? (
                        <img
                          src={`${API_BASE_URL}${li.signatureImagePath}`}
                          alt="Sig"
                          className="h-8 mx-auto"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">No signature</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary">{li._count.labInchargeRules}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch checked={li.isActive} onCheckedChange={() => handleToggleLabIncharge(li)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="icon" onClick={() => handleEditLabIncharge(li)} className="h-8 w-8" aria-label="Edit lab incharge">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleteLabInchargeId(li.id)} className="h-8 w-8" aria-label="Delete lab incharge">
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

      {/* ── Lab Incharge Signing Rules ───────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Link2 className="h-5 w-5" /> Lab Incharge Signing Rules
            </h2>
            <p className="text-sm text-muted-foreground">
              Assign lab incharges to branches for report signing
            </p>
          </div>
          <Button onClick={handleAddLabInchargeRule} size="sm" variant="outline">
            <Plus className="h-4 w-4 mr-1" /> Add Lab Incharge Rule
          </Button>
        </div>

        {labInchargeRules.length === 0 ? (
          <EmptyState title="No lab incharge rules yet" />
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Branch</TableHead>
                  <TableHead>Lab Incharge</TableHead>
                  <TableHead className="text-center">Order</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {labInchargeRules.map(rule => (
                  <TableRow key={rule.id} className={!rule.isActive ? 'opacity-50' : ''}>
                    <TableCell>
                      <Badge variant="secondary">
                        {rule.branch ? rule.branch.name : 'All Branches'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="font-medium">{rule.signingLabIncharge.name}</span>
                        <span className="text-muted-foreground text-sm"> — {rule.signingLabIncharge.designation}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center font-mono text-sm">{rule.displayOrder}</TableCell>
                    <TableCell className="text-center">
                      <Switch checked={rule.isActive} onCheckedChange={() => handleToggleLabInchargeRule(rule)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteLabInchargeRule(rule.id)}
                        disabled={deletingLabInchargeRuleIds.has(rule.id)}
                        className="h-8 w-8"
                        aria-label="Delete lab incharge rule"
                      >
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
            <Button variant="outline" onClick={resetDoctorForm} disabled={submittingDoctor}>Cancel</Button>
            <Button onClick={handleSubmitDoctor} disabled={submittingDoctor}>
              {submittingDoctor ? 'Saving...' : (editingDoctorId ? 'Update Doctor' : 'Add Doctor')}
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
            <Button variant="outline" onClick={() => setRuleDialogOpen(false)} disabled={submittingRule}>Cancel</Button>
            <Button onClick={handleSubmitRule} disabled={submittingRule}>
              {submittingRule ? 'Saving...' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Lab Incharge Sheet (Side Panel) ───────────────────── */}
      <Sheet open={labInchargeSheetOpen} onOpenChange={(open) => { if (!open) resetLabInchargeForm(); }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto overflow-x-hidden">
          <SheetHeader>
            <SheetTitle>{editingLabInchargeId ? 'Edit Lab Incharge' : 'Add Lab Incharge'}</SheetTitle>
            <SheetDescription>
              {editingLabInchargeId
                ? 'Update lab incharge details and signature information.'
                : 'Add a new lab incharge who can sign lab reports.'}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 py-6">
            {/* Avatar preview */}
            {labInchargeForm.name && (
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12 bg-primary/10 text-primary">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
                    {getInitials(labInchargeForm.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="text-sm">
                  <div className="font-medium">{labInchargeForm.name}</div>
                  {labInchargeForm.designation && (
                    <div className="text-muted-foreground">{labInchargeForm.designation}</div>
                  )}
                </div>
              </div>
            )}

            <Separator />

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="li-name">Name *</Label>
              <Input
                id="li-name"
                placeholder="Rajesh Kumar"
                value={labInchargeForm.name}
                onChange={e => setLabInchargeForm({ ...labInchargeForm, name: e.target.value })}
              />
            </div>

            {/* Designation */}
            <div className="space-y-1.5">
              <Label htmlFor="li-designation">Designation *</Label>
              <Input
                id="li-designation"
                placeholder="Lab Incharge"
                value={labInchargeForm.designation}
                onChange={e => setLabInchargeForm({ ...labInchargeForm, designation: e.target.value })}
              />
            </div>

            <Separator />

            {/* Digital Signature Upload */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <FileSignature className="h-4 w-4" /> Digital Signature
              </Label>

              <input
                ref={labInchargeSignatureInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={handleLabInchargeSignatureUpload}
              />

              {(editingLabInchargeId && labIncharges.find(li => li.id === editingLabInchargeId)?.signatureImagePath) || labInchargePendingSignaturePreview ? (
                <div className="space-y-2">
                  <div className="border rounded-lg p-3 bg-muted/30">
                    <img
                      src={labInchargePendingSignaturePreview || `${API_BASE_URL}${labIncharges.find(li => li.id === editingLabInchargeId)!.signatureImagePath}`}
                      alt={labInchargePendingSignaturePreview ? 'Selected signature' : 'Current signature'}
                      className="h-16 mx-auto"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    <p className="text-xs text-center text-muted-foreground mt-1">
                      {labInchargePendingSignaturePreview ? 'Selected signature (will upload on save)' : 'Current signature'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={uploading}
                    onClick={() => labInchargeSignatureInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4 mr-1" />
                    {uploading ? 'Uploading...' : 'Replace Signature'}
                  </Button>
                </div>
              ) : (
                <div
                  className="border-2 border-dashed rounded-lg p-6 text-center hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => labInchargeSignatureInputRef.current?.click()}
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
                Signature will appear on printed reports for this lab incharge
              </p>
            </div>

            {/* Show signature on physical (letterhead) prints */}
            <div className="flex items-center gap-3">
              <Switch
                checked={labInchargeForm.showSignatureOnPrint}
                onCheckedChange={v => setLabInchargeForm({ ...labInchargeForm, showSignatureOnPrint: v })}
              />
              <Label>Show signature on physical prints</Label>
            </div>

            {/* Active toggle */}
            <div className="flex items-center gap-3">
              <Switch
                checked={labInchargeForm.isActive}
                onCheckedChange={v => setLabInchargeForm({ ...labInchargeForm, isActive: v })}
              />
              <Label>Active</Label>
            </div>
          </div>

          <SheetFooter className="mt-4">
            <Button variant="outline" onClick={resetLabInchargeForm} disabled={submittingDoctor}>Cancel</Button>
            <Button onClick={handleSubmitLabIncharge} disabled={submittingDoctor}>
              {submittingDoctor ? 'Saving...' : (editingLabInchargeId ? 'Update Lab Incharge' : 'Add Lab Incharge')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ── Lab Incharge Rule Dialog ────────────────────────────── */}
      <Dialog open={labInchargeRuleDialogOpen} onOpenChange={(open) => { if (!open) setLabInchargeRuleDialogOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Lab Incharge Rule</DialogTitle>
            <DialogDescription>
              Assign a lab incharge to sign reports for a specific branch.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Branch *</Label>
              <Select value={labInchargeRuleForm.branchId} onValueChange={v => setLabInchargeRuleForm({ ...labInchargeRuleForm, branchId: v })}>
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All Branches</SelectItem>
                  {branches.map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Lab Incharge *</Label>
              <Select value={labInchargeRuleForm.signingLabInchargeId} onValueChange={v => setLabInchargeRuleForm({ ...labInchargeRuleForm, signingLabInchargeId: v })}>
                <SelectTrigger><SelectValue placeholder="Select lab incharge" /></SelectTrigger>
                <SelectContent>
                  {labIncharges.filter(li => li.isActive).map(li => (
                    <SelectItem key={li.id} value={li.id}>{li.name} — {li.designation}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="li-rule-order">Display Order</Label>
              <Input
                id="li-rule-order" type="number" min={0}
                value={labInchargeRuleForm.displayOrder}
                onChange={e => setLabInchargeRuleForm({ ...labInchargeRuleForm, displayOrder: e.target.value })}
                className="max-w-[120px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLabInchargeRuleDialogOpen(false)} disabled={submittingRule}>Cancel</Button>
            <Button onClick={handleSubmitLabInchargeRule} disabled={submittingRule}>
              {submittingRule ? 'Saving...' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Doctor Confirmation ──────────────────────────── */}
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
            <AlertDialogCancel disabled={deletingDoctor}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteDoctor} disabled={deletingDoctor} className="bg-destructive text-destructive-foreground">
              {deletingDoctor ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete Lab Incharge Confirmation ────────────────────── */}
      <AlertDialog open={!!deleteLabInchargeId} onOpenChange={() => setDeleteLabInchargeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Lab Incharge?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteLabInchargeId && labIncharges.find(li => li.id === deleteLabInchargeId)?._count.labInchargeRules === 0 ? (
                <>This will permanently delete the lab incharge. This action cannot be undone.</>
              ) : (
                <>This will deactivate the lab incharge and remove all their signing rules. Reports already signed will remain unchanged.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingLabInchargeIds.has(deleteLabInchargeId || '')}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteLabIncharge} disabled={deletingLabInchargeIds.has(deleteLabInchargeId || '')} className="bg-destructive text-destructive-foreground">
              {deletingLabInchargeIds.has(deleteLabInchargeId || '') ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
