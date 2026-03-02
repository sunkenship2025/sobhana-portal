import { useRef, useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from 'sonner';
import type { Patient, PaymentType, VisitType, ClinicVisitView, ClinicDoctor } from '@/types';
import { Search, UserPlus, CheckCircle2, Printer, MessageCircle, RotateCcw } from 'lucide-react';
import { ClinicPrescriptionPrint } from '@/components/print/ClinicPrescriptionPrint';
import { validatePatientForm, type ValidationErrors } from '@/lib/validation';
import { Checkbox } from '@/components/ui/checkbox';

const ClinicNewVisit = () => {
  const navigate = useNavigate();
  const printRef = useRef<HTMLDivElement>(null);
  const { token } = useAuthStore();
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();

  // API data state
  const [clinicDoctors, setClinicDoctors] = useState<ClinicDoctor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [phone, setPhone] = useState('');
  const [matchingPatients, setMatchingPatients] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [visitType, setVisitType] = useState<VisitType>('OP');
  const [selectedDoctorId, setSelectedDoctorId] = useState('');
  const [hospitalWard, setHospitalWard] = useState('');
  const [consultationFee, setConsultationFee] = useState('500');
  const [paymentType, setPaymentType] = useState<PaymentType>('CASH');
  const [successData, setSuccessData] = useState<{ visitView: ClinicVisitView } | null>(null);

  // Revisit detection state
  const [revisitInfo, setRevisitInfo] = useState<{
    isRevisit: boolean;
    originalVisitId: string;
    originalBillNumber: string;
    originalDate: string;
    doctorName: string;
  } | null>(null);
  const [checkingRevisit, setCheckingRevisit] = useState(false);

  // New patient form
  const [newPatient, setNewPatient] = useState({
    name: '',
    age: '',
    dateOfBirth: '', // E2-09: Optional DOB field
    gender: 'M' as 'M' | 'F' | 'O',
    whatsappOptIn: true, // Default: opted in for WhatsApp notifications
  });
  const [whatsappOptIn, setWhatsappOptIn] = useState(true); // For existing patients
  
  // E2-10: Validation errors
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  // Fetch clinic doctors from API
  useEffect(() => {
    const fetchDoctors = async () => {
      if (!token || !activeBranch) return;
      
      try {
        const res = await fetch(`${API_BASE}/clinic-doctors`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranch.id,
          },
        });

        if (res.ok) {
          const doctors = await res.json();
          setClinicDoctors(doctors);
        }
      } catch (error) {
        console.error('Failed to fetch doctors:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDoctors();
  }, [token, activeBranch]);

  // Check revisit eligibility when patient + doctor are selected
  useEffect(() => {
    const checkRevisit = async () => {
      const patientId = selectedPatient?.id;
      if (!patientId || !selectedDoctorId || !token || !activeBranch) {
        setRevisitInfo(null);
        return;
      }

      setCheckingRevisit(true);
      try {
        const res = await fetch(
          `${API_BASE}/visits/clinic/check-revisit?patientId=${patientId}&doctorId=${selectedDoctorId}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranch.id,
            },
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.isRevisit) {
            setRevisitInfo(data);
            setConsultationFee('0'); // Auto-set fee to ₹0
          } else {
            setRevisitInfo(null);
          }
        }
      } catch (error) {
        console.error('Failed to check revisit:', error);
      } finally {
        setCheckingRevisit(false);
      }
    };

    checkRevisit();
  }, [selectedPatient?.id, selectedDoctorId, token, activeBranch]);

  // Search patients via API
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
          // Backend returns { patient: {...}, historySnapshot: [...] }
          // Extract just the patient objects
          const patients = results.map((r: any) => r.patient);
          setMatchingPatients(patients);
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

  const handleSelectPatient = (patient: Patient) => {
    setSelectedPatient(patient);
    setShowNewPatientForm(false);
    // Auto-check WhatsApp opt-in if patient already opted in
    setWhatsappOptIn((patient as any).whatsappOptIn ?? true);
  };

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
            `Age: ${existing.age}, Gender: ${existing.gender}\n` +
            `Phone: ${existing.phone}\n\n` +
            `This looks like the same person. Do you want to:\n` +
            `• Click OK to USE EXISTING patient\n` +
            `• Click Cancel to CREATE NEW patient anyway`
          );
          
          if (userConfirm) {
            // Use existing patient
            patient = { id: existing.id, patientNumber: existing.patientNumber, name: existing.name, age: existing.age, gender: existing.gender };
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
                dateOfBirth: newPatient.dateOfBirth || undefined, // E2-09: DOB if provided
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

    if (!selectedDoctorId) {
      toast.error('Please select a doctor');
      return;
    }

    const clinicDoctor = clinicDoctors.find(d => d.id === selectedDoctorId);
    if (!clinicDoctor) {
      toast.error('Selected doctor not found');
      return;
    }

    setIsSubmitting(true);

    try {
      // Create clinic visit via API
      const res = await fetch(`${API_BASE}/visits/clinic`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranch.id,
        },
        body: JSON.stringify({
          patientId: patient.id,
          doctorId: selectedDoctorId,
          visitType,
          hospitalWard: visitType === 'IP' ? hospitalWard : null,
          consultationFee: revisitInfo?.isRevisit ? 0 : parseInt(consultationFee),
          paymentType,
          paymentStatus: 'PAID',
          isRevisit: revisitInfo?.isRevisit || false,
          originalVisitId: revisitInfo?.originalVisitId || null,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || 'Failed to create visit');
      }

      const visit = await res.json();

      const visitView: ClinicVisitView = {
        visit: {
          id: visit.id,
          branchId: activeBranch.id,
          billNumber: visit.billNumber,
          patientId: patient.id,
          domain: 'CLINIC',
          visitType,
          doctorId: selectedDoctorId,
          hospitalWard: visitType === 'IP' ? hospitalWard : undefined,
          totalAmountInPaise: revisitInfo?.isRevisit ? 0 : Math.round(parseInt(consultationFee) * 100),
          consultationFeeInPaise: revisitInfo?.isRevisit ? 0 : Math.round(parseInt(consultationFee) * 100),
          paymentType,
          paymentStatus: 'PAID',
          status: 'WAITING',
          isRevisit: revisitInfo?.isRevisit || false,
          originalVisitId: revisitInfo?.originalVisitId || undefined,
          createdAt: new Date(visit.createdAt),
          updatedAt: new Date(visit.createdAt),
        },
        patient,
        clinicDoctor,
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
          toast('📱 Bill confirmation will be sent via WhatsApp', {
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
      <AppLayout context="clinic" subContext="Reception">
        <div className="max-w-2xl mx-auto animate-fade-in">
          <Card className="border-success/30 bg-success/5">
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
                <h2 className="text-2xl font-bold">Visit Created Successfully!</h2>
                                {successData.visitView.visit.isRevisit && (
                  <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-800 rounded-full px-4 py-1.5 text-sm font-medium">
                    <RotateCcw className="h-4 w-4" />
                    Revisit — Free Consultation
                  </div>
                )}
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
                    <span className="text-muted-foreground">Doctor:</span>
                    <span>{successData.visitView.clinicDoctor?.name}</span>
                  </div>
                </div>

                <div className="flex gap-3 justify-center pt-4">
                  <Button variant="outline" onClick={handlePrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    Print Prescription & Bill
                  </Button>
                  <Button onClick={() => {
                    setSuccessData(null);
                    setPhone('');
                    setMatchingPatients([]);
                    setSelectedPatient(null);
                    setSelectedDoctorId('');
                    setHospitalWard('');
                    setShowNewPatientForm(false);
                    setConsultationFee('500');
                    setRevisitInfo(null);
                    setNewPatient({ name: '', age: '', dateOfBirth: '', gender: 'M', whatsappOptIn: true }); // E2-09: Reset form
                    setValidationErrors({});
                    setWhatsappOptIn(true);
                  }}>
                    Create Another Visit
                  </Button>
                  <Button variant="outline" onClick={() => navigate('/clinic/queue')}>
                    View Queue
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Print Content */}
        <div ref={printRef} className="hidden print:block">
          <ClinicPrescriptionPrint visitView={successData.visitView} />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="clinic" subContext="Reception">
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">New Clinic Visit</h1>
          <p className="text-muted-foreground">Register a clinic visit and generate a bill.</p>
        </div>

        {/* Patient Lookup */}
        <Card>
          <CardHeader>
            <CardTitle>Patient Lookup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number *</Label>
              <div className="flex gap-2">
                <Input
                  id="phone"
                  placeholder="Enter 10-digit phone"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  maxLength={10}
                  className="max-w-sm"
                />
                <Button variant="secondary">
                  <Search className="h-4 w-4" />
                </Button>
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
                  const patient = matchingPatients.find((p) => p.id === id);
                  if (patient) handleSelectPatient(patient);
                }}
              >
                {matchingPatients.map((patient) => (
                  <div
                    key={patient.id}
                    className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedPatient?.id === patient.id 
                        ? 'border-primary bg-accent' 
                        : 'border-border hover:bg-muted'
                    }`}
                    onClick={() => handleSelectPatient(patient)}
                  >
                    <RadioGroupItem value={patient.id} id={patient.id} />
                    <Label htmlFor={patient.id} className="flex-1 cursor-pointer">
                      <span className="font-medium">{patient.name}</span>
                      <span className="text-muted-foreground ml-2">
                        | {patient.age} | {patient.gender}
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
                      // Clear error when user types
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
                      setNewPatient({ ...newPatient, dateOfBirth: dob });
                      
                      // E2-09: Auto-calculate age from DOB
                      if (dob) {
                        const dobDate = new Date(dob);
                        const today = new Date();
                        let calculatedAge = today.getFullYear() - dobDate.getFullYear();
                        const monthDiff = today.getMonth() - dobDate.getMonth();
                        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
                          calculatedAge--;
                        }
                        setNewPatient({ ...newPatient, dateOfBirth: dob, age: calculatedAge.toString() });
                      }
                    }}
                  />
                  <p className="text-xs text-gray-500">If DOB is entered, age will be calculated automatically</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">Age *</Label>
                  <Input
                    id="age"
                    type="number"
                    placeholder="Age"
                    value={newPatient.age}
                    onChange={(e) => {
                      setNewPatient({ ...newPatient, age: e.target.value });
                      // Clear error when user types
                      if (validationErrors.age) {
                        setValidationErrors({ ...validationErrors, age: undefined });
                      }
                    }}
                    className={validationErrors.age ? 'border-red-500' : ''}
                  />
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
                      // Clear error when user selects
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
                  id="clinicWhatsappOptIn"
                  checked={newPatient.whatsappOptIn}
                  onCheckedChange={(checked) =>
                    setNewPatient({ ...newPatient, whatsappOptIn: checked === true })
                  }
                />
                <Label htmlFor="clinicWhatsappOptIn" className="flex items-center gap-2 text-sm cursor-pointer">
                  <MessageCircle className="h-4 w-4 text-green-600" />
                  Send reports & bill confirmations via WhatsApp
                </Label>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Visit Details */}
        {(selectedPatient || showNewPatientForm) && (
          <Card>
            <CardHeader>
              <CardTitle>Visit Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Visit Type *</Label>
                <RadioGroup
                  value={visitType}
                  onValueChange={(v) => setVisitType(v as VisitType)}
                  className="flex gap-6"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="OP" id="op" />
                    <Label htmlFor="op">OP (Outpatient)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="IP" id="ip" />
                    <Label htmlFor="ip">IP (Inpatient)</Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label>Doctor *</Label>
                <Select value={selectedDoctorId} onValueChange={setSelectedDoctorId}>
                  <SelectTrigger className="max-w-sm">
                    <SelectValue placeholder="Select consulting doctor" />
                  </SelectTrigger>
                  <SelectContent>
                    {clinicDoctors.map((doctor) => (
                      <SelectItem key={doctor.id} value={doctor.id}>
                        {doctor.name} — {doctor.specialty}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {visitType === 'IP' && (
                <div className="space-y-2">
                  <Label htmlFor="ward">Hospital/Ward (optional)</Label>
                  <Input
                    id="ward"
                    placeholder="e.g., Ward B - Room 204"
                    value={hospitalWard}
                    onChange={(e) => setHospitalWard(e.target.value)}
                    className="max-w-sm"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Billing */}
        {(selectedPatient || showNewPatientForm) && selectedDoctorId && (
          <Card>
            <CardHeader>
              <CardTitle>Billing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Revisit Banner */}
              {revisitInfo?.isRevisit && (
                <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <RotateCcw className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-blue-900">Revisit Detected — Free Consultation</p>
                    <p className="text-sm text-blue-700 mt-1">
                      This patient visited <strong>{revisitInfo.doctorName}</strong> on{' '}
                      <strong>{new Date(revisitInfo.originalDate).toLocaleDateString('en-IN')}</strong>{' '}
                      (Bill #{revisitInfo.originalBillNumber}). Follow-up within 7 days — consultation fee waived.
                    </p>
                  </div>
                </div>
              )}

              {checkingRevisit && (
                <p className="text-sm text-muted-foreground animate-pulse">Checking revisit eligibility...</p>
              )}

              <div className="space-y-2">
                <Label htmlFor="fee">Consultation Fee</Label>
                <div className="flex items-center gap-2 max-w-sm">
                  <span className="text-muted-foreground">₹</span>
                  <Input
                    id="fee"
                    type="number"
                    value={revisitInfo?.isRevisit ? '0' : consultationFee}
                    onChange={(e) => setConsultationFee(e.target.value)}
                    disabled={revisitInfo?.isRevisit}
                    className={revisitInfo?.isRevisit ? 'bg-blue-50 text-blue-700 font-bold' : ''}
                  />
                  {revisitInfo?.isRevisit && (
                    <span className="text-sm text-blue-600 font-medium whitespace-nowrap">Revisit — Free</span>
                  )}
                </div>
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
                    id="existingPatientWhatsappOptIn"
                    checked={whatsappOptIn}
                    onCheckedChange={(checked) => setWhatsappOptIn(checked === true)}
                  />
                  <Label htmlFor="existingPatientWhatsappOptIn" className="flex items-center gap-2 text-sm cursor-pointer">
                    <MessageCircle className="h-4 w-4 text-green-600" />
                    Send bill confirmation via WhatsApp
                  </Label>
                </div>
              )}

              <Button 
                className="w-full" 
                size="lg"
                onClick={handleSubmit}
              >
                Generate Clinic Bill
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
};

export default ClinicNewVisit;
