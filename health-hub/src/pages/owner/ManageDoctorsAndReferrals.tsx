/**
 * ManageDoctorsAndReferrals
 * Unified tab component combining:
 *  - Referral Doctors (ex-ManageDoctors)
 *  - Clinic Doctors (ex-ManageClinicDoctors)
 *  - Diagnostic Centers (ex-ManageDiagnosticCenters)
 */

import { useState, useEffect, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, X, Check, AlertTriangle, Link as LinkIcon,
} from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ─── helpers ────────────────────────────────────────────────────────────────

function branchHeaders(token: string | null) {
  const { activeBranchId } = useBranchStore.getState();
  return {
    'Authorization': `Bearer ${token}`,
    'X-Branch-Id': activeBranchId || '',
    'Content-Type': 'application/json',
  };
}

// ─── interfaces ─────────────────────────────────────────────────────────────

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

const EMPTY_CENTER_FORM = {
  name: '', contactPerson: '', phone: '', email: '', address: '', commissionPercent: '0',
};

// ─── main component ──────────────────────────────────────────────────────────

export default function ManageDoctorsAndReferrals() {
  const { token } = useAuthStore();

  // ── Referral Doctors state ────────────────────────────────────────────────
  const [referralDoctors, setReferralDoctors] = useState<any[]>([]);
  const [refLoading, setRefLoading] = useState(true);
  const [refShowForm, setRefShowForm] = useState(false);
  const [refEditingId, setRefEditingId] = useState<string | null>(null);
  const [refDeleteId, setRefDeleteId] = useState<string | null>(null);
  const [refExistingDoctor, setRefExistingDoctor] = useState<any>(null);
  const [refLinkedDoctorId, setRefLinkedDoctorId] = useState<string | null>(null);
  const refSearchTimeout = useRef<NodeJS.Timeout | null>(null);
  const [refForm, setRefForm] = useState({ name: '', phone: '', commissionPercent: '' });

  // ── Clinic Doctors state ──────────────────────────────────────────────────
  const [clinicDoctors, setClinicDoctors] = useState<any[]>([]);
  const [clinicLoading, setClinicLoading] = useState(true);
  const [clinicShowForm, setClinicShowForm] = useState(false);
  const [clinicEditingId, setClinicEditingId] = useState<string | null>(null);
  const [clinicDeleteId, setClinicDeleteId] = useState<string | null>(null);
  const [clinicExistingDoctor, setClinicExistingDoctor] = useState<any>(null);
  const [clinicLinkedDoctorId, setClinicLinkedDoctorId] = useState<string | null>(null);
  const [clinicForm, setClinicForm] = useState({
    name: '', qualification: '', specialty: '', registrationNumber: '', phone: '', letterheadNote: '',
  });

  // ── Diagnostic Centers state ──────────────────────────────────────────────
  const [centers, setCenters] = useState<DiagnosticCenter[]>([]);
  const [centersLoading, setCentersLoading] = useState(true);
  const [centerDialogOpen, setCenterDialogOpen] = useState(false);
  const [centerEditingId, setCenterEditingId] = useState<string | null>(null);
  const [centerDeleteId, setCenterDeleteId] = useState<string | null>(null);
  const [centerForm, setCenterForm] = useState({ ...EMPTY_CENTER_FORM });

  // ═══════════════════════════════════════════════════════════════════════════
  // REFERRAL DOCTORS
  // ═══════════════════════════════════════════════════════════════════════════

  const fetchReferralDoctors = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/referral-doctors`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setReferralDoctors(await res.json());
    } catch (err) {
      console.error('Error fetching referral doctors:', err);
    } finally {
      setRefLoading(false);
    }
  };

  useEffect(() => { fetchReferralDoctors(); }, [token]);

  const refCheckPhone = async (phone: string) => {
    if (phone.length >= 10 && token) {
      try {
        const res = await fetch(`${API_BASE}/doctors/search-by-contact?phone=${phone}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.clinicDoctor) {
          setRefExistingDoctor({ type: 'clinic', doctor: data.clinicDoctor });
        } else if (data.referralDoctor && !refEditingId) {
          toast.error('This phone number is already registered as a referral doctor');
          setRefExistingDoctor({ type: 'referral', doctor: data.referralDoctor });
        } else {
          setRefExistingDoctor(null);
        }
      } catch { setRefExistingDoctor(null); }
    } else {
      setRefExistingDoctor(null);
    }
  };

  const refCheckName = async (name: string) => {
    if (name.length >= 3 && token && !refEditingId) {
      try {
        const res = await fetch(`${API_BASE}/clinic-doctors`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const list = await res.json();
        const match = list.find((d: any) => d.name.toLowerCase().includes(name.toLowerCase()));
        setRefExistingDoctor(match ? { type: 'clinic', doctor: match } : null);
      } catch { setRefExistingDoctor(null); }
    } else if (name.length < 3) {
      setRefExistingDoctor(null);
    }
  };

  const handleRefNameChange = (name: string) => {
    setRefForm(f => ({ ...f, name }));
    if (refSearchTimeout.current) clearTimeout(refSearchTimeout.current);
    refSearchTimeout.current = setTimeout(() => refCheckName(name), 500);
  };

  const refLinkToClinic = () => {
    if (refExistingDoctor?.doctor) {
      setRefForm(f => ({ ...f, name: refExistingDoctor.doctor.name, phone: refExistingDoctor.doctor.phone }));
      setRefLinkedDoctorId(refExistingDoctor.doctor.id);
      toast.success(`Linked to clinic doctor ${refExistingDoctor.doctor.doctorNumber}`);
    }
  };

  const refResetForm = () => {
    setRefForm({ name: '', phone: '', commissionPercent: '' });
    setRefShowForm(false);
    setRefEditingId(null);
    setRefExistingDoctor(null);
    setRefLinkedDoctorId(null);
  };

  const handleRefSubmit = async () => {
    if (!refForm.name || !refForm.phone || !refForm.commissionPercent) {
      toast.error('Please fill all fields'); return;
    }
    const commission = parseFloat(refForm.commissionPercent);
    if (isNaN(commission) || commission < 0 || commission > 100) {
      toast.error('Commission must be 0–100'); return;
    }
    try {
      if (refEditingId) {
        const res = await fetch(`${API_BASE}/referral-doctors/${refEditingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: refForm.name, phone: refForm.phone, commissionPercent: commission }),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Doctor updated');
      } else {
        const res = await fetch(`${API_BASE}/referral-doctors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: refForm.name, phone: refForm.phone, commissionPercent: commission, clinicDoctorId: refLinkedDoctorId }),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Doctor added');
      }
      await fetchReferralDoctors();
      refResetForm();
    } catch { toast.error('Failed to save doctor'); }
  };

  const handleRefEdit = (doc: any) => {
    setRefForm({ name: doc.name, phone: doc.phone, commissionPercent: doc.commissionPercent.toString() });
    setRefEditingId(doc.id);
    setRefShowForm(true);
  };

  const handleRefDelete = async () => {
    if (!refDeleteId) return;
    try {
      const res = await fetch(`${API_BASE}/referral-doctors/${refDeleteId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success('Doctor deleted');
      await fetchReferralDoctors();
    } catch { toast.error('Failed to delete'); }
    setRefDeleteId(null);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CLINIC DOCTORS
  // ═══════════════════════════════════════════════════════════════════════════

  const fetchClinicDoctors = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/clinic-doctors`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setClinicDoctors(await res.json());
    } catch (err) {
      console.error('Error fetching clinic doctors:', err);
    } finally {
      setClinicLoading(false);
    }
  };

  useEffect(() => { fetchClinicDoctors(); }, [token]);

  const clinicCheckPhone = async (phone: string) => {
    if (phone.length >= 10 && token) {
      try {
        const res = await fetch(`${API_BASE}/doctors/search-by-contact?phone=${phone}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.referralDoctor) {
          setClinicExistingDoctor({ type: 'referral', doctor: data.referralDoctor });
        } else if (data.clinicDoctor && !clinicEditingId) {
          toast.error('Phone already registered as clinic doctor');
          setClinicExistingDoctor({ type: 'clinic', doctor: data.clinicDoctor });
        } else {
          setClinicExistingDoctor(null);
        }
      } catch { setClinicExistingDoctor(null); }
    } else {
      setClinicExistingDoctor(null);
    }
  };

  const clinicCheckName = async (name: string) => {
    if (name.length >= 3 && token) {
      try {
        const res = await fetch(`${API_BASE}/referral-doctors`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const list = await res.json();
        const match = list.find((d: any) => d.name.toLowerCase().includes(name.toLowerCase()));
        setClinicExistingDoctor(match ? { type: 'referral', doctor: match } : null);
      } catch { setClinicExistingDoctor(null); }
    } else {
      setClinicExistingDoctor(null);
    }
  };

  const clinicLinkToReferral = () => {
    if (clinicExistingDoctor?.doctor) {
      setClinicForm(f => ({ ...f, name: clinicExistingDoctor.doctor.name, phone: clinicExistingDoctor.doctor.phone }));
      setClinicLinkedDoctorId(clinicExistingDoctor.doctor.id);
      toast.success(`Linked to referral doctor ${clinicExistingDoctor.doctor.doctorNumber}`);
    }
  };

  const clinicResetForm = () => {
    setClinicForm({ name: '', qualification: '', specialty: '', registrationNumber: '', phone: '', letterheadNote: '' });
    setClinicShowForm(false);
    setClinicEditingId(null);
    setClinicExistingDoctor(null);
    setClinicLinkedDoctorId(null);
  };

  const handleClinicSubmit = async () => {
    if (!clinicForm.name || !clinicForm.qualification || !clinicForm.specialty || !clinicForm.registrationNumber) {
      toast.error('Name, qualification, specialty, and registration number are required'); return;
    }
    if (clinicForm.phone && clinicForm.phone.length !== 10) {
      toast.error('Phone must be 10 digits'); return;
    }
    const payload = {
      name: clinicForm.name, qualification: clinicForm.qualification,
      specialty: clinicForm.specialty, registrationNumber: clinicForm.registrationNumber,
      phone: clinicForm.phone, letterheadNote: clinicForm.letterheadNote,
      referralDoctorId: clinicLinkedDoctorId,
    };
    try {
      if (clinicEditingId) {
        const res = await fetch(`${API_BASE}/clinic-doctors/${clinicEditingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Doctor updated');
      } else {
        const res = await fetch(`${API_BASE}/clinic-doctors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Doctor added');
      }
      await fetchClinicDoctors();
      clinicResetForm();
    } catch { toast.error('Failed to save doctor'); }
  };

  const handleClinicEdit = (doc: any) => {
    setClinicForm({
      name: doc.name, qualification: doc.qualification, specialty: doc.specialty,
      registrationNumber: doc.registrationNumber, phone: doc.phone || '', letterheadNote: doc.letterheadNote || '',
    });
    setClinicEditingId(doc.id);
    setClinicShowForm(true);
  };

  const handleClinicDelete = async () => {
    if (!clinicDeleteId) return;
    try {
      const res = await fetch(`${API_BASE}/clinic-doctors/${clinicDeleteId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success('Doctor deleted');
      await fetchClinicDoctors();
    } catch { toast.error('Failed to delete'); }
    setClinicDeleteId(null);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTIC CENTERS
  // ═══════════════════════════════════════════════════════════════════════════

  const fetchCenters = async () => {
    if (!token) return;
    try {
      const { activeBranchId } = useBranchStore.getState();
      const res = await fetch(`${API_BASE}/diagnostic-centers?includeInactive=true`, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Branch-Id': activeBranchId || '' },
      });
      if (res.ok) setCenters(await res.json());
      else toast.error('Failed to load diagnostic centers');
    } catch { toast.error('Failed to load diagnostic centers'); }
    finally { setCentersLoading(false); }
  };

  useEffect(() => { fetchCenters(); }, [token]);

  const centerResetForm = () => {
    setCenterForm({ ...EMPTY_CENTER_FORM });
    setCenterDialogOpen(false);
    setCenterEditingId(null);
  };

  const handleCenterSubmit = async () => {
    if (!centerForm.name.trim()) { toast.error('Center name is required'); return; }
    const commission = parseFloat(centerForm.commissionPercent);
    if (isNaN(commission) || commission < 0 || commission > 100) {
      toast.error('Commission must be 0–100'); return;
    }
    const payload = {
      name: centerForm.name.trim(),
      contactPerson: centerForm.contactPerson.trim() || null,
      phone: centerForm.phone.trim() || null,
      email: centerForm.email.trim() || null,
      address: centerForm.address.trim() || null,
      commissionPercent: commission,
    };
    try {
      if (centerEditingId) {
        const res = await fetch(`${API_BASE}/diagnostic-centers/${centerEditingId}`, {
          method: 'PATCH', headers: branchHeaders(token), body: JSON.stringify(payload),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Center updated');
      } else {
        const res = await fetch(`${API_BASE}/diagnostic-centers`, {
          method: 'POST', headers: branchHeaders(token), body: JSON.stringify(payload),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Center created');
      }
      await fetchCenters();
      centerResetForm();
    } catch { toast.error('Failed to save center'); }
  };

  const handleCenterToggle = async (center: DiagnosticCenter) => {
    try {
      const res = await fetch(`${API_BASE}/diagnostic-centers/${center.id}`, {
        method: 'PATCH', headers: branchHeaders(token),
        body: JSON.stringify({ isActive: !center.isActive }),
      });
      if (!res.ok) { toast.error('Failed to update status'); return; }
      toast.success(`Center ${!center.isActive ? 'activated' : 'deactivated'}`);
      await fetchCenters();
    } catch { toast.error('Failed to update status'); }
  };

  const handleCenterDelete = async () => {
    if (!centerDeleteId) return;
    try {
      const res = await fetch(`${API_BASE}/diagnostic-centers/${centerDeleteId}`, {
        method: 'DELETE', headers: branchHeaders(token),
      });
      if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
      toast.success('Center deactivated');
      await fetchCenters();
    } catch { toast.error('Failed to delete'); }
    setCenterDeleteId(null);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <Tabs defaultValue="referral" className="space-y-4">
      <TabsList>
        <TabsTrigger value="referral">Referral Doctors</TabsTrigger>
        <TabsTrigger value="clinic">Clinic Doctors</TabsTrigger>
        <TabsTrigger value="centers">Diagnostic Centers</TabsTrigger>
      </TabsList>

      {/* ════════════════════════════════ REFERRAL DOCTORS ══════════════════ */}
      <TabsContent value="referral" className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Add doctors with commission percentages for referrals.
          </p>
          {!refShowForm && (
            <Button onClick={() => setRefShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" /> Add Doctor
            </Button>
          )}
        </div>

        {refShowForm && (
          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle>{refEditingId ? 'Edit Doctor' : 'Add Referral Doctor'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Doctor Name *</Label>
                  <Input placeholder="Dr. Name (type to search)" value={refForm.name}
                    onChange={(e) => handleRefNameChange(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Phone *</Label>
                  <Input placeholder="10-digit phone" value={refForm.phone} maxLength={10}
                    onChange={(e) => { setRefForm(f => ({ ...f, phone: e.target.value })); refCheckPhone(e.target.value); }} />
                </div>
                <div className="space-y-2">
                  <Label>Commission % *</Label>
                  <Input type="number" placeholder="e.g. 10" value={refForm.commissionPercent} min={0} max={100}
                    onChange={(e) => setRefForm(f => ({ ...f, commissionPercent: e.target.value }))} />
                </div>
              </div>

              {refExistingDoctor?.type === 'clinic' && (
                <Alert className="border-yellow-500 bg-yellow-50">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-yellow-800">Clinic Doctor Found</p>
                      <p className="text-sm text-yellow-700">
                        {refExistingDoctor.doctor.name} ({refExistingDoctor.doctor.doctorNumber}) — {refExistingDoctor.doctor.specialty}
                      </p>
                    </div>
                    {!refLinkedDoctorId ? (
                      <Button size="sm" variant="outline" className="ml-4" onClick={refLinkToClinic}>
                        <LinkIcon className="h-4 w-4 mr-2" /> Link
                      </Button>
                    ) : (
                      <span className="text-green-700 text-sm flex items-center ml-4">
                        <Check className="h-4 w-4 mr-1" /> Linked
                      </span>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={refResetForm}><X className="h-4 w-4 mr-2" />Cancel</Button>
                <Button onClick={handleRefSubmit}><Check className="h-4 w-4 mr-2" />{refEditingId ? 'Update' : 'Add'}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {refLoading ? (
          <p className="text-center text-muted-foreground py-6">Loading...</p>
        ) : referralDoctors.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No referral doctors yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Commission %</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {referralDoctors.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.name}</TableCell>
                  <TableCell>{doc.phone}</TableCell>
                  <TableCell className="text-right font-mono">{doc.commissionPercent}%</TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => handleRefEdit(doc)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => setRefDeleteId(doc.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <AlertDialog open={!!refDeleteId} onOpenChange={() => setRefDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Referral Doctor?</AlertDialogTitle>
              <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleRefDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TabsContent>

      {/* ════════════════════════════════ CLINIC DOCTORS ════════════════════ */}
      <TabsContent value="clinic" className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Consulting doctors with letterhead details for clinic prescriptions.
          </p>
          {!clinicShowForm && (
            <Button onClick={() => setClinicShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" /> Add Doctor
            </Button>
          )}
        </div>

        {clinicShowForm && (
          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle>{clinicEditingId ? 'Edit Doctor' : 'Add Clinic Doctor'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Doctor Name *</Label>
                  <Input placeholder="Dr. Full Name (type to search)" value={clinicForm.name}
                    onChange={(e) => { setClinicForm(f => ({ ...f, name: e.target.value })); clinicCheckName(e.target.value); }} />
                </div>
                <div className="space-y-2">
                  <Label>Qualification *</Label>
                  <Input placeholder="e.g., MBBS, MD (Gen Med)" value={clinicForm.qualification}
                    onChange={(e) => setClinicForm(f => ({ ...f, qualification: e.target.value }))} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Specialty *</Label>
                  <Input placeholder="e.g., General Medicine" value={clinicForm.specialty}
                    onChange={(e) => setClinicForm(f => ({ ...f, specialty: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Registration No. *</Label>
                  <Input placeholder="e.g., TSMC/GM/2020/1234" value={clinicForm.registrationNumber}
                    onChange={(e) => setClinicForm(f => ({ ...f, registrationNumber: e.target.value }))} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input placeholder="10-digit phone" value={clinicForm.phone} maxLength={10}
                    onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 10); setClinicForm(f => ({ ...f, phone: v })); clinicCheckPhone(v); }} />
                </div>
                <div className="space-y-2">
                  <Label>Letterhead Note</Label>
                  <Input placeholder="e.g., Compassionate primary care" value={clinicForm.letterheadNote}
                    onChange={(e) => setClinicForm(f => ({ ...f, letterheadNote: e.target.value }))} />
                </div>
              </div>

              {clinicExistingDoctor?.type === 'referral' && (
                <Alert className="border-yellow-500 bg-yellow-50">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-yellow-800">Referral Doctor Found</p>
                      <p className="text-sm text-yellow-700">
                        {clinicExistingDoctor.doctor.name} ({clinicExistingDoctor.doctor.doctorNumber}) — {clinicExistingDoctor.doctor.commissionPercent}% commission
                      </p>
                    </div>
                    {!clinicLinkedDoctorId ? (
                      <Button size="sm" variant="outline" className="ml-4" onClick={clinicLinkToReferral}>
                        <LinkIcon className="h-4 w-4 mr-2" /> Link
                      </Button>
                    ) : (
                      <span className="text-green-700 text-sm flex items-center ml-4">
                        <Check className="h-4 w-4 mr-1" /> Linked
                      </span>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={clinicResetForm}><X className="h-4 w-4 mr-2" />Cancel</Button>
                <Button onClick={handleClinicSubmit}><Check className="h-4 w-4 mr-2" />{clinicEditingId ? 'Update' : 'Add'}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {clinicLoading ? (
          <p className="text-center text-muted-foreground py-6">Loading...</p>
        ) : clinicDoctors.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No clinic doctors yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Qualification</TableHead>
                <TableHead>Specialty</TableHead>
                <TableHead>Reg. No.</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clinicDoctors.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">{doc.name}</TableCell>
                  <TableCell>{doc.qualification}</TableCell>
                  <TableCell>{doc.specialty}</TableCell>
                  <TableCell className="font-mono text-sm">{doc.registrationNumber}</TableCell>
                  <TableCell>{doc.phone || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => handleClinicEdit(doc)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => setClinicDeleteId(doc.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <AlertDialog open={!!clinicDeleteId} onOpenChange={() => setClinicDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Clinic Doctor?</AlertDialogTitle>
              <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleClinicDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TabsContent>

      {/* ════════════════════════════════ DIAGNOSTIC CENTERS ════════════════ */}
      <TabsContent value="centers" className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            External diagnostic referral centers and their commission rates.
          </p>
          <Button onClick={() => { setCenterForm({ ...EMPTY_CENTER_FORM }); setCenterEditingId(null); setCenterDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" /> Add Center
          </Button>
        </div>

        {centersLoading ? (
          <p className="text-center text-muted-foreground py-6">Loading...</p>
        ) : centers.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No diagnostic centers yet.</p>
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
                  <TableCell className="text-muted-foreground">{center.contactPerson || '—'}</TableCell>
                  <TableCell>{center.phone || '—'}</TableCell>
                  <TableCell className="text-right font-mono">{center.commissionPercent}%</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={center.isActive} onCheckedChange={() => handleCenterToggle(center)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => {
                        setCenterForm({ name: center.name, contactPerson: center.contactPerson || '', phone: center.phone || '', email: center.email || '', address: center.address || '', commissionPercent: center.commissionPercent.toString() });
                        setCenterEditingId(center.id);
                        setCenterDialogOpen(true);
                      }}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => setCenterDeleteId(center.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Center Dialog */}
        <Dialog open={centerDialogOpen} onOpenChange={(open) => { if (!open) centerResetForm(); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{centerEditingId ? 'Edit Diagnostic Center' : 'Add Diagnostic Center'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input placeholder="e.g. City Diagnostics Lab" value={centerForm.name}
                  onChange={(e) => setCenterForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Contact Person</Label>
                  <Input placeholder="e.g. Dr. Sharma" value={centerForm.contactPerson}
                    onChange={(e) => setCenterForm(f => ({ ...f, contactPerson: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input placeholder="e.g. 9876543210" value={centerForm.phone} maxLength={10}
                    onChange={(e) => setCenterForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" placeholder="e.g. info@citydiag.com" value={centerForm.email}
                  onChange={(e) => setCenterForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Address</Label>
                <Input placeholder="e.g. 123 Main Street, City" value={centerForm.address}
                  onChange={(e) => setCenterForm(f => ({ ...f, address: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Commission %</Label>
                <Input type="number" placeholder="0" value={centerForm.commissionPercent} min={0} max={100}
                  onChange={(e) => setCenterForm(f => ({ ...f, commissionPercent: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={centerResetForm}>Cancel</Button>
              <Button onClick={handleCenterSubmit}>{centerEditingId ? 'Update' : 'Create'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Center Delete Confirmation */}
        <AlertDialog open={!!centerDeleteId} onOpenChange={() => setCenterDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Diagnostic Center?</AlertDialogTitle>
              <AlertDialogDescription>
                This will deactivate the center. Existing referral records will be preserved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleCenterDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TabsContent>
    </Tabs>
  );
}
