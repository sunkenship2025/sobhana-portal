import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from 'sonner';
import type { Patient, PatientSearchResult, PaymentType, DiagnosticVisitView, TestOrder, LabTest, ReferralDoctor } from '@/types';
import { Search, UserPlus, CheckCircle2, Printer } from 'lucide-react';
import { BillPrint } from '@/components/print/BillPrint';
import { validatePatientForm, type ValidationErrors } from '@/lib/validation';
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
  const [labTests, setLabTests] = useState<LabTest[]>([]);
  const [referralDoctors, setReferralDoctors] = useState<ReferralDoctor[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [phone, setPhone] = useState('');
  const [billSearch, setBillSearch] = useState('');
  const [matchingPatients, setMatchingPatients] = useState<PatientSearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [paymentType, setPaymentType] = useState<PaymentType>('CASH');
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
  const [referralOverrides, setReferralOverrides] = useState<Record<string, string>>({});
  const [successData, setSuccessData] = useState<{ visitView: DiagnosticVisitView } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New patient form
  const [newPatient, setNewPatient] = useState({
    name: '',
    age: '',
    gender: 'M' as 'M' | 'F' | 'O',
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

        const [testsRes, doctorsRes] = await Promise.all([
          fetch('http://localhost:3000/api/lab-tests', { headers }),
          fetch('http://localhost:3000/api/referral-doctors', { headers }),
        ]);

        if (testsRes.ok) {
          const tests = await testsRes.json();
          setLabTests(tests);
        }
        if (doctorsRes.ok) {
          const doctors = await doctorsRes.json();
          setReferralDoctors(doctors);
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [token, activeBranch]);

  // Search patients via API
  const handleSearch = async () => {
    if (phone.length >= 10 && token && activeBranch) {
      try {
        const res = await fetch(`http://localhost:3000/api/patients/search?phone=${phone}`, {
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
        const res = await fetch(`http://localhost:3000/api/patients/search?phone=${value}`, {
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

  const handleSelectPatient = (result: PatientSearchResult) => {
    setSelectedPatient(result.patient);
    setShowNewPatientForm(false);
  };

  const handleTestToggle = (testId: string) => {
    setSelectedTests((prev) => {
      const next = prev.includes(testId)
        ? prev.filter((id) => id !== testId)
        : [...prev, testId];

      if (!next.includes(testId)) {
        const { [testId]: _removed, ...rest } = referralOverrides;
        setReferralOverrides(rest);
      }

      return next;
    });
  };

  const totalAmount = selectedTests.reduce((sum, testId) => {
    const test = labTests.find((t) => t.id === testId);
    return sum + (test?.priceInPaise ? test.priceInPaise / 100 : 0);
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
      });

      if (Object.keys(errors).length > 0) {
        setValidationErrors(errors);
        toast.error('Please fix validation errors before submitting');
        return;
      }

      if (!newPatient.name || !newPatient.age) {
        toast.error('Please fill in all patient details');
        return;
      }
      
      try {
        const res = await fetch('http://localhost:3000/api/patients', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Branch-Id': activeBranch.id,
          },
          body: JSON.stringify({
            name: newPatient.name,
            age: parseInt(newPatient.age),
            gender: newPatient.gender,
            identifiers: [{ type: 'PHONE', value: phone, isPrimary: true }],
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
            const retryRes = await fetch('http://localhost:3000/api/patients', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Branch-Id': activeBranch.id,
              },
              body: JSON.stringify({
                name: newPatient.name,
                age: parseInt(newPatient.age),
                gender: newPatient.gender,
                identifiers: [{ type: 'PHONE', value: phone, isPrimary: true }],
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

    if (selectedTests.length === 0) {
      toast.error('Please select at least one test');
      return;
    }

    setIsSubmitting(true);

    try {
      // Create diagnostic visit via API
      const res = await fetch('http://localhost:3000/api/visits/diagnostic', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranch.id,
        },
        body: JSON.stringify({
          patientId: patient.id,
          referralDoctorId: selectedDoctorId || null,
          testIds: selectedTests,
          paymentType,
          paymentStatus: 'PAID',
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || 'Failed to create visit');
      }

      const visit = await res.json();
      const referralDoctor = selectedDoctorId 
        ? referralDoctors.find(d => d.id === selectedDoctorId) 
        : undefined;

      // Calculate total amount in paise from selected tests
      const totalAmountInPaise = selectedTests.reduce((sum, testId) => {
        const test = labTests.find((t) => t.id === testId)!;
        return sum + test.priceInPaise;
      }, 0);

      // Create test orders for display
      const testOrders: TestOrder[] = selectedTests.map((testId, index) => {
        const test = labTests.find((t) => t.id === testId)!;
        return {
          id: `${visit.id}-to-${index}`,
          visitId: visit.id,
          testId: test.id,
          testName: test.name,
          testCode: test.code,
          priceInPaise: test.priceInPaise,
          referenceRange: test.referenceRange,
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
                    setSelectedTests([]);
                    setShowNewPatientForm(false);
                    setSelectedDoctorId('');
                    setReferralOverrides({});
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
          <BillPrint visitView={successData.visitView} />
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
                        | {result.patient.age} | {result.patient.gender}
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
                  <Label htmlFor="age">Age *</Label>
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
              <div className="grid gap-3 md:grid-cols-2">
                {labTests.map((test) => (
                  <div
                    key={test.id}
                    className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedTests.includes(test.id) 
                        ? 'border-primary bg-accent' 
                        : 'border-border hover:bg-muted'
                    }`}
                    onClick={() => handleTestToggle(test.id)}
                  >
                    <Checkbox
                      checked={selectedTests.includes(test.id)}
                      onCheckedChange={() => handleTestToggle(test.id)}
                    />
                    <div className="flex-1">
                      <p className="font-medium">{test.name}</p>
                      <p className="text-sm text-muted-foreground">₹{test.priceInPaise ? (test.priceInPaise / 100).toFixed(2) : '0.00'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Billing */}
        {selectedTests.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Billing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Referral Doctor */}
              <div className="space-y-2">
                <Label>Referral Doctor (optional)</Label>
                <Select
                  value={selectedDoctorId}
                  onValueChange={(value) => {
                    setSelectedDoctorId(value);
                    const doctor = referralDoctors.find(d => d.id === value);
                    if (doctor) {
                      const nextOverrides: Record<string, string> = {};
                      selectedTests.forEach((testId) => {
                        nextOverrides[testId] = doctor.commissionPercent.toString();
                      });
                      setReferralOverrides(nextOverrides);
                    } else {
                      setReferralOverrides({});
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select referral doctor" />
                  </SelectTrigger>
                  <SelectContent>
                    {referralDoctors.map((doctor) => (
                      <SelectItem key={doctor.id} value={doctor.id}>
                        {doctor.name} ({doctor.commissionPercent}%)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedDoctorId && selectedTests.length > 0 && (
                <div className="space-y-3">
                  <Label>Per-test referral % (optional override)</Label>
                  <div className="grid gap-2">
                    {selectedTests.map((testId) => {
                      const test = labTests.find((t) => t.id === testId);
                      if (!test) return null;
                      const value = referralOverrides[testId] ?? '';
                      const baseDoctor = referralDoctors.find(d => d.id === selectedDoctorId);
                      const base = baseDoctor?.commissionPercent ?? 0;
                      return (
                        <div key={testId} className="flex items-center gap-3">
                          <div className="flex-1">
                            <p className="font-medium">{test.name}</p>
                            <p className="text-sm text-muted-foreground">Base: {base}%</p>
                          </div>
                          <Input
                            className="w-28"
                            type="number"
                            min={0}
                            max={100}
                            placeholder="%"
                            value={value}
                            onChange={(e) => {
                              const next = e.target.value;
                              setReferralOverrides((prev) => ({ ...prev, [testId]: next }));
                            }}
                          />
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
