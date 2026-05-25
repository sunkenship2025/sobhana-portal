import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  MessageCircle,
  Printer,
  RotateCcw,
  Search,
  UserPlus,
} from "lucide-react";
import { API_BASE } from "@/lib/api";
import { ClinicPrescriptionPrint } from "@/components/print/ClinicPrescriptionPrint";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  computeSmartAge,
  type ValidationErrors,
  validatePatientForm,
} from "@/lib/validation";
import { TITLE_TO_GENDER, titleOptions, formatPatientName } from "@/lib/patientDisplay";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { toast } from "sonner";
import type {
  ClinicDoctor,
  ClinicRevisitContext,
  ClinicRevisitDecision,
  ClinicRevisitMode,
  ClinicVisitView,
  Patient,
  PaymentType,
  VisitType,
} from "@/types";

const DEFAULT_CONSULTATION_FEE = "500";

function deriveRevisitDecision(
  revisitContext: ClinicRevisitContext | null,
  selectedMode: ClinicRevisitMode,
): ClinicRevisitDecision {
  if (!revisitContext?.anchorVisit) {
    return "AUTO";
  }

  if (selectedMode === "REVISIT") {
    return revisitContext.defaultMode === "REVISIT" ? "AUTO" : "FORCE_REVISIT";
  }

  return revisitContext.defaultMode === "REVISIT" ? "FORCE_NORMAL" : "AUTO";
}

function buildClinicVisitView(apiVisit: any): ClinicVisitView {
  return {
    visit: {
      id: apiVisit.id,
      branchId: apiVisit.branchId,
      visitRef: apiVisit.visitRef,
      billNumber: apiVisit.billNumber ?? null,
      patientId: apiVisit.patientId,
      domain: "CLINIC",
      visitType: apiVisit.visitType,
      doctorId: apiVisit.doctorId,
      hospitalWard: apiVisit.hospitalWard || undefined,
      totalAmountInPaise: Math.round((apiVisit.totalAmount || 0) * 100),
      consultationFeeInPaise: Math.round((apiVisit.consultationFee || 0) * 100),
      paymentType: apiVisit.paymentType ?? null,
      paymentStatus: apiVisit.paymentStatus ?? null,
      hasBill: apiVisit.hasBill,
      billedAt: apiVisit.billedAt ? new Date(apiVisit.billedAt) : null,
      status: apiVisit.status,
      isRevisit: apiVisit.isRevisit || false,
      originalVisitId: apiVisit.originalVisitId || undefined,
      originalVisitVisitRef: apiVisit.originalVisitVisitRef || null,
      originalVisitBillNumber: apiVisit.originalVisitBillNumber || null,
      originalVisitDate: apiVisit.originalVisitDate
        ? new Date(apiVisit.originalVisitDate)
        : null,
      createdAt: new Date(apiVisit.createdAt),
      updatedAt: new Date(apiVisit.updatedAt),
    },
    patient: apiVisit.patient,
    clinicDoctor: apiVisit.doctor || undefined,
  };
}

