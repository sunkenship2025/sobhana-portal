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
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { BillableProduct, DiagnosticCenter, ReferralDoctor } from '@/types';
import {
  formatReferralPayout,
  toReferralPayoutDraft,
  toReferralPayoutPayload,
  type ReferralPayoutDraft,
} from '@/lib/referralPayouts';

// ─── helpers ────────────────────────────────────────────────────────────────

function branchHeaders(token: string | null) {
  const { activeBranchId } = useBranchStore.getState();
  return {
    'Authorization': `Bearer ${token}`,
    'X-Branch-Id': activeBranchId || '',
    'Content-Type': 'application/json',
  };
}

type ReferralRuleFormItem = ReferralPayoutDraft & {
  productId: string;
};

type CenterRuleFormItem = ReferralPayoutDraft & {
  productId: string;
};

const EMPTY_CENTER_FORM = {
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  commissionType: 'PERCENTAGE' as const,
  commissionPercent: '',
  commissionAmount: '',
  productRules: [] as CenterRuleFormItem[],
};

const EMPTY_REFERRAL_FORM = {
  name: '',
  phone: '',
  commissionType: 'PERCENTAGE' as const,
  commissionPercent: '',
  commissionAmount: '',
  productRules: [] as ReferralRuleFormItem[],
};

// ─── main component ──────────────────────────────────────────────────────────

