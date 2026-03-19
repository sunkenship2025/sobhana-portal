import { useState, useRef, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ProductSelector, type ProductForSelector } from '@/components/diagnostics/ProductSelector';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from 'sonner';
import type {
  Patient,
  PatientSearchResult,
  PaymentType,
  DiagnosticVisitView,
  TestOrder,
  ReferralDoctor,
  DiagnosticCenter,
  BillReceiptData,
} from '@/types';
import { Search, UserPlus, CheckCircle2, Printer, MessageCircle } from 'lucide-react';
import { BillReceipt } from '@/components/print/BillReceipt';
import { validatePatientForm, computeSmartAge, formatAgeDisplay, type ValidationErrors } from '@/lib/validation';
import {
  areReferralPayoutsEqual,
  formatReferralPayout,
  getEffectiveDiagnosticCenterPayout,
  getEffectiveDoctorPayout,
  toReferralPayoutDraft,
  toReferralPayoutPayload,
  type ReferralPayoutDraft,
} from '@/lib/referralPayouts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const DiagnosticsNewVisit = () => {
  const navigate = useNavigate();
  const printRef = useRef<HTMLDivElement>(null);
  const { token } = useAuthStore();
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();

  // API data state
  const [products, setProducts] = useState<ProductForSelector[]>([]);
  const [referralDoctors, setReferralDoctors] = useState<ReferralDoctor[]>([]);
  const [diagnosticCenters, setDiagnosticCenters] = useState<DiagnosticCenter[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCenterId, setSelectedCenterId] = useState<string>('');

  const [phone, setPhone] = useState('');
  const [billSearch, setBillSearch] = useState('');
  const [matchingPatients, setMatchingPatients] = useState<PatientSearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [paymentType, setPaymentType] = useState<PaymentType>('CASH');
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
  const [referralOverrides, setReferralOverrides] = useState<Record<string, ReferralPayoutDraft>>({});
  const [diagnosticCenterOverrides, setDiagnosticCenterOverrides] = useState<Record<string, ReferralPayoutDraft>>({});
  const [successData, setSuccessData] = useState<{ visitView: DiagnosticVisitView } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [whatsappOptIn, setWhatsappOptIn] = useState(true); // For existing patients

  // New patient form
  const [newPatient, setNewPatient] = useState({
    name: '',
    age: '',
    ageUnit: 'YEARS' as 'DAYS' | 'MONTHS' | 'YEARS',
    dateOfBirth: '', // E2-09: Optional DOB field
    gender: 'M' as 'M' | 'F' | 'O',
    whatsappOptIn: true, // Default: opted in for WhatsApp notifications
  });
  
  // E2-10: Validation errors
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  // Fetch lab tests and referral doctors from API
  useEffect(() => {
    const fetchData = async () => {
      if (!token || !activeBranch) return;
      
      try {
        const headers = {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranch.id,
        };

        const [productsRes, doctorsRes, centersRes] = await Promise.all([
          fetch(`${API_BASE}/billable-products`, { headers }),
          fetch(`${API_BASE}/referral-doctors`, { headers }),
          fetch(`${API_BASE}/diagnostic-centers`, { headers }),
        ]);

        if (productsRes.ok) {
          const prods = await productsRes.json();
          setProducts(prods);
        }
        if (doctorsRes.ok) {
          const doctors = await doctorsRes.json();
          setReferralDoctors(doctors);
        }
        if (centersRes.ok) {
          const centers = await centersRes.json();
          setDiagnosticCenters(centers);
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [token, activeBranch]);

  const selectedDoctor = referralDoctors.find((doctor) => doctor.id === selectedDoctorId);
  const selectedCenter = diagnosticCenters.find((center) => center.id === selectedCenterId);

  const buildOverridesForProducts = (
    productIds: string[],
    resolveSavedPayout: (productId: string) => {
      commissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
      commissionPercent?: number | null;
      commissionAmountInPaise?: number | null;
    },
    existing: Record<string, ReferralPayoutDraft> = {}
  ) => {
    const next: Record<string, ReferralPayoutDraft> = {};

    for (const productId of productIds) {
      next[productId] =
        existing[productId] ??
        toReferralPayoutDraft(resolveSavedPayout(productId));
    }

    return next;
  };

  // Search patients via API
  const handleSearch = async () => {
    if (phone.length >= 10 && token && activeBranch) {
      try {
        const res = await fetch(`${API_BASE}/patients/search?phone=${phone}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranch.id,
          },
        });
        if (res.ok) {
          const results = await res.json();
          setMatchingPatients(results);
          setSelectedPatient(null);
          setShowNewPatientForm(false);
        }
      } catch (error) {
        console.error('Search failed:', error);
      }
    }
  };

  const handlePhoneChange = async (value: string) => {
    setPhone(value);
    if (value.length === 10 && token && activeBranch) {
      try {
        const res = await fetch(`${API_BASE}/patients/search?phone=${value}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranch.id,
          },
        });
        if (res.ok) {
          const results = await res.json();
          setMatchingPatients(results);
        }
      } catch (error) {
        console.error('Search failed:', error);
      }
    } else {
      setMatchingPatients([]);
    }
  };

  const handleCreateNewPatient = () => {
    setShowNewPatientForm(true);
    setSelectedPatient(null);
  };

  const handleSelectPatient = (result: PatientSearchResult) => {
    setSelectedPatient(result.patient);
    setShowNewPatientForm(false);
    // Auto-check WhatsApp opt-in if patient already opted in
    setWhatsappOptIn((result.patient as any).whatsappOptIn ?? true);
  };

  const totalAmount = selectedProducts.reduce((sum, prodId) => {
    const product = products.find((p) => p.id === prodId);
    return sum + (product?.effectivePrice ?? 0);
  }, 0);

  const handleSubmit = async () => {
    if (!token || !activeBranch) {
      toast.error('Not authenticated');
      return;
    }

    let patient = selectedPatient;

    // Create new patient if needed
    if (showNewPatientForm && !selectedPatient) {
      // E2-10: Validate patient form
      const errors = validatePatientForm({
        name: newPatient.name,
        age: newPatient.age,
        gender: newPatient.gender,
        phone,
        ageUnit: newPatient.ageUnit,
      });

      if (Object.keys(errors).length > 0) {
        setValidationErrors(errors);
        toast.error('Please fix validation errors before submitting');
        return;
      }

      if (!newPatient.name || (!newPatient.age && !newPatient.dateOfBirth)) { // E2-09: Accept either age or DOB
        toast.error('Please fill in all patient details');
        return;
      }
      
      try {
        const res = await fetch(`${API_BASE}/patients`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Branch-Id': activeBranch.id,
          },
          body: JSON.stringify({
            name: newPatient.name,
            age: newPatient.age ? parseInt(newPatient.age) : undefined, // E2-09: Age optional if DOB provided
            ageUnit: newPatient.ageUnit, // Smart age unit
            dateOfBirth: newPatient.dateOfBirth ? newPatient.dateOfBirth.split('T')[0] : undefined, // E2-09: Send date-only (YYYY-MM-DD)
            gender: newPatient.gender,
            identifiers: [{ type: 'PHONE', value: phone, isPrimary: true }],
            whatsappOptIn: newPatient.whatsappOptIn,
          }),
        });
        
        if (res.status === 409) {
          // E2-03: Potential duplicate detected
          const errorData = await res.json();
          const duplicateInfo = JSON.parse(errorData.message);
          const existing = duplicateInfo.existingPatient;
          
          const userConfirm = window.confirm(
            `⚠️ Potential Duplicate Detected\n\n` +
            `Existing Patient: ${existing.patientNumber}\n` +
            `Name: ${existing.name}\n` +
            `Age: ${existing.ageDisplay || existing.age}, Gender: ${existing.gender}\n` +
            `Phone: ${existing.phone}\n\n` +
            `This looks like the same person. Do you want to:\n` +
            `• Click OK to USE EXISTING patient\n` +
            `• Click Cancel to CREATE NEW patient anyway`
          );
          
          if (userConfirm) {
            // Use existing patient
            patient = { id: existing.id, patientNumber: existing.patientNumber, name: existing.name, age: existing.age, yearOfBirth: existing.yearOfBirth, gender: existing.gender, identifiers: existing.identifiers || [], createdAt: existing.createdAt || new Date() };
            toast.success(`Using existing patient ${existing.patientNumber}`);
          } else {
            // User wants to force create duplicate - retry with forceDuplicate flag
            const retryRes = await fetch(`${API_BASE}/patients`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Branch-Id': activeBranch.id,
              },
              body: JSON.stringify({
                name: newPatient.name,
                age: newPatient.age ? parseInt(newPatient.age) : undefined, // E2-09: Age optional if DOB provided
                ageUnit: newPatient.ageUnit, // Smart age unit
                dateOfBirth: newPatient.dateOfBirth ? newPatient.dateOfBirth.split('T')[0] : undefined, // E2-09: Send date-only (YYYY-MM-DD)
                gender: newPatient.gender,
                identifiers: [{ type: 'PHONE', value: phone, isPrimary: true }],
                whatsappOptIn: newPatient.whatsappOptIn,
                forceDuplicate: true, // E2-03: Explicit user confirmation
              }),
            });
            
            if (!retryRes.ok) {
              throw new Error('Failed to create patient');
            }
            patient = await retryRes.json();
            toast.success('Created new patient record');
          }
        } else if (!res.ok) {
          throw new Error('Failed to create patient');
        } else {
          patient = await res.json();
        }
      } catch (error) {
        toast.error('Failed to create patient');
        return;
      }
    }

    if (!patient) {
      toast.error('Please select or create a patient');
      return;
    }

    if (selectedProducts.length === 0) {
      toast.error('Please select at least one test');
      return;
    }

    setIsSubmitting(true);

    try {
      // Create diagnostic visit via API
      const res = await fetch(`${API_BASE}/visits/diagnostic`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranch.id,
        },
        body: JSON.stringify({
          patientId: patient.id,
          referralDoctorId: selectedDoctorId || null,
          diagnosticCenterId: selectedCenterId || null,
          referralOverrides: selectedDoctorId
            ? Object.fromEntries(
                selectedProducts
                  .map((productId) => {
                    const draft =
                      referralOverrides[productId] ??
                      toReferralPayoutDraft(getEffectiveDoctorPayout(selectedDoctor, productId));
                    const savedPayout = getEffectiveDoctorPayout(selectedDoctor, productId);
                    return {
                      productId,
                      payload: toReferralPayoutPayload(draft),
                      hasChanged: !areReferralPayoutsEqual(draft, savedPayout),
                    };
                  })
                  .filter((item) => item.hasChanged)
                  .map((item) => [item.productId, item.payload])
              )
            : undefined,
          diagnosticCenterOverrides: selectedCenterId
            ? Object.fromEntries(
                selectedProducts
                  .map((productId) => {
                    const draft =
                      diagnosticCenterOverrides[productId] ??
                      toReferralPayoutDraft(getEffectiveDiagnosticCenterPayout(selectedCenter, productId));
                    const savedPayout = getEffectiveDiagnosticCenterPayout(selectedCenter, productId);
                    return {
                      productId,
                      payload: toReferralPayoutPayload(draft),
                      hasChanged: !areReferralPayoutsEqual(draft, savedPayout),
                    };
                  })
                  .filter((item) => item.hasChanged)
                  .map((item) => [item.productId, item.payload])
              )
            : undefined,
          productIds: selectedProducts,
          paymentType,
          paymentStatus: 'PAID',
          sendWhatsApp: showNewPatientForm ? newPatient.whatsappOptIn : whatsappOptIn,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || 'Failed to create visit');
      }

      const visit = await res.json();
      const referralDoctor = selectedDoctorId ? selectedDoctor : undefined;

      // Calculate total amount in paise from selected products
      const totalAmountInPaise = Math.round(selectedProducts.reduce((sum, prodId) => {
        const product = products.find((p) => p.id === prodId);
        return sum + (product?.effectivePrice ?? 0) * 100;
      }, 0));

      // Use test orders from backend response if available, otherwise build from products
      const testOrders: TestOrder[] = visit.testOrders ?? selectedProducts.map((prodId, index) => {
        const product = products.find((p) => p.id === prodId)!;
        const payoutDraft =
          referralOverrides[prodId] ??
          toReferralPayoutDraft(getEffectiveDoctorPayout(selectedDoctor, prodId));
        const payoutPayload = selectedDoctorId ? toReferralPayoutPayload(payoutDraft) : undefined;
        return {
          id: `${visit.id}-to-${index}`,
          visitId: visit.id,
          productId: product.id,
          testName: product.name,
          testCode: product.code,
          priceInPaise: Math.round(product.effectivePrice * 100),
          referenceRange: { min: 0, max: 0, unit: '' },
          referralCommissionType: payoutPayload?.commissionType,
          referralCommissionPercent: payoutPayload?.commissionPercent,
          referralCommissionAmountInPaise:
            payoutPayload?.commissionType === 'FIXED_AMOUNT'
              ? Math.round((payoutPayload.commissionAmount ?? 0) * 100)
              : null,
        };
      });

      // Create view for success display
      const visitView: DiagnosticVisitView = {
        visit: {
          id: visit.id,
          branchId: activeBranch.id,
          billNumber: visit.billNumber,
          patientId: patient.id,
          domain: 'DIAGNOSTICS',
          totalAmountInPaise,
          paymentType,
          paymentStatus: 'PAID',
          status: visit.status,
          createdAt: new Date(visit.createdAt),
          updatedAt: new Date(visit.createdAt),
        },
        patient,
        testOrders,
        referralDoctor,
        results: [],
      };

      toast.success('Visit created successfully!');

      // Show WhatsApp notification toast
      const patientPhone = selectedPatient?.identifiers?.find((i: any) => i.type === 'PHONE')?.value || phone;
      const optedIn = showNewPatientForm ? newPatient.whatsappOptIn : whatsappOptIn;
      if (patientPhone && optedIn) {
        // Auto opt-in for existing patient if checked
        if (selectedPatient && !showNewPatientForm && whatsappOptIn) {
          try {
            await fetch(`${API_BASE}/patients/${patient!.id}`, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ whatsappOptIn: true }),
            });
          } catch (_) { /* non-blocking */ }
        }
        setTimeout(() => {
          toast('\ud83d\udcf1 Bill confirmation will be sent via WhatsApp', {
            description: `To ${patientPhone}`,
            duration: 4000,
          });
        }, 500);
      }

      setSuccessData({ visitView });
    } catch (error: any) {
      toast.error(error.message || 'Failed to create visit');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (successData) {
    return (
      <AppLayout context="diagnostics">
        <div className="max-w-2xl mx-auto animate-fade-in">
          <Card className="border-success/30 bg-success/5">
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
                <h2 className="text-2xl font-bold">Visit Created Successfully!</h2>
                
                <div className="bg-card rounded-lg p-4 space-y-2 text-left">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Bill #:</span>
                    <span className="font-mono font-bold">{successData.visitView.visit.billNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Payment Status:</span>
                    <StatusBadge status="PAID" />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Visit Status:</span>
                    <StatusBadge status="RESULTS_PENDING" />
                  </div>
                  {successData.visitView.referralDoctor && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Referred By:</span>
                      <span>{successData.visitView.referralDoctor.name}</span>
                    </div>
                  )}
                </div>

                <div className="flex gap-3 justify-center pt-4">
                  <Button variant="outline" onClick={handlePrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    Print Bill
                  </Button>
                  <Button onClick={() => {
                    setSuccessData(null);
                    setPhone('');
                    setMatchingPatients([]);
                    setSelectedPatient(null);
                    setSelectedProducts([]);
                    setShowNewPatientForm(false);
                    setSelectedDoctorId('');
                    setReferralOverrides({});
                    setDiagnosticCenterOverrides({});
                    setSelectedCenterId('');
                    setReferralType('SELF');
                    setNewPatient({ name: '', age: '', ageUnit: 'YEARS', dateOfBirth: '', gender: 'M', whatsappOptIn: false }); // E2-09: Reset form
                    setValidationErrors({});
                  }}>
                    Create Another Visit
                  </Button>
                  <Button variant="outline" onClick={() => navigate('/diagnostics/pending')}>
                    View Pending Results
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Print Content */}
        <div ref={printRef} className="hidden print:block">
          <BillReceipt data={{
            billNumber: successData.visitView.visit.billNumber,
            date: successData.visitView.visit.createdAt,
            domain: 'DIAGNOSTICS',
            branchName: activeBranch?.name,
            patient: {
              name: successData.visitView.patient.name,
              phone: successData.visitView.patient.identifiers?.find((i: any) => i.type === 'PHONE')?.value || '',
              age: successData.visitView.patient.age,
              ageDisplay: (successData.visitView.patient as any).ageDisplay,
              gender: successData.visitView.patient.gender,
            },
            referralDoctor: successData.visitView.referralDoctor ? {
              name: successData.visitView.referralDoctor.name,
            } : undefined,
            paymentType: successData.visitView.visit.paymentType,
            paymentStatus: successData.visitView.visit.paymentStatus,
            totalAmount: successData.visitView.visit.totalAmountInPaise / 100,
            items: successData.visitView.testOrders.map((order) => ({
              id: order.id,
              name: order.testName,
              price: order.priceInPaise / 100,
              referralType: successData.visitView.referralDoctor ? order.referralCommissionType : undefined,
              referralPercent: successData.visitView.referralDoctor ? order.referralCommissionPercent : undefined,
              referralAmountInPaise: successData.visitView.referralDoctor
                ? order.referralCommissionAmountInPaise ?? undefined
                : undefined,
            })),
          }} />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="diagnostics">
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">New Diagnostic Visit</h1>
          <p className="text-muted-foreground">Register a patient for lab tests and generate a bill.</p>
        </div>

        {/* Patient Lookup */}
        <Card>
          <CardHeader>
            <CardTitle>Patient Lookup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number *</Label>
                <div className="flex gap-2">
                  <Input
                    id="phone"
                    placeholder="Enter 10-digit phone"
                    value={phone}
                    onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    maxLength={10}
                  />
                  <Button onClick={handleSearch} variant="secondary">
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bill">Bill Number (optional)</Label>
                <Input
                  id="bill"
                  placeholder="D-XXXXX"
                  value={billSearch}
                  onChange={(e) => setBillSearch(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Matching Patients */}
        {(matchingPatients.length > 0 || phone.length === 10) && (
          <Card>
            <CardHeader>
              <CardTitle>Matching Patients</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <RadioGroup 
                value={selectedPatient?.id || ''} 
                onValueChange={(id) => {
                  const result = matchingPatients.find((r) => r.patient.id === id);
                  if (result) handleSelectPatient(result);
                }}
              >
                {matchingPatients.map((result) => (
                  <div
                    key={result.patient.id}
                    className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedPatient?.id === result.patient.id 
                        ? 'border-primary bg-accent' 
                        : 'border-border hover:bg-muted'
                    }`}
                    onClick={() => handleSelectPatient(result)}
                  >
                    <RadioGroupItem value={result.patient.id} id={result.patient.id} />
                    <Label htmlFor={result.patient.id} className="flex-1 cursor-pointer">
                      <span className="font-medium">{result.patient.name}</span>
                      <span className="text-muted-foreground ml-2">
                        | {result.patient.ageDisplay || `${result.patient.age} Years`} | {result.patient.gender}
                      </span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>

              <Button
                variant="outline"
                className="w-full"
                onClick={handleCreateNewPatient}
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Create New Patient
              </Button>
            </CardContent>
          </Card>
        )}

        {/* New Patient Form */}
        {showNewPatientForm && (
          <Card>
            <CardHeader>
              <CardTitle>New Patient</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    placeholder="Full name"
                    value={newPatient.name}
                    onChange={(e) => {
                      setNewPatient({ ...newPatient, name: e.target.value });
                      if (validationErrors.name) {
                        setValidationErrors({ ...validationErrors, name: undefined });
                      }
                    }}
                    className={validationErrors.name ? 'border-red-500' : ''}
                  />
                  {validationErrors.name && (
                    <p className="text-sm text-red-500">{validationErrors.name}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dateOfBirth">Date of Birth (Optional)</Label>
                  <Input
                    id="dateOfBirth"
                    type="date"
                    value={newPatient.dateOfBirth}
                    onChange={(e) => {
                      const dob = e.target.value;
                      if (dob) {
                        const smart = computeSmartAge(dob);
                        setNewPatient({ ...newPatient, dateOfBirth: dob, age: smart.age.toString(), ageUnit: smart.unit });
                      } else {
                        setNewPatient({ ...newPatient, dateOfBirth: dob });
                      }
                    }}
                  />
                  <p className="text-xs text-gray-500">If DOB is entered, age will be calculated automatically</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">Age *</Label>
                  <div className="flex gap-2">
                    <Input
                      id="age"
                      type="number"
                      placeholder="Age"
                      value={newPatient.age}
                      onChange={(e) => {
                        setNewPatient({ ...newPatient, age: e.target.value });
                        if (validationErrors.age) {
                          setValidationErrors({ ...validationErrors, age: undefined });
                        }
                      }}
                      className={`flex-1 ${validationErrors.age ? 'border-red-500' : ''}`}
                    />
                    <Select
                      value={newPatient.ageUnit}
                      onValueChange={(v) => setNewPatient({ ...newPatient, ageUnit: v as 'DAYS' | 'MONTHS' | 'YEARS' })}
                    >
                      <SelectTrigger className="w-[110px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DAYS">Days</SelectItem>
                        <SelectItem value="MONTHS">Months</SelectItem>
                        <SelectItem value="YEARS">Years</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {validationErrors.age && (
                    <p className="text-sm text-red-500">{validationErrors.age}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Gender *</Label>
                  <RadioGroup
                    value={newPatient.gender}
                    onValueChange={(v) => {
                      setNewPatient({ ...newPatient, gender: v as 'M' | 'F' | 'O' });
                      if (validationErrors.gender) {
                        setValidationErrors({ ...validationErrors, gender: undefined });
                      }
                    }}
                    className="flex gap-4"
                  >
                    {['M', 'F', 'O'].map((g) => (
                      <div key={g} className="flex items-center space-x-2">
                        <RadioGroupItem value={g} id={`gender-${g}`} />
                        <Label htmlFor={`gender-${g}`}>{g}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                  {validationErrors.gender && (
                    <p className="text-sm text-red-500">{validationErrors.gender}</p>
                  )}
                </div>
              </div>
              
              {/* Phone validation error */}
              {validationErrors.phone && (
                <div className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-md p-3">
                  <strong>Phone:</strong> {validationErrors.phone}
                </div>
              )}

              {/* WhatsApp opt-in */}
              <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
                <Checkbox
                  id="whatsappOptIn"
                  checked={newPatient.whatsappOptIn}
                  onCheckedChange={(checked) =>
                    setNewPatient({ ...newPatient, whatsappOptIn: checked === true })
                  }
                />
                <Label htmlFor="whatsappOptIn" className="flex items-center gap-2 text-sm cursor-pointer">
                  <MessageCircle className="h-4 w-4 text-green-600" />
                  Send reports & bill confirmations via WhatsApp
                </Label>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Select Tests */}
        {(selectedPatient || showNewPatientForm) && (
          <Card>
            <CardHeader>
              <CardTitle>Select Tests</CardTitle>
            </CardHeader>
            <CardContent>
              <ProductSelector
                products={products}
                selectedProductIds={selectedProducts}
                onSelectionChange={(productIds) => {
                  setSelectedProducts(productIds);
                  setReferralOverrides((prev) => {
                    if (!selectedDoctor) {
                      return Object.fromEntries(
                        Object.entries(prev).filter(([productId]) => productIds.includes(productId))
                      );
                    }
                    return buildOverridesForProducts(
                      productIds,
                      (productId) => getEffectiveDoctorPayout(selectedDoctor, productId),
                      prev
                    );
                  });
                  setDiagnosticCenterOverrides((prev) => {
                    if (!selectedCenter) {
                      return Object.fromEntries(
                        Object.entries(prev).filter(([productId]) => productIds.includes(productId))
                      );
                    }
                    return buildOverridesForProducts(
                      productIds,
                      (productId) => getEffectiveDiagnosticCenterPayout(selectedCenter, productId),
                      prev
                    );
                  });
                }}
                disabled={isSubmitting}
              />
            </CardContent>
          </Card>
        )}

        {/* Billing */}
        {selectedProducts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Billing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Referral Doctor */}
              <div className="space-y-3">
                <Label>Referral Doctor (optional)</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <SearchableSelect
                    value={selectedDoctorId}
                    onValueChange={(value) => {
                      setSelectedDoctorId(value);
                      const doctor = referralDoctors.find((item) => item.id === value);
                      setReferralOverrides(
                        buildOverridesForProducts(
                          selectedProducts,
                          (productId) => getEffectiveDoctorPayout(doctor, productId)
                        )
                      );
                    }}
                    options={referralDoctors.map((doctor) => ({
                      value: doctor.id,
                      label: doctor.name,
                      description: [doctor.doctorNumber, doctor.phone].filter(Boolean).join(' · '),
                      keywords: [doctor.name, doctor.doctorNumber, doctor.phone].filter(Boolean).join(' '),
                    }))}
                    placeholder="Search referral doctor"
                    searchPlaceholder="Search by doctor name, phone or number"
                    emptyText="No referral doctors found."
                    className="h-11"
                  />
                  {selectedDoctorId && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSelectedDoctorId('');
                        setReferralOverrides({});
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>

              {diagnosticCenters.length > 0 && (
                <div className="space-y-3">
                  <Label>Diagnostic Referral (optional)</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <SearchableSelect
                      value={selectedCenterId}
                      onValueChange={(value) => {
                        setSelectedCenterId(value);
                        const center = diagnosticCenters.find((item) => item.id === value);
                        setDiagnosticCenterOverrides(
                          buildOverridesForProducts(
                            selectedProducts,
                            (productId) => getEffectiveDiagnosticCenterPayout(center, productId)
                          )
                        );
                      }}
                      options={diagnosticCenters.map((center) => ({
                        value: center.id,
                        label: center.name,
                        description: [center.centerNumber, center.contactPerson, center.phone].filter(Boolean).join(' · '),
                        keywords: [center.name, center.centerNumber, center.contactPerson, center.phone]
                          .filter(Boolean)
                          .join(' '),
                      }))}
                      placeholder="Search external diagnostic center"
                      searchPlaceholder="Search by center name, number, contact or phone"
                      emptyText="No diagnostic centers found."
                      className="h-11"
                    />
                    {selectedCenterId && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setSelectedCenterId('');
                          setDiagnosticCenterOverrides({});
                        }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {selectedDoctorId && selectedProducts.length > 0 && (
                <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <Label className="text-base">Doctor payout by product</Label>
                      <p className="text-sm text-muted-foreground">
                        Saved defaults come from Config Center. Any changes here will be applied to this bill and saved for future bills.
                      </p>
                    </div>
                    {selectedDoctor && (
                      <div className="rounded-lg border bg-background px-3 py-2 text-sm">
                        <p className="text-muted-foreground">Doctor default</p>
                        <p className="font-semibold">
                          {formatReferralPayout(selectedDoctor)}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-3">
                    {selectedProducts.map((productId) => {
                      const product = products.find((p) => p.id === productId);
                      if (!product) return null;
                      const savedPayout = getEffectiveDoctorPayout(selectedDoctor, productId);
                      const draft =
                        referralOverrides[productId] ??
                        toReferralPayoutDraft(savedPayout);
                      return (
                        <div key={productId} className="rounded-lg border bg-background p-4">
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-start">
                            <div className="space-y-1">
                              <p className="font-medium">{product.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {product.code} · Config Center: {formatReferralPayout(savedPayout ?? undefined)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Payout now: {formatReferralPayout({
                                  commissionType: draft.commissionType,
                                  commissionPercent:
                                    draft.commissionType === 'PERCENTAGE'
                                      ? Number(draft.commissionPercent || 0)
                                      : null,
                                  commissionAmountInPaise:
                                    draft.commissionType === 'FIXED_AMOUNT'
                                      ? Math.round(Number(draft.commissionAmount || 0) * 100)
                                      : null,
                                })}
                              </p>
                            </div>

                            <Select
                              value={draft.commissionType}
                              onValueChange={(value) => {
                                setReferralOverrides((prev) => ({
                                  ...prev,
                                  [productId]: {
                                    ...(prev[productId] ?? draft),
                                    commissionType: value as ReferralPayoutDraft['commissionType'],
                                  },
                                }));
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                                <SelectItem value="FIXED_AMOUNT">Amount</SelectItem>
                              </SelectContent>
                            </Select>

                            <div className="space-y-2">
                              <Input
                                type="number"
                                min={0}
                                max={draft.commissionType === 'PERCENTAGE' ? 100 : undefined}
                                step={draft.commissionType === 'PERCENTAGE' ? '0.01' : '1'}
                                placeholder={draft.commissionType === 'PERCENTAGE' ? 'Enter %' : 'Enter amount'}
                                value={
                                  draft.commissionType === 'PERCENTAGE'
                                    ? draft.commissionPercent
                                    : draft.commissionAmount
                                }
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setReferralOverrides((prev) => ({
                                    ...prev,
                                    [productId]: {
                                      ...(prev[productId] ?? draft),
                                      commissionPercent:
                                        draft.commissionType === 'PERCENTAGE'
                                          ? next
                                          : (prev[productId] ?? draft).commissionPercent,
                                      commissionAmount:
                                        draft.commissionType === 'FIXED_AMOUNT'
                                          ? next
                                          : (prev[productId] ?? draft).commissionAmount,
                                    },
                                  }));
                                }}
                              />
                              <p className="text-xs text-muted-foreground">
                                {draft.commissionType === 'PERCENTAGE'
                                  ? 'Enter the doctor share as a percentage of this product.'
                                  : 'Enter the exact rupee amount the doctor should get for this product.'}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedCenterId && selectedProducts.length > 0 && (
                <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <Label className="text-base">External center payout by product</Label>
                      <p className="text-sm text-muted-foreground">
                        Saved defaults come from Config Center. Any changes here will be applied to this bill and saved for future bills.
                      </p>
                    </div>
                    {selectedCenter && (
                      <div className="rounded-lg border bg-background px-3 py-2 text-sm">
                        <p className="text-muted-foreground">Center default</p>
                        <p className="font-semibold">
                          {formatReferralPayout(selectedCenter)}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-3">
                    {selectedProducts.map((productId) => {
                      const product = products.find((p) => p.id === productId);
                      if (!product) return null;
                      const savedPayout = getEffectiveDiagnosticCenterPayout(selectedCenter, productId);
                      const draft =
                        diagnosticCenterOverrides[productId] ??
                        toReferralPayoutDraft(savedPayout);
                      return (
                        <div key={`center-${productId}`} className="rounded-lg border bg-background p-4">
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-start">
                            <div className="space-y-1">
                              <p className="font-medium">{product.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {product.code} · Config Center: {formatReferralPayout(savedPayout ?? undefined)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Payout now: {formatReferralPayout({
                                  commissionType: draft.commissionType,
                                  commissionPercent:
                                    draft.commissionType === 'PERCENTAGE'
                                      ? Number(draft.commissionPercent || 0)
                                      : null,
                                  commissionAmountInPaise:
                                    draft.commissionType === 'FIXED_AMOUNT'
                                      ? Math.round(Number(draft.commissionAmount || 0) * 100)
                                      : null,
                                })}
                              </p>
                            </div>

                            <Select
                              value={draft.commissionType}
                              onValueChange={(value) => {
                                setDiagnosticCenterOverrides((prev) => ({
                                  ...prev,
                                  [productId]: {
                                    ...(prev[productId] ?? draft),
                                    commissionType: value as ReferralPayoutDraft['commissionType'],
                                  },
                                }));
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                                <SelectItem value="FIXED_AMOUNT">Amount</SelectItem>
                              </SelectContent>
                            </Select>

                            <div className="space-y-2">
                              <Input
                                type="number"
                                min={0}
                                max={draft.commissionType === 'PERCENTAGE' ? 100 : undefined}
                                step={draft.commissionType === 'PERCENTAGE' ? '0.01' : '1'}
                                placeholder={draft.commissionType === 'PERCENTAGE' ? 'Enter %' : 'Enter amount'}
                                value={
                                  draft.commissionType === 'PERCENTAGE'
                                    ? draft.commissionPercent
                                    : draft.commissionAmount
                                }
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setDiagnosticCenterOverrides((prev) => ({
                                    ...prev,
                                    [productId]: {
                                      ...(prev[productId] ?? draft),
                                      commissionPercent:
                                        draft.commissionType === 'PERCENTAGE'
                                          ? next
                                          : (prev[productId] ?? draft).commissionPercent,
                                      commissionAmount:
                                        draft.commissionType === 'FIXED_AMOUNT'
                                          ? next
                                          : (prev[productId] ?? draft).commissionAmount,
                                    },
                                  }));
                                }}
                              />
                              <p className="text-xs text-muted-foreground">
                                {draft.commissionType === 'PERCENTAGE'
                                  ? 'Enter the center share as a percentage of this product.'
                                  : 'Enter the exact rupee amount the external center should get for this product.'}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex justify-between items-center p-4 bg-muted rounded-lg">
                <span className="text-lg font-medium">Total Amount</span>
                <span className="text-2xl font-bold">₹{totalAmount.toLocaleString()}</span>
              </div>

              <div className="space-y-2">
                <Label>Payment Type *</Label>
                <RadioGroup
                  value={paymentType}
                  onValueChange={(v) => setPaymentType(v as PaymentType)}
                  className="flex gap-6"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="CASH" id="cash" />
                    <Label htmlFor="cash">Cash</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="ONLINE" id="online" />
                    <Label htmlFor="online">Online</Label>
                  </div>
                </RadioGroup>
              </div>

              {/* WhatsApp opt-in for existing patients */}
              {selectedPatient && !showNewPatientForm && (
                <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
                  <Checkbox
                    id="existingDiagWhatsappOptIn"
                    checked={whatsappOptIn}
                    onCheckedChange={(checked) => setWhatsappOptIn(checked === true)}
                  />
                  <Label htmlFor="existingDiagWhatsappOptIn" className="flex items-center gap-2 text-sm cursor-pointer">
                    <MessageCircle className="h-4 w-4 text-green-600" />
                    Send bill confirmation & reports via WhatsApp
                  </Label>
                </div>
              )}

              <Button 
                className="w-full" 
                size="lg"
                onClick={handleSubmit}
              >
                Generate Bill & Create Visit
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
};

export default DiagnosticsNewVisit;