const ClinicNewVisit = () => {
  const navigate = useNavigate();
  const printRef = useRef<HTMLDivElement>(null);
  const { token } = useAuthStore();
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();

  const [clinicDoctors, setClinicDoctors] = useState<ClinicDoctor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [billLogoLoaded, setBillLogoLoaded] = useState(false);

  const [phone, setPhone] = useState("");
  const [matchingPatients, setMatchingPatients] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [visitType, setVisitType] = useState<VisitType>("OP");
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [hospitalWard, setHospitalWard] = useState("");
  const [consultationFee, setConsultationFee] = useState(
    DEFAULT_CONSULTATION_FEE,
  );
  const [paymentMode, setPaymentMode] = useState<"CASH" | "ONLINE" | "SPLIT">(
    "CASH",
  );
  const [splitAmounts, setSplitAmounts] = useState({ cash: 0, online: 0 });
  const [successData, setSuccessData] = useState<{
    visitView: ClinicVisitView;
  } | null>(null);

  const [revisitContext, setRevisitContext] =
    useState<ClinicRevisitContext | null>(null);
  const [selectedRevisitMode, setSelectedRevisitMode] =
    useState<ClinicRevisitMode>("VISIT");
  const [checkingRevisit, setCheckingRevisit] = useState(false);

  const [newPatient, setNewPatient] = useState({
    name: "",
    title: "" as string,
    age: "",
    ageUnit: "YEARS" as "DAYS" | "MONTHS" | "YEARS",
    dateOfBirth: "",
    gender: "M" as "M" | "F" | "O",
    whatsappOptIn: true,
  });
  const [whatsappOptIn, setWhatsappOptIn] = useState(true);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>(
    {},
  );

  const activeAnchorVisit = revisitContext?.anchorVisit || null;
  const isRevisitSelected =
    Boolean(activeAnchorVisit && revisitContext?.canForceRevisit) &&
    selectedRevisitMode === "REVISIT";

  useEffect(() => {
    const fetchDoctors = async () => {
      if (!token || !activeBranch) return;

      try {
        const res = await fetch(`${API_BASE}/clinic-doctors`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Branch-Id": activeBranch.id,
          },
        });

        if (res.ok) {
          const doctors = await res.json();
          setClinicDoctors(doctors);
        }
      } catch (error) {
        console.error("Failed to fetch doctors:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDoctors();
  }, [token, activeBranch]);

  useEffect(() => {
    let cancelled = false;

    const loadRevisitContext = async () => {
      const patientId = selectedPatient?.id;
      if (!patientId || !selectedDoctorId || !token || !activeBranch) {
        setRevisitContext(null);
        setSelectedRevisitMode("VISIT");
        setCheckingRevisit(false);
        return;
      }

      setCheckingRevisit(true);

      try {
        const res = await fetch(
          `${API_BASE}/visits/clinic/revisit-context?patientId=${patientId}&doctorId=${selectedDoctorId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Branch-Id": activeBranch.id,
            },
          },
        );

        if (!cancelled) {
          if (res.ok) {
            const data = await res.json();
            setRevisitContext(data);
            setSelectedRevisitMode(data.defaultMode);
          } else {
            setRevisitContext(null);
            setSelectedRevisitMode("VISIT");
          }
        }
      } catch (error) {
        console.error("Failed to load revisit context:", error);
        if (!cancelled) {
          setRevisitContext(null);
          setSelectedRevisitMode("VISIT");
        }
      } finally {
        if (!cancelled) {
          setCheckingRevisit(false);
        }
      }
    };

    loadRevisitContext();

    return () => {
      cancelled = true;
    };
  }, [selectedPatient?.id, selectedDoctorId, token, activeBranch]);

  const handlePhoneChange = async (value: string) => {
    setPhone(value);
    if (value.length === 10 && token && activeBranch) {
      try {
        const res = await fetch(`${API_BASE}/patients/search?phone=${value}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Branch-Id": activeBranch.id,
          },
        });
        if (res.ok) {
          const results = await res.json();
          const patients = results.map((result: any) => result.patient);
          setMatchingPatients(patients);
        }
      } catch (error) {
        console.error("Search failed:", error);
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
    setWhatsappOptIn((patient as any).whatsappOptIn ?? true);
  };

  const resetForm = () => {
    setSuccessData(null);
    setPhone("");
    setMatchingPatients([]);
    setSelectedPatient(null);
    setSelectedDoctorId("");
    setHospitalWard("");
    setShowNewPatientForm(false);
    setConsultationFee(DEFAULT_CONSULTATION_FEE);
    setRevisitContext(null);
    setSelectedRevisitMode("VISIT");
    setPaymentMode("CASH");
    setSplitAmounts({ cash: 0, online: 0 });
    setNewPatient({
      name: "",
      age: "",
      ageUnit: "YEARS",
      dateOfBirth: "",
      gender: "M",
      whatsappOptIn: true,
    });
    setValidationErrors({});
    setWhatsappOptIn(true);
  };

  const handleSubmit = async () => {
    if (!token || !activeBranch) {
      toast.error("Not authenticated");
      return;
    }

    let patient = selectedPatient;

    if (showNewPatientForm && !selectedPatient) {
      const errors = validatePatientForm({
        name: newPatient.name,
        title: newPatient.title,
        age: newPatient.age,
        gender: newPatient.gender,
        phone,
        ageUnit: newPatient.ageUnit,
      });

      if (Object.keys(errors).length > 0) {
        setValidationErrors(errors);
        toast.error("Please fix validation errors before submitting");
        return;
      }

      if (!newPatient.name || (!newPatient.age && !newPatient.dateOfBirth)) {
        toast.error("Please fill in all patient details");
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/patients`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Branch-Id": activeBranch.id,
          },
          body: JSON.stringify({
            name: newPatient.name,
            title: newPatient.title || undefined,
            age: newPatient.age ? parseInt(newPatient.age, 10) : undefined,
            ageUnit: newPatient.ageUnit,
            dateOfBirth: newPatient.dateOfBirth
              ? newPatient.dateOfBirth.split("T")[0]
              : undefined,
            gender: newPatient.gender,
            identifiers: [{ type: "PHONE", value: phone, isPrimary: true }],
            whatsappOptIn: newPatient.whatsappOptIn,
          }),
        });

        if (res.status === 409) {
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
              `• Click Cancel to CREATE NEW patient anyway`,
          );

          if (userConfirm) {
            patient = {
              id: existing.id,
              patientNumber: existing.patientNumber,
              name: existing.name,
              age: existing.age,
              gender: existing.gender,
            } as Patient;
            toast.success(`Using existing patient ${existing.patientNumber}`);
          } else {
            const retryRes = await fetch(`${API_BASE}/patients`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "X-Branch-Id": activeBranch.id,
              },
              body: JSON.stringify({
                name: newPatient.name,
                title: newPatient.title || undefined,
                age: newPatient.age ? parseInt(newPatient.age, 10) : undefined,
                ageUnit: newPatient.ageUnit,
                dateOfBirth: newPatient.dateOfBirth || undefined,
                gender: newPatient.gender,
                identifiers: [{ type: "PHONE", value: phone, isPrimary: true }],
                whatsappOptIn: newPatient.whatsappOptIn,
                forceDuplicate: true,
              }),
            });

            if (!retryRes.ok) {
              throw new Error("Failed to create patient");
            }

            patient = await retryRes.json();
            toast.success("Created new patient record");
          }
        } else if (!res.ok) {
          throw new Error("Failed to create patient");
        } else {
          patient = await res.json();
        }
      } catch (error) {
        toast.error("Failed to create patient");
        return;
      }
    }

    if (!patient) {
      toast.error("Please select or create a patient");
      return;
    }

    if (!selectedDoctorId) {
      toast.error("Please select a doctor");
      return;
    }

    if (!consultationFee.trim()) {
      toast.error("Please enter a consultation fee");
      return;
    }

    const parsedConsultationFee = parseInt(consultationFee, 10);
    if (Number.isNaN(parsedConsultationFee) || parsedConsultationFee < 0) {
      toast.error("Consultation fee must be a valid non-negative number");
      return;
    }

    setIsSubmitting(true);

    try {
      const sendBillConfirmation =
        !isRevisitSelected &&
        (showNewPatientForm ? newPatient.whatsappOptIn : whatsappOptIn);

      const res = await fetch(`${API_BASE}/visits/clinic`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Branch-Id": activeBranch.id,
        },
        body: JSON.stringify({
          patientId: patient.id,
          doctorId: selectedDoctorId,
          visitType,
          hospitalWard: visitType === "IP" ? hospitalWard : null,
          consultationFee: parsedConsultationFee,
          revisitDecision: deriveRevisitDecision(
            revisitContext,
            selectedRevisitMode,
          ),
          ...(isRevisitSelected
            ? {}
            : {
                ...(paymentMode === "SPLIT"
                  ? {
                      paymentType: "SPLIT", // frontend dummy value, backend will pick from payments
                      payments: [
                        { type: "CASH", amount: splitAmounts.cash },
                        { type: "ONLINE", amount: splitAmounts.online },
                      ],
                    }
                  : {
                      paymentType: paymentMode,
                      payments: [
                        { type: paymentMode, amount: parsedConsultationFee },
                      ],
                    }),
                paymentStatus: "PAID",
              }),
          sendWhatsApp: sendBillConfirmation,
        }),
      });

      const visit = await res.json();

      if (!res.ok) {
        throw new Error(visit.message || "Failed to create visit");
      }

      const visitView = buildClinicVisitView(visit);
      toast.success("Visit created successfully!");
      setBillLogoLoaded(false);

      const patientPhone =
        visitView.patient.identifiers?.find(
          (identifier: any) => identifier.type === "PHONE",
        )?.value || phone;
      const optedIn = showNewPatientForm
        ? newPatient.whatsappOptIn
        : whatsappOptIn;

      if (visitView.visit.hasBill && patientPhone && optedIn) {
        if (selectedPatient && !showNewPatientForm && whatsappOptIn) {
          try {
            await fetch(`${API_BASE}/patients/${patient.id}`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ whatsappOptIn: true }),
            });
          } catch (_) {
            // Non-blocking update only.
          }
        }

        setTimeout(() => {
          toast("📱 Bill confirmation will be sent via WhatsApp", {
            description: `To ${patientPhone}`,
            duration: 4000,
          });
        }, 500);
      }

      setSuccessData({ visitView });
    } catch (error: any) {
      toast.error(error.message || "Failed to create visit");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (successData) {
    const { visitView } = successData;
    const printLabel = visitView.visit.hasBill
      ? "Print Prescription & Bill"
      : "Print Prescription & Visit Slip";

    return (
      <AppLayout context="clinic" subContext="Reception">
        <div className="max-w-2xl mx-auto animate-fade-in print:hidden">
          <Card className="border-success/30 bg-success/5">
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
                <h2 className="text-2xl font-bold">
                  Visit Created Successfully!
                </h2>
                {visitView.visit.isRevisit && (
                  <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-800 rounded-full px-4 py-1.5 text-sm font-medium">
                    <RotateCcw className="h-4 w-4" />
                    Revisit — No New Bill
                  </div>
                )}
                <div className="bg-card rounded-lg p-4 space-y-2 text-left">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">Visit Ref:</span>
                    <span className="font-mono font-bold">
                      {visitView.visit.visitRef || "—"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">Bill #:</span>
                    <span className="font-mono font-bold">
                      {visitView.visit.billNumber || "No new bill"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">
                      Payment Status:
                    </span>
                    {visitView.visit.hasBill &&
                    visitView.visit.paymentStatus ? (
                      <StatusBadge status={visitView.visit.paymentStatus} />
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        Not billed
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">Doctor:</span>
                    <span>{visitView.clinicDoctor?.name}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:justify-center">
                  <Button
                    className="w-full sm:w-auto"
                    variant="outline"
                    onClick={handlePrint}
                    disabled={!billLogoLoaded}
                  >
                    <Printer className="mr-2 h-4 w-4" />
                    {billLogoLoaded ? printLabel : "Preparing Print..."}
                  </Button>

                  <Button className="w-full sm:w-auto" onClick={resetForm}>
                    Create Another Visit
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    variant="outline"
                    onClick={() => navigate("/clinic/queue")}
                  >
                    View Queue
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div ref={printRef} className="hidden print:block">
          <ClinicPrescriptionPrint
            visitView={visitView}
            branchName={activeBranch?.name}
            onBillLogoLoadedChange={setBillLogoLoaded}
          />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="clinic" subContext="Reception">
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">New Clinic Visit</h1>
          <p className="text-muted-foreground">
            Register a clinic visit and generate a bill or revisit slip.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Patient Lookup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number *</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="phone"
                  placeholder="Enter 10-digit phone"
                  value={phone}
                  onChange={(event) =>
                    handlePhoneChange(
                      event.target.value.replace(/\D/g, "").slice(0, 10),
                    )
                  }
                  maxLength={10}
                  className="w-full sm:max-w-sm"
                />
                <Button
                  className="w-full sm:w-auto"
                  variant="secondary"
                  type="button"
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {(matchingPatients.length > 0 || phone.length === 10) && (
          <Card>
            <CardHeader>
              <CardTitle>Matching Patients</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <RadioGroup
                value={selectedPatient?.id || ""}
                onValueChange={(id) => {
                  const patient = matchingPatients.find(
                    (candidate) => candidate.id === id,
                  );
                  if (patient) handleSelectPatient(patient);
                }}
              >
                {matchingPatients.map((patient) => (
                  <div
                    key={patient.id}
                    className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedPatient?.id === patient.id
                        ? "border-primary bg-accent"
                        : "border-border hover:bg-muted"
                    }`}
                    onClick={() => handleSelectPatient(patient)}
                  >
                    <RadioGroupItem value={patient.id} id={patient.id} />
                    <Label
                      htmlFor={patient.id}
                      className="flex-1 cursor-pointer"
                    >
                      <span className="font-medium">{formatPatientName(patient.name, (patient as any).title)}</span>
                      <span className="text-muted-foreground ml-2">
                        |{" "}
                        {(patient as any).ageDisplay || `${patient.age} Years`}{" "}
                        | {patient.gender}
                      </span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>

              <Button
                variant="outline"
                className="w-full"
                onClick={handleCreateNewPatient}
                type="button"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Create New Patient
              </Button>
            </CardContent>
          </Card>
        )}

        {showNewPatientForm && (
          <Card>
            <CardHeader>
              <CardTitle>New Patient</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Title</Label>
                    <Select
                      value={newPatient.title}
                      onValueChange={(v) => {
                        const autoGender = TITLE_TO_GENDER[v];
                        setNewPatient({
                          ...newPatient,
                          title: v,
                          ...(autoGender ? { gender: autoGender } : {}),
                        });
                        if (validationErrors.gender) {
                          setValidationErrors({
                            ...validationErrors,
                            gender: undefined,
                          });
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select title" />
                      </SelectTrigger>
                      <SelectContent>
                        {titleOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      placeholder="Full name"
                      value={newPatient.name}
                      onChange={(event) => {
                        setNewPatient({
                          ...newPatient,
                          name: event.target.value,
                        });
                        if (validationErrors.name) {
                          setValidationErrors({
                            ...validationErrors,
                            name: undefined,
                          });
                        }
                      }}
                      className={validationErrors.name ? "border-red-500" : ""}
                    />
                    {validationErrors.name && (
                      <p className="text-sm text-red-500">
                        {validationErrors.name}
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dateOfBirth">Date of Birth (Optional)</Label>
                  <Input
                    id="dateOfBirth"
                    type="date"
                    value={newPatient.dateOfBirth}
                    onChange={(event) => {
                      const dob = event.target.value;
                      if (dob) {
                        const smart = computeSmartAge(dob);
                        setNewPatient({
                          ...newPatient,
                          dateOfBirth: dob,
                          age: smart.age.toString(),
                          ageUnit: smart.unit,
                        });
                      } else {
                        setNewPatient({ ...newPatient, dateOfBirth: dob });
                      }
                    }}
                  />
                  <p className="text-xs text-gray-500">
                    If DOB is entered, age will be calculated automatically
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">Age *</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="age"
                      type="number"
                      placeholder="Age"
                      value={newPatient.age}
                      onChange={(event) => {
                        setNewPatient({
                          ...newPatient,
                          age: event.target.value,
                        });
                        if (validationErrors.age) {
                          setValidationErrors({
                            ...validationErrors,
                            age: undefined,
                          });
                        }
                      }}
                      className={`flex-1 ${validationErrors.age ? "border-red-500" : ""}`}
                    />
                    <Select
                      value={newPatient.ageUnit}
                      onValueChange={(value) =>
                        setNewPatient({
                          ...newPatient,
                          ageUnit: value as "DAYS" | "MONTHS" | "YEARS",
                        })
                      }
                    >
                      <SelectTrigger className="w-full sm:w-[110px]">
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
                    <p className="text-sm text-red-500">
                      {validationErrors.age}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Gender *</Label>
                  <RadioGroup
                    value={newPatient.gender}
                    onValueChange={(value) => {
                      setNewPatient({
                        ...newPatient,
                        gender: value as "M" | "F" | "O",
                      });
                      if (validationErrors.gender) {
                        setValidationErrors({
                          ...validationErrors,
                          gender: undefined,
                        });
                      }
                    }}
                    className="flex flex-wrap gap-4"
                  >
                    {["M", "F", "O"].map((gender) => (
                      <div key={gender} className="flex items-center space-x-2">
                        <RadioGroupItem
                          value={gender}
                          id={`gender-${gender}`}
                        />
                        <Label htmlFor={`gender-${gender}`}>{gender}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                  {validationErrors.gender && (
                    <p className="text-sm text-red-500">
                      {validationErrors.gender}
                    </p>
                  )}
                </div>
              </div>

              {validationErrors.phone && (
                <div className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-md p-3">
                  <strong>Phone:</strong> {validationErrors.phone}
                </div>
              )}

              <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
                <Checkbox
                  id="clinicWhatsappOptIn"
                  checked={newPatient.whatsappOptIn}
                  onCheckedChange={(checked) =>
                    setNewPatient({
                      ...newPatient,
                      whatsappOptIn: checked === true,
                    })
                  }
                />
                <Label
                  htmlFor="clinicWhatsappOptIn"
                  className="flex items-center gap-2 text-sm cursor-pointer"
                >
                  <MessageCircle className="h-4 w-4 text-green-600" />
                  Send reports & bill confirmations via WhatsApp
                </Label>
              </div>
            </CardContent>
          </Card>
        )}

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
                  onValueChange={(value) => setVisitType(value as VisitType)}
                  className="flex flex-col gap-3 sm:flex-row sm:gap-6"
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
                <Select
                  value={selectedDoctorId}
                  onValueChange={setSelectedDoctorId}
                >
                  <SelectTrigger className="max-w-sm">
                    <SelectValue
                      placeholder={
                        isLoading
                          ? "Loading doctors..."
                          : "Select consulting doctor"
                      }
                    />
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

              {visitType === "IP" && (
                <div className="space-y-2">
                  <Label htmlFor="ward">Hospital/Ward (optional)</Label>
                  <Input
                    id="ward"
                    placeholder="e.g., Ward B - Room 204"
                    value={hospitalWard}
                    onChange={(event) => setHospitalWard(event.target.value)}
                    className="max-w-sm"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {(selectedPatient || showNewPatientForm) && selectedDoctorId && (
          <Card>
            <CardHeader>
              <CardTitle>Billing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {checkingRevisit && (
                <p className="text-sm text-muted-foreground animate-pulse">
                  Checking revisit eligibility...
                </p>
              )}

              {activeAnchorVisit && revisitContext?.eligible && (
                <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <RotateCcw className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-blue-900">
                      Eligible Revisit Detected — No New Bill by Default
                    </p>
                    <p className="text-sm text-blue-700 mt-1">
                      Prior paid visit on{" "}
                      <strong>
                        {new Date(
                          activeAnchorVisit.visitDate,
                        ).toLocaleDateString("en-IN")}
                      </strong>
                      {activeAnchorVisit.originalBillNumber
                        ? ` (Bill #${activeAnchorVisit.originalBillNumber})`
                        : ""}
                      . Reception can still switch this back to a standard
                      billed visit.
                    </p>
                  </div>
                </div>
              )}

              {activeAnchorVisit && !revisitContext?.eligible && (
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <RotateCcw className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-amber-900">
                      Previous Paid Visit Found — Standard Visit by Default
                    </p>
                    <p className="text-sm text-amber-700 mt-1">
                      Prior paid visit on{" "}
                      <strong>
                        {new Date(
                          activeAnchorVisit.visitDate,
                        ).toLocaleDateString("en-IN")}
                      </strong>
                      {activeAnchorVisit.originalBillNumber
                        ? ` (Bill #${activeAnchorVisit.originalBillNumber})`
                        : ""}
                      . The revisit window has passed, but reception can still
                      allow a revisit manually.
                    </p>
                  </div>
                </div>
              )}

              {!checkingRevisit && !activeAnchorVisit && (
                <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                  No prior paid clinic consultation was found for this patient,
                  doctor, and branch. This will be treated as a standard billed
                  visit.
                </div>
              )}

              {activeAnchorVisit && (
                <div className="space-y-3">
                  <Label>Visit Mode</Label>
                  <RadioGroup
                    value={selectedRevisitMode}
                    onValueChange={(value) =>
                      setSelectedRevisitMode(value as ClinicRevisitMode)
                    }
                    className="grid gap-3 md:grid-cols-2"
                  >
                    <Label className="flex items-start gap-3 rounded-lg border p-4 cursor-pointer">
                      <RadioGroupItem
                        value="VISIT"
                        id="mode-visit"
                        className="mt-1"
                      />
                      <span className="space-y-1">
                        <span className="block font-medium">
                          Standard Visit
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          Create a new bill and collect payment now.
                        </span>
                      </span>
                    </Label>
                    <Label className="flex items-start gap-3 rounded-lg border p-4 cursor-pointer">
                      <RadioGroupItem
                        value="REVISIT"
                        id="mode-revisit"
                        className="mt-1"
                      />
                      <span className="space-y-1">
                        <span className="block font-medium">Revisit</span>
                        <span className="block text-sm text-muted-foreground">
                          No new bill. The prescription and slip will reference
                          the earlier paid visit.
                        </span>
                      </span>
                    </Label>
                  </RadioGroup>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="fee">
                  {isRevisitSelected
                    ? "Standard Consultation Fee"
                    : "Consultation Fee"}
                </Label>
                <div className="flex items-center gap-2 max-w-sm">
                  <span className="text-muted-foreground">₹</span>
                  <Input
                    id="fee"
                    type="number"
                    value={consultationFee}
                    onChange={(event) => setConsultationFee(event.target.value)}
                    disabled={isRevisitSelected}
                    className={
                      isRevisitSelected
                        ? "bg-blue-50 text-blue-700 font-medium"
                        : ""
                    }
                  />
                </div>
                {isRevisitSelected ? (
                  <p className="text-sm text-blue-700">
                    Charged now: <strong>₹0</strong>. The saved fee above will
                    be used only if you switch back to a standard billed visit.
                  </p>
                ) : null}
              </div>

              {isRevisitSelected ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
                  This revisit will be registered without creating a new bill.
                  Payment details and bill confirmation are skipped for revisit
                  visits.
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Payment Type *</Label>
                    <RadioGroup
                      value={paymentMode}
                      onValueChange={(value) => {
                        setPaymentMode(value as any);
                        if (value === "SPLIT") {
                          setSplitAmounts({ cash: consultationFee, online: 0 });
                        }
                      }}
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
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="SPLIT" id="split" />
                        <Label htmlFor="split">Split Payment</Label>
                      </div>
                    </RadioGroup>

                    {paymentMode === "SPLIT" && (
                      <div className="flex gap-4 mt-4">
                        <div className="flex-1 space-y-2">
                          <Label>Cash Amount (₹)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={splitAmounts.cash || ""}
                            onChange={(e) => {
                              const cash = Number(e.target.value);
                              setSplitAmounts({
                                cash,
                                online: Math.max(0, consultationFee - cash),
                              });
                            }}
                          />
                        </div>
                        <div className="flex-1 space-y-2">
                          <Label>Online Amount (₹)</Label>
                          <Input
                            type="number"
                            min="0"
                            value={splitAmounts.online || ""}
                            onChange={(e) => {
                              const online = Number(e.target.value);
                              setSplitAmounts({
                                cash: Math.max(0, consultationFee - online),
                                online,
                              });
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {selectedPatient && !showNewPatientForm && (
                    <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
                      <Checkbox
                        id="existingPatientWhatsappOptIn"
                        checked={whatsappOptIn}
                        onCheckedChange={(checked) =>
                          setWhatsappOptIn(checked === true)
                        }
                      />
                      <Label
                        htmlFor="existingPatientWhatsappOptIn"
                        className="flex items-center gap-2 text-sm cursor-pointer"
                      >
                        <MessageCircle className="h-4 w-4 text-green-600" />
                        Send bill confirmation via WhatsApp
                      </Label>
                    </div>
                  )}
                </>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting
                  ? "Creating Visit..."
                  : isRevisitSelected
                    ? "Register Clinic Revisit"
                    : "Generate Clinic Bill"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
};

export default ClinicNewVisit;