export default function ManageDoctorsAndReferrals() {
  const { token } = useAuthStore();

  // ── Referral Doctors state ────────────────────────────────────────────────
  const [referralDoctors, setReferralDoctors] = useState<ReferralDoctor[]>([]);
  const [billableProducts, setBillableProducts] = useState<BillableProduct[]>([]);
  const [refLoading, setRefLoading] = useState(true);
  const [refShowForm, setRefShowForm] = useState(false);
  const [refEditingId, setRefEditingId] = useState<string | null>(null);
  const [refDeleteId, setRefDeleteId] = useState<string | null>(null);
  const [refExistingDoctor, setRefExistingDoctor] = useState<any>(null);
  const [refLinkedDoctorId, setRefLinkedDoctorId] = useState<string | null>(null);
  const refSearchTimeout = useRef<NodeJS.Timeout | null>(null);
  const [refForm, setRefForm] = useState({ ...EMPTY_REFERRAL_FORM });

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
  const [centerShowForm, setCenterShowForm] = useState(false);
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
        headers: branchHeaders(token),
      });
      if (res.ok) setReferralDoctors(await res.json());
    } catch (err) {
      console.error('Error fetching referral doctors:', err);
    } finally {
      setRefLoading(false);
    }
  };

  useEffect(() => { fetchReferralDoctors(); }, [token]);

  const fetchBillableProducts = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/billable-products`, {
        headers: branchHeaders(token),
      });
      if (res.ok) setBillableProducts(await res.json());
    } catch (err) {
      console.error('Error fetching billable products:', err);
    }
  };

  useEffect(() => { fetchBillableProducts(); }, [token]);

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

  const addProductRule = (productId: string) => {
    if (!productId) return;

    const product = billableProducts.find((item) => item.id === productId);
    if (!product) return;

    setRefForm((current) => {
      if (current.productRules.some((rule) => rule.productId === productId)) {
        return current;
      }

      return {
        ...current,
        productRules: [
          ...current.productRules,
          {
            productId,
            commissionType: current.commissionType,
            commissionPercent: current.commissionPercent,
            commissionAmount: current.commissionAmount,
          },
        ],
      };
    });
  };

  const updateProductRule = (productId: string, patch: Partial<ReferralRuleFormItem>) => {
    setRefForm((current) => ({
      ...current,
      productRules: current.productRules.map((rule) =>
        rule.productId === productId ? { ...rule, ...patch } : rule
      ),
    }));
  };

  const removeProductRule = (productId: string) => {
    setRefForm((current) => ({
      ...current,
      productRules: current.productRules.filter((rule) => rule.productId !== productId),
    }));
  };

  const refResetForm = () => {
    setRefForm({ ...EMPTY_REFERRAL_FORM });
    setRefShowForm(false);
    setRefEditingId(null);
    setRefExistingDoctor(null);
    setRefLinkedDoctorId(null);
  };

  const handleRefSubmit = async () => {
    if (!refForm.name || !refForm.phone) {
      toast.error('Please fill all fields'); return;
    }

    if (refForm.commissionType === 'PERCENTAGE') {
      const commission = parseFloat(refForm.commissionPercent);
      if (isNaN(commission) || commission < 0 || commission > 100) {
        toast.error('Percentage must be between 0 and 100'); return;
      }
    } else {
      const amount = parseFloat(refForm.commissionAmount);
      if (isNaN(amount) || amount < 0) {
        toast.error('Amount must be a non-negative number'); return;
      }
    }

    for (const rule of refForm.productRules) {
      if (rule.commissionType === 'PERCENTAGE') {
        const commission = parseFloat(rule.commissionPercent);
        if (isNaN(commission) || commission < 0 || commission > 100) {
          toast.error('Each product percentage must be between 0 and 100'); return;
        }
      } else {
        const amount = parseFloat(rule.commissionAmount);
        if (isNaN(amount) || amount < 0) {
          toast.error('Each product amount must be a non-negative number'); return;
        }
      }
    }

    const payload = {
      name: refForm.name,
      phone: refForm.phone,
      clinicDoctorId: refLinkedDoctorId,
      ...toReferralPayoutPayload(refForm),
      productRules: refForm.productRules.map((rule) => ({
        productId: rule.productId,
        ...toReferralPayoutPayload(rule),
      })),
    };

    try {
      if (refEditingId) {
        const res = await fetch(`${API_BASE}/referral-doctors/${refEditingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Doctor updated');
      } else {
        const res = await fetch(`${API_BASE}/referral-doctors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { const e = await res.json(); toast.error(e.message || 'Failed'); return; }
        toast.success('Doctor added');
      }
      await fetchReferralDoctors();
      refResetForm();
    } catch { toast.error('Failed to save doctor'); }
  };

  const handleRefEdit = (doc: any) => {
    setRefForm({
      name: doc.name,
      phone: doc.phone || '',
      ...toReferralPayoutDraft(doc),
      productRules: (doc.productRules || []).map((rule: any) => ({
        productId: rule.productId,
        ...toReferralPayoutDraft(rule),
      })),
    });
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

  const addCenterProductRule = (productId: string) => {
    if (!productId) return;

    const product = billableProducts.find((item) => item.id === productId);
    if (!product) return;

    setCenterForm((current) => {
      if (current.productRules.some((rule) => rule.productId === productId)) {
        return current;
      }

      return {
        ...current,
        productRules: [
          ...current.productRules,
          {
            productId,
            commissionType: current.commissionType,
            commissionPercent: current.commissionPercent,
            commissionAmount: current.commissionAmount,
          },
        ],
      };
    });
  };

  const updateCenterProductRule = (productId: string, patch: Partial<CenterRuleFormItem>) => {
    setCenterForm((current) => ({
      ...current,
      productRules: current.productRules.map((rule) =>
        rule.productId === productId ? { ...rule, ...patch } : rule
      ),
    }));
  };

  const removeCenterProductRule = (productId: string) => {
    setCenterForm((current) => ({
      ...current,
      productRules: current.productRules.filter((rule) => rule.productId !== productId),
    }));
  };

  const centerResetForm = () => {
    setCenterForm({ ...EMPTY_CENTER_FORM });
    setCenterShowForm(false);
    setCenterEditingId(null);
  };

  const handleCenterSubmit = async () => {
    if (!centerForm.name.trim()) { toast.error('Center name is required'); return; }

    if (centerForm.commissionType === 'PERCENTAGE') {
      const commission = parseFloat(centerForm.commissionPercent);
      if (isNaN(commission) || commission < 0 || commission > 100) {
        toast.error('Percentage must be between 0 and 100'); return;
      }
    } else {
      const amount = parseFloat(centerForm.commissionAmount);
      if (isNaN(amount) || amount < 0) {
        toast.error('Amount must be a non-negative number'); return;
      }
    }

    for (const rule of centerForm.productRules) {
      if (rule.commissionType === 'PERCENTAGE') {
        const commission = parseFloat(rule.commissionPercent);
        if (isNaN(commission) || commission < 0 || commission > 100) {
          toast.error('Each product percentage must be between 0 and 100'); return;
        }
      } else {
        const amount = parseFloat(rule.commissionAmount);
        if (isNaN(amount) || amount < 0) {
          toast.error('Each product amount must be a non-negative number'); return;
        }
      }
    }

    const payload = {
      name: centerForm.name.trim(),
      contactPerson: centerForm.contactPerson.trim() || null,
      phone: centerForm.phone.trim() || null,
      email: centerForm.email.trim() || null,
      address: centerForm.address.trim() || null,
      ...toReferralPayoutPayload(centerForm),
      productRules: centerForm.productRules.map((rule) => ({
        productId: rule.productId,
        ...toReferralPayoutPayload(rule),
      })),
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

  const handleCenterEdit = (center: DiagnosticCenter) => {
    setCenterForm({
      name: center.name,
      contactPerson: center.contactPerson || '',
      phone: center.phone || '',
      email: center.email || '',
      address: center.address || '',
      ...toReferralPayoutDraft(center),
      productRules: (center.productRules || []).map((rule) => ({
        productId: rule.productId,
        ...toReferralPayoutDraft(rule),
      })),
    });
    setCenterEditingId(center.id);
    setCenterShowForm(true);
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
            Set a saved default payout for each referral doctor and override it for specific billable products.
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
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Doctor Name *</Label>
                    <Input placeholder="Dr. Name (type to search)" value={refForm.name}
                      onChange={(e) => handleRefNameChange(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Phone *</Label>
                    <Input placeholder="10-digit phone" value={refForm.phone} maxLength={10}
                      onChange={(e) => {
                        const next = e.target.value.replace(/\D/g, '').slice(0, 10);
                        setRefForm((f) => ({ ...f, phone: next }));
                        refCheckPhone(next);
                      }} />
                  </div>
                </div>

                <div className="rounded-xl border bg-muted/20 p-4 space-y-4">
                  <div>
                    <p className="text-sm font-medium">Default Payout</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Used for future bills unless a product-specific value is saved below.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
                    <Select
                      value={refForm.commissionType}
                      onValueChange={(value) =>
                        setRefForm((current) => ({
                          ...current,
                          commissionType: value as ReferralPayoutDraft['commissionType'],
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                        <SelectItem value="FIXED_AMOUNT">Amount</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      max={refForm.commissionType === 'PERCENTAGE' ? 100 : undefined}
                      step={refForm.commissionType === 'PERCENTAGE' ? '0.01' : '1'}
                      placeholder={refForm.commissionType === 'PERCENTAGE' ? 'e.g. 10' : 'e.g. 150'}
                      value={
                        refForm.commissionType === 'PERCENTAGE'
                          ? refForm.commissionPercent
                          : refForm.commissionAmount
                      }
                      onChange={(e) => {
                        const next = e.target.value;
                        setRefForm((current) => ({
                          ...current,
                          commissionPercent:
                            current.commissionType === 'PERCENTAGE'
                              ? next
                              : current.commissionPercent,
                          commissionAmount:
                            current.commissionType === 'FIXED_AMOUNT'
                              ? next
                              : current.commissionAmount,
                        }));
                      }}
                    />
                  </div>
                  <p className="text-sm font-medium">
                    {formatReferralPayout({
                      commissionType: refForm.commissionType,
                      commissionPercent:
                        refForm.commissionType === 'PERCENTAGE'
                          ? Number(refForm.commissionPercent || 0)
                          : null,
                      commissionAmountInPaise:
                        refForm.commissionType === 'FIXED_AMOUNT'
                          ? Math.round(Number(refForm.commissionAmount || 0) * 100)
                          : null,
                    })}
                  </p>
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

              <div className="rounded-xl border bg-muted/20 p-4 space-y-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="font-medium">Product-Specific Payouts</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Save percentage or amount rules for selected billable products.
                    </p>
                  </div>
                  <div className="w-full max-w-md">
                    <SearchableSelect
                      onValueChange={addProductRule}
                      options={billableProducts
                        .filter((product) => !refForm.productRules.some((rule) => rule.productId === product.id))
                        .map((product) => ({
                          value: product.id,
                          label: product.name,
                          description: [product.code, `₹${(product.effectivePrice ?? product.basePrice).toLocaleString('en-IN')}`].join(' · '),
                          keywords: [product.name, product.code].join(' '),
                        }))}
                      placeholder="Add billable product rule"
                      searchPlaceholder="Search product by name or code"
                      emptyText="All active products already have a rule."
                    />
                  </div>
                </div>

                {refForm.productRules.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-background px-4 py-6 text-sm text-muted-foreground">
                    No product-specific rules yet. Bills will use the doctor default for every product.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {refForm.productRules.map((rule) => {
                      const product = billableProducts.find((item) => item.id === rule.productId);
                      return (
                        <div key={rule.productId} className="rounded-lg border bg-background p-4">
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_160px_auto] md:items-start">
                            <div className="space-y-1">
                              <p className="font-medium">{product?.name || 'Unknown product'}</p>
                              <p className="text-sm text-muted-foreground">
                                {product?.code || rule.productId}
                              </p>
                            </div>
                            <Select
                              value={rule.commissionType}
                              onValueChange={(value) =>
                                updateProductRule(rule.productId, {
                                  commissionType: value as ReferralPayoutDraft['commissionType'],
                                })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                                <SelectItem value="FIXED_AMOUNT">Amount</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              type="number"
                              min={0}
                              max={rule.commissionType === 'PERCENTAGE' ? 100 : undefined}
                              step={rule.commissionType === 'PERCENTAGE' ? '0.01' : '1'}
                              placeholder={rule.commissionType === 'PERCENTAGE' ? 'Enter %' : 'Enter amount'}
                              value={rule.commissionType === 'PERCENTAGE' ? rule.commissionPercent : rule.commissionAmount}
                              onChange={(e) =>
                                updateProductRule(rule.productId, {
                                  commissionPercent:
                                    rule.commissionType === 'PERCENTAGE'
                                      ? e.target.value
                                      : rule.commissionPercent,
                                  commissionAmount:
                                    rule.commissionType === 'FIXED_AMOUNT'
                                      ? e.target.value
                                      : rule.commissionAmount,
                                })
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeProductRule(rule.productId)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

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
                <TableHead>Default Payout</TableHead>
                <TableHead>Product Rules</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {referralDoctors.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">
                    <div>{doc.name}</div>
                    <div className="text-xs text-muted-foreground">{doc.doctorNumber}</div>
                  </TableCell>
                  <TableCell>{doc.phone || '—'}</TableCell>
                  <TableCell className="font-medium">{formatReferralPayout(doc)}</TableCell>
                  <TableCell>
                    {doc.productRules?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {doc.productRules.slice(0, 3).map((rule) => (
                          <Badge key={rule.id} variant="secondary" className="font-normal">
                            {(rule.product?.code || rule.product?.name || 'Product')}: {formatReferralPayout(rule)}
                          </Badge>
                        ))}
                        {doc.productRules.length > 3 && (
                          <Badge variant="outline">+{doc.productRules.length - 3} more</Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">Uses default for all products</span>
                    )}
                  </TableCell>
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
                        {clinicExistingDoctor.doctor.name} ({clinicExistingDoctor.doctor.doctorNumber}) — {formatReferralPayout(clinicExistingDoctor.doctor)} payout
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
            Set a saved default payout for each external diagnostic center and override it for specific billable products.
          </p>
          {!centerShowForm && (
            <Button onClick={() => { setCenterForm({ ...EMPTY_CENTER_FORM }); setCenterEditingId(null); setCenterShowForm(true); }}>
              <Plus className="h-4 w-4 mr-2" /> Add Center
            </Button>
          )}
        </div>

        {centerShowForm && (
          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle>{centerEditingId ? 'Edit Diagnostic Center' : 'Add Diagnostic Center'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Center Name *</Label>
                    <Input
                      placeholder="e.g. City Diagnostics Lab"
                      value={centerForm.name}
                      onChange={(e) => setCenterForm((current) => ({ ...current, name: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Contact Person</Label>
                    <Input
                      placeholder="e.g. Dr. Sharma"
                      value={centerForm.contactPerson}
                      onChange={(e) => setCenterForm((current) => ({ ...current, contactPerson: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input
                      placeholder="10-digit phone"
                      value={centerForm.phone}
                      maxLength={10}
                      onChange={(e) => {
                        const next = e.target.value.replace(/\D/g, '').slice(0, 10);
                        setCenterForm((current) => ({ ...current, phone: next }));
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input
                      type="email"
                      placeholder="e.g. info@citydiag.com"
                      value={centerForm.email}
                      onChange={(e) => setCenterForm((current) => ({ ...current, email: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Address</Label>
                    <Input
                      placeholder="e.g. 123 Main Street, City"
                      value={centerForm.address}
                      onChange={(e) => setCenterForm((current) => ({ ...current, address: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="rounded-xl border bg-muted/20 p-4 space-y-4">
                  <div>
                    <p className="text-sm font-medium">Default Payout</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Used for future bills unless a product-specific value is saved below.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
                    <Select
                      value={centerForm.commissionType}
                      onValueChange={(value) =>
                        setCenterForm((current) => ({
                          ...current,
                          commissionType: value as ReferralPayoutDraft['commissionType'],
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                        <SelectItem value="FIXED_AMOUNT">Amount</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      max={centerForm.commissionType === 'PERCENTAGE' ? 100 : undefined}
                      step={centerForm.commissionType === 'PERCENTAGE' ? '0.01' : '1'}
                      placeholder={centerForm.commissionType === 'PERCENTAGE' ? 'e.g. 12' : 'e.g. 180'}
                      value={
                        centerForm.commissionType === 'PERCENTAGE'
                          ? centerForm.commissionPercent
                          : centerForm.commissionAmount
                      }
                      onChange={(e) => {
                        const next = e.target.value;
                        setCenterForm((current) => ({
                          ...current,
                          commissionPercent:
                            current.commissionType === 'PERCENTAGE'
                              ? next
                              : current.commissionPercent,
                          commissionAmount:
                            current.commissionType === 'FIXED_AMOUNT'
                              ? next
                              : current.commissionAmount,
                        }));
                      }}
                    />
                  </div>
                  <p className="text-sm font-medium">
                    {formatReferralPayout({
                      commissionType: centerForm.commissionType,
                      commissionPercent:
                        centerForm.commissionType === 'PERCENTAGE'
                          ? Number(centerForm.commissionPercent || 0)
                          : null,
                      commissionAmountInPaise:
                        centerForm.commissionType === 'FIXED_AMOUNT'
                          ? Math.round(Number(centerForm.commissionAmount || 0) * 100)
                          : null,
                    })}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border bg-muted/20 p-4 space-y-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="font-medium">Product-Specific Payouts</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Save percentage or amount rules for selected billable products.
                    </p>
                  </div>
                  <div className="w-full max-w-md">
                    <SearchableSelect
                      onValueChange={addCenterProductRule}
                      options={billableProducts
                        .filter((product) => !centerForm.productRules.some((rule) => rule.productId === product.id))
                        .map((product) => ({
                          value: product.id,
                          label: product.name,
                          description: [product.code, `₹${(product.effectivePrice ?? product.basePrice).toLocaleString('en-IN')}`].join(' · '),
                          keywords: [product.name, product.code].join(' '),
                        }))}
                      placeholder="Add billable product rule"
                      searchPlaceholder="Search product by name or code"
                      emptyText="All active products already have a rule."
                    />
                  </div>
                </div>

                {centerForm.productRules.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-background px-4 py-6 text-sm text-muted-foreground">
                    No product-specific rules yet. Bills will use the center default for every product.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {centerForm.productRules.map((rule) => {
                      const product = billableProducts.find((item) => item.id === rule.productId);
                      return (
                        <div key={rule.productId} className="rounded-lg border bg-background p-4">
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_160px_auto] md:items-start">
                            <div className="space-y-1">
                              <p className="font-medium">{product?.name || 'Unknown product'}</p>
                              <p className="text-sm text-muted-foreground">
                                {product?.code || rule.productId}
                              </p>
                            </div>
                            <Select
                              value={rule.commissionType}
                              onValueChange={(value) =>
                                updateCenterProductRule(rule.productId, {
                                  commissionType: value as ReferralPayoutDraft['commissionType'],
                                })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                                <SelectItem value="FIXED_AMOUNT">Amount</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              type="number"
                              min={0}
                              max={rule.commissionType === 'PERCENTAGE' ? 100 : undefined}
                              step={rule.commissionType === 'PERCENTAGE' ? '0.01' : '1'}
                              placeholder={rule.commissionType === 'PERCENTAGE' ? 'Enter %' : 'Enter amount'}
                              value={rule.commissionType === 'PERCENTAGE' ? rule.commissionPercent : rule.commissionAmount}
                              onChange={(e) =>
                                updateCenterProductRule(rule.productId, {
                                  commissionPercent:
                                    rule.commissionType === 'PERCENTAGE'
                                      ? e.target.value
                                      : rule.commissionPercent,
                                  commissionAmount:
                                    rule.commissionType === 'FIXED_AMOUNT'
                                      ? e.target.value
                                      : rule.commissionAmount,
                                })
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeCenterProductRule(rule.productId)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={centerResetForm}><X className="h-4 w-4 mr-2" />Cancel</Button>
                <Button onClick={handleCenterSubmit}><Check className="h-4 w-4 mr-2" />{centerEditingId ? 'Update' : 'Add'}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {centersLoading ? (
          <p className="text-center text-muted-foreground py-6">Loading...</p>
        ) : centers.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No diagnostic centers yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Center</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Default Payout</TableHead>
                <TableHead>Product Rules</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {centers.map((center) => (
                <TableRow key={center.id} className={!center.isActive ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">
                    <div>{center.name}</div>
                    <div className="text-xs text-muted-foreground">{center.centerNumber}</div>
                  </TableCell>
                  <TableCell>
                    <div>{center.contactPerson || '—'}</div>
                    <div className="text-xs text-muted-foreground">{center.phone || center.email || '—'}</div>
                  </TableCell>
                  <TableCell className="font-medium">{formatReferralPayout(center)}</TableCell>
                  <TableCell>
                    {center.productRules?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {center.productRules.slice(0, 3).map((rule) => (
                          <Badge key={rule.id} variant="secondary" className="font-normal">
                            {(rule.product?.code || rule.product?.name || 'Product')}: {formatReferralPayout(rule)}
                          </Badge>
                        ))}
                        {center.productRules.length > 3 && (
                          <Badge variant="outline">+{center.productRules.length - 3} more</Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">Uses default for all products</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch checked={center.isActive} onCheckedChange={() => handleCenterToggle(center)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => handleCenterEdit(center)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => setCenterDeleteId(center.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

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
