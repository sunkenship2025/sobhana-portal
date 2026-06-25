import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  MessageCircle,
  Printer,
  RotateCcw,
  Search,
  UserPlus,
  Phone,
  Check,
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { StatusBadge } from "@/components/ui/status-badge";
import { goToStep, goToNext, goToPrev, handleFlowKey } from "@/lib/focusFlow";
import { useVisitDefaults } from "@/store/visitDefaultsStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  computeSmartAge,
  type ValidationErrors,
  validatePatientForm,
} from "@/lib/validation";
import { TITLE_TO_GENDER, titleOptions, formatPatientName } from "@/lib/patientDisplay";
import { useConfirm } from "@/hooks/use-confirm";
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
  SearchKind,
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

/**
 * Navigation state this page accepts (Group C step 14b — net-new prefill reader).
 * Sources:
 *   - SmartSearchResults "no match → Register"  → { prefill: { kind, value } }
 *   - Patient360 NewVisitMenu                    → { prefillPatientId, prefillPatient }
 * Direct navigation (no state) behaves exactly as before.
 */
interface NewVisitPrefillState {
  prefill?: { kind: SearchKind; value: string };
  prefillPatientId?: string;
  prefillPatient?: Patient;
}

const ClinicNewVisit = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { confirm, ConfirmDialog } = useConfirm();
  const printRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const { token } = useAuthStore();
  const activeBranchId = useBranchStore((state) => state.activeBranchId);
  const branches = useBranchStore((state) => state.branches);
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  const activeBranch = getActiveBranch();

  const [clinicDoctors, setClinicDoctors] = useState<ClinicDoctor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [billLogoLoaded, setBillLogoLoaded] = useState(false);

  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // Enter advances only when the current field is valid
  const flowGuard =
    (validate: () => boolean) => (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.repeat) return;
      const step = Number((e.currentTarget as HTMLElement).dataset.focusStep);
      if (e.key === "Escape") {
        e.preventDefault();
        goToPrev(step);
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!validate()) return;
      goToNext(step);
    };

  const guardPatientField = (key: "name" | "age") => () => {
    const errors = validatePatientForm({
      name: newPatient.name,
      age: newPatient.age,
      gender: newPatient.gender,
      phone,
      ageUnit: newPatient.ageUnit,
    });
    if (errors[key]) {
      setValidationErrors((prev) => ({ ...prev, [key]: errors[key] }));
      return false;
    }
    return true;
  };

  const guardPhone = () => {
    if (phone.length !== 10) {
      toast.error("Please enter a valid 10-digit phone number");
      return false;
    }
    return true;
  };

  const flowKeyOrConfirm = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.repeat) return;
    if (e.key === "Enter") {
      e.preventDefault();
      // Validate, then open the confirm dialog (deliberate, non-volatile).
      openConfirmBill();
    } else if (e.key === "Escape") {
      e.preventDefault();
      const step = Number((e.currentTarget as HTMLElement).dataset.focusStep);
      goToPrev(step);
    }
  };
  const [matchingPatients, setMatchingPatients] = useState<Patient[]>([]);
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(0);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [visitType, setVisitType] = useState<VisitType>("OP");
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [hospitalWard, setHospitalWard] = useState("");
  const [consultationFee, setConsultationFee] = useState(
    DEFAULT_CONSULTATION_FEE,
  );
  const [paymentMode, setPaymentMode] = useState<"CASH" | "ONLINE" | "SPLIT">(
    () => useVisitDefaults.getState().lastClinicPaymentMode,
  );
  const [splitAmounts, setSplitAmounts] = useState({ cash: 0, online: 0 });
  const [successData, setSuccessData] = useState<{
    visitView: ClinicVisitView;
  } | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

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
          const doctors: ClinicDoctor[] = await res.json();
          setClinicDoctors(doctors);
          // Pre-select a doctor so the operator doesn't pick one every visit:
          // prefer the last-used doctor, else auto-select when there's only one.
          const rememberedId = useVisitDefaults.getState().lastClinicDoctorId;
          const preferred =
            doctors.find((d) => d.id === rememberedId) ??
            (doctors.length === 1 ? doctors[0] : null);
          if (preferred) {
            setSelectedDoctorId(preferred.id);
            if (preferred.consultationFeeInPaise != null) {
              setConsultationFee(
                String(Math.round(preferred.consultationFeeInPaise / 100)),
              );
            }
          } else {
            // No preferred doctor in this branch — drop any selection that
            // isn't in this branch's list so the billing/confirm never render
            // off a stale doctor (e.g. after switching branch mid-flow).
            setSelectedDoctorId((cur) =>
              doctors.some((d: ClinicDoctor) => d.id === cur) ? cur : "",
            );
          }
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

  // Patient lookup goes through React Query's cache. Both the search fired while
  // typing (on the 10th digit) and the one on Enter call this with the same
  // queryKey, so React Query dedupes them into a single request and serves the
  // result from cache within staleTime — pressing Enter no longer waits on a
  // second round-trip. A failed request returns [] (and isn't cached as data).
  const runPatientSearch = async (value: string): Promise<Patient[]> => {
    if (value.length !== 10 || !token || !activeBranch) return [];
    try {
      return await queryClient.fetchQuery<Patient[]>({
        queryKey: ["patientSearch", "clinic", activeBranch.id, value],
        queryFn: async ({ signal }) => {
          const res = await fetch(
            `${API_BASE}/patients/search?phone=${value}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "X-Branch-Id": activeBranch.id,
              },
              signal,
            },
          );
          if (!res.ok) throw new Error("Patient search failed");
          const results = await res.json();
          return results.map((result: any) => result.patient) as Patient[];
        },
        staleTime: 10_000,
        retry: 1,
      });
    } catch (error) {
      console.error("Search failed:", error);
      return [];
    }
  };

  const handlePhoneChange = async (value: string) => {
    setPhone(value);
    setMatchingPatients(value.length === 10 ? await runPatientSearch(value) : []);
  };

  // Phone Enter: search, then branch on the fresh result. Existing patient(s)
  // land on the match list; a brand-new number skips straight to Title (step 21)
  // so the operator doesn't have to press Enter twice to "Create New Patient".
  const handlePhoneEnter = async () => {
    if (!guardPhone()) return;
    const patients = await runPatientSearch(phone);
    setMatchingPatients(patients);
    setHighlightedPatientIndex(0);
    if (patients.length === 1) {
      // Exactly one match — select it and skip the list step entirely.
      handleSelectPatient(patients[0]);
    } else if (patients.length > 1) {
      goToStep(20);
    } else {
      // New patient — skip the (empty) list and start at Title.
      handleCreateNewPatient();
    }
  };

  const handleCreateNewPatient = () => {
    setShowNewPatientForm(true);
    setSelectedPatient(null);
    setEmail("");
    // Start the new-patient flow at Title (step 21).
    goToStep(21);
  };

  // --- Group C step 14b: prefill reader -------------------------------------
  // Seed the search/create step from navigation state when arriving from the
  // smart-search "no match → Register" path or the Patient360 NewVisitMenu.
  // Runs exactly once (consumedPrefill guard); direct navigation (no state)
  // is a no-op so the page behaves as before. A phone prefill defers its
  // patient search until auth/branch are ready.
  const consumedPrefill = useRef(false);
  useEffect(() => {
    if (consumedPrefill.current) return;
    const state = (location.state ?? null) as NewVisitPrefillState | null;
    if (!state || (!state.prefill && !state.prefillPatientId && !state.prefillPatient)) {
      consumedPrefill.current = true;
      return;
    }

    // 1. A concrete patient (from the detail page) — select it directly.
    if (state.prefillPatient) {
      consumedPrefill.current = true;
      handleSelectPatient(state.prefillPatient);
      return;
    }

    // 2. A patientId only — look it up by phone-less search is not possible;
    //    defer to the prefill.value path below if present, else just wait for
    //    auth/branch and treat it as a soft hint (no-op until a richer payload).
    //    (NewVisitMenu always passes prefillPatient, so this is rarely hit.)

    // 3. A typed value from the smart search. Phone seeds + searches; other
    //    kinds open the new-patient form and seed the name when it's a name.
    if (state.prefill) {
      const { kind, value } = state.prefill;
      const trimmed = (value ?? "").trim();
      if (kind === "phone") {
        const digits = trimmed.replace(/\D/g, "").slice(0, 10);
        setPhone(digits);
        // A full 10-digit number triggers the same search/branch as a manual
        // Enter, but only once auth/branch are ready.
        if (digits.length === 10) {
          if (!token || !activeBranch) {
            // Not ready yet — re-run when token/activeBranch land (deps below).
            return;
          }
          consumedPrefill.current = true;
          runPatientSearch(digits).then((patients) => {
            setMatchingPatients(patients);
            setHighlightedPatientIndex(0);
            if (patients.length === 1) {
              handleSelectPatient(patients[0]);
            } else if (patients.length > 1) {
              goToStep(20);
            } else {
              handleCreateNewPatient();
            }
          });
        } else {
          // Partial phone: seed the field, consume, and let the operator finish.
          consumedPrefill.current = true;
        }
        return;
      }

      // Non-phone typed value → start a fresh registration, seeding name.
      consumedPrefill.current = true;
      setShowNewPatientForm(true);
      setSelectedPatient(null);
      if (kind === "name" && trimmed) {
        setNewPatient((prev) => ({ ...prev, name: trimmed }));
      }
      goToStep(21);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, token, activeBranch]);

  // Single source of truth for synchronous validation. Gates the confirm
  // dialog; handleSubmit re-checks as defense in depth.
  const runBillValidation = (): boolean => {
    if (!token || !activeBranch) {
      toast.error("Not authenticated");
      return false;
    }
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
        return false;
      }
      if (!newPatient.name || (!newPatient.age && !newPatient.dateOfBirth)) {
        toast.error("Please fill in all patient details");
        return false;
      }
    } else if (!selectedPatient) {
      toast.error("Please select or create a patient");
      return false;
    }
    if (!selectedDoctorId) {
      toast.error("Please select a doctor");
      return false;
    }
    if (!consultationFee.trim()) {
      toast.error("Please enter a consultation fee");
      return false;
    }
    const parsedFee = parseInt(consultationFee, 10);
    if (Number.isNaN(parsedFee) || parsedFee < 0) {
      toast.error("Consultation fee must be a valid non-negative number");
      return false;
    }
    return true;
  };

  // Terminal action of the keyboard flow: validate, then open the confirm dialog.
  const openConfirmBill = () => {
    if (runBillValidation()) setShowConfirmDialog(true);
  };

  const handleSelectPatient = (patient: Patient) => {
    setSelectedPatient(patient);
    setShowNewPatientForm(false);
    setEmail("");
    setWhatsappOptIn((patient as any).whatsappOptIn ?? true);
    // Advance to Visit Details once that card has committed (step 30).
    goToStep(30);
  };

  const resetForm = () => {
    setSuccessData(null);
    // Drop cached searches so a just-registered patient shows up if the same
    // number is looked up again.
    queryClient.invalidateQueries({ queryKey: ["patientSearch"] });
    setPhone("");
    setEmail("");
    setMatchingPatients([]);
    setSelectedPatient(null);
    // Re-apply the remembered/auto-selected doctor so "Create Another Visit"
    // doesn't drop it back to an empty picker.
    const rememberedId = useVisitDefaults.getState().lastClinicDoctorId;
    const preferred =
      clinicDoctors.find((d) => d.id === rememberedId) ??
      (clinicDoctors.length === 1 ? clinicDoctors[0] : null);
    setSelectedDoctorId(preferred?.id ?? "");
    setHospitalWard("");
    setShowNewPatientForm(false);
    setConsultationFee(
      preferred?.consultationFeeInPaise != null
        ? String(Math.round(preferred.consultationFeeInPaise / 100))
        : DEFAULT_CONSULTATION_FEE,
    );
    setRevisitContext(null);
    setSelectedRevisitMode("VISIT");
    setPaymentMode(useVisitDefaults.getState().lastClinicPaymentMode);
    setSplitAmounts({ cash: 0, online: 0 });
    setNewPatient({
      title: "",
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
            identifiers: [
              { type: "PHONE", value: phone, isPrimary: true },
              ...(email.trim() ? [{ type: "EMAIL", value: email.trim(), isPrimary: false }] : []),
            ],
            whatsappOptIn: newPatient.whatsappOptIn,
          }),
        });

        if (res.status === 409) {
          const errorData = await res.json();
          const duplicateInfo = JSON.parse(errorData.message);
          const existing = duplicateInfo.existingPatient;

          const choice = await confirm({
            title: "Possible duplicate patient",
            description: (
              <div className="space-y-2 text-sm">
                <p>A patient with this phone number already exists:</p>
                <p className="font-medium text-foreground">
                  {existing.patientNumber} · {formatPatientName(existing.name, existing.title)} · {existing.ageDisplay || `${existing.age}y`} · {existing.gender} · {existing.phone}
                </p>
                <p>Is this the same person?</p>
              </div>
            ),
            confirmText: "Use existing patient",
            cancelText: "Create new anyway",
            destructiveCancel: true,
            defaultFocus: "confirm",
          });

          if (choice === null) return; // dismissed — abort without creating anything

          if (choice) {
            patient = {
              id: existing.id,
              patientNumber: existing.patientNumber,
              name: existing.name,
              title: existing.title,
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
                identifiers: [
                  { type: "PHONE", value: phone, isPrimary: true },
                  ...(email.trim() ? [{ type: "EMAIL", value: email.trim(), isPrimary: false }] : []),
                ],
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
      setShowConfirmDialog(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to create visit");
    } finally {
      setIsSubmitting(false);
    }
  };

  const [printMode, setPrintMode] = useState<"rx" | "bill" | "both">("both");
  const [isPrinting, setIsPrinting] = useState(false);

  const handlePrint = (mode: "rx" | "bill" | "both") => {
    setPrintMode(mode);
    setIsPrinting(true);
    // Give React time to re-render the hidden print block with the new mode
    setTimeout(() => {
      window.print();
      setIsPrinting(false);
    }, 100);
  };

  if (successData) {
    const { visitView } = successData;
    const hasBill = visitView.visit.hasBill;

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
                    onClick={() => handlePrint("rx")}
                    disabled={isPrinting}
                  >
                    <Printer className="mr-2 h-4 w-4" />
                    Print Prescription
                  </Button>

                  <Button
                    className="w-full sm:w-auto"
                    variant="outline"
                    onClick={() => handlePrint("bill")}
                    disabled={!billLogoLoaded || isPrinting}
                  >
                    <Printer className="mr-2 h-4 w-4" />
                    {billLogoLoaded ? (hasBill ? "Print Bill" : "Print Visit Slip") : (hasBill ? "Preparing Bill..." : "Preparing Slip...")}
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
            printMode={printMode}
          />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="clinic" subContext="Reception">
      {ConfirmDialog}
      <div className="max-w-[760px] mx-auto space-y-4 pb-24 animate-fade-in">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-lg font-semibold">New Clinic Visit</h1>
            {selectedPatient && (
              <span className="truncate text-sm text-muted-foreground">
                {formatPatientName(selectedPatient.name, selectedPatient.title)}
                {selectedPatient.age
                  ? ` · ${selectedPatient.ageDisplay || selectedPatient.age + "y"}`
                  : ""}
                {selectedPatient.gender ? ` · ${selectedPatient.gender}` : ""}
              </span>
            )}
          </div>

          {/* Flow steps — reflects real progress: pick/register patient → visit → bill */}
          {(() => {
            const patientDone =
              !!selectedPatient ||
              (showNewPatientForm && newPatient.name.trim() !== "");
            const visitDone = !!selectedDoctorId;
            const steps = [
              { label: "Patient", done: patientDone, active: !patientDone },
              { label: "Visit", done: visitDone, active: patientDone && !visitDone },
              { label: "Bill", done: false, active: visitDone },
            ];
            return (
              <nav
                aria-label="Visit progress"
                className="flex items-center gap-2.5 text-xs"
              >
                {steps.map((s, i) => (
                  <div key={s.label} className="flex items-center gap-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold leading-none transition-colors ${
                          s.done || s.active
                            ? "bg-primary text-primary-foreground"
                            : "border border-border text-muted-foreground"
                        }`}
                        aria-current={s.active ? "step" : undefined}
                      >
                        {s.done ? <Check className="h-3 w-3" /> : i + 1}
                      </span>
                      <span
                        className={`font-medium ${
                          s.done || s.active
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {s.label}
                      </span>
                    </div>
                    {i < steps.length - 1 && (
                      <span className="h-px w-6 bg-border" aria-hidden="true" />
                    )}
                  </div>
                ))}
              </nav>
            );
          })()}
        </div>

        <Card>
          <CardContent className="space-y-4 p-5 sm:p-6">
            <h2 className="text-base font-semibold leading-none">
              Select or register a patient
            </h2>
            <div className="space-y-2">
              <Label htmlFor="phone" className="sr-only">
                Phone Number
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="phone"
                    inputMode="numeric"
                    placeholder="Enter 10-digit phone"
                    value={phone}
                    onChange={(event) =>
                      handlePhoneChange(
                        event.target.value.replace(/\D/g, "").slice(0, 10),
                      )
                    }
                    maxLength={10}
                    autoComplete="off"
                    className="h-12 pl-10 pr-14 text-base tracking-wide tabular-nums"
                    onKeyDown={(e) => {
                      if (e.repeat) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handlePhoneEnter();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        goToPrev(10);
                      }
                    }}
                    data-focus-step={10}
                    autoFocus
                  />
                  {phone.length === 10 ? (
                    <Check className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-success" />
                  ) : phone.length > 0 ? (
                    <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-medium tabular-nums text-muted-foreground">
                      {phone.length}/10
                    </span>
                  ) : null}
                </div>
                <Button
                  className="h-12 w-full px-6 sm:w-auto"
                  type="button"
                  onClick={() => handlePhoneChange(phone)}
                  disabled={phone.length < 10}
                >
                  <Search className="mr-2 h-4 w-4" />
                  Search
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {(matchingPatients.length > 0 || phone.length === 10) && (
          <Card>
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-base font-semibold">Matching Patients</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3 space-y-3">
              <div
                className="space-y-2 outline-none"
                tabIndex={0}
                data-focus-step={20}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHighlightedPatientIndex(prev =>
                      Math.min(prev + 1, matchingPatients.length)
                    );
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHighlightedPatientIndex(prev => Math.max(prev - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (highlightedPatientIndex < matchingPatients.length) {
                      handleSelectPatient(matchingPatients[highlightedPatientIndex]);
                    } else {
                      handleCreateNewPatient();
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    goToPrev(20);
                  }
                }}
                onBlur={() => setHighlightedPatientIndex(0)}
              >
                {matchingPatients.map((patient, index) => (
                  <div
                    key={patient.id}
                    className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedPatient?.id === patient.id
                        ? "border-primary bg-accent"
                        : highlightedPatientIndex === index
                          ? "border-primary/50 bg-accent/50 ring-2 ring-primary/30"
                          : "border-border hover:bg-muted"
                    }`}
                    onClick={() => handleSelectPatient(patient)}
                    onMouseEnter={() => setHighlightedPatientIndex(index)}
                  >
                    <div className={`h-4 w-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                      selectedPatient?.id === patient.id
                        ? "border-primary"
                        : "border-muted-foreground"
                    }`}>
                      {selectedPatient?.id === patient.id && (
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </div>
                    <div className="flex-1">
                      <span className="font-medium">{formatPatientName(patient.name, (patient as any).title)}</span>
                      <span className="text-muted-foreground ml-2">
                        |{" "}
                        {(patient as any).ageDisplay || `${patient.age} Years`}{" "}
                        | {patient.gender}
                      </span>
                    </div>
                  </div>
                ))}

                <Button
                  variant="outline"
                  className={`w-full transition-colors ${
                    highlightedPatientIndex === matchingPatients.length
                      ? "ring-2 ring-primary/30 border-primary/50"
                      : ""
                  }`}
                  onClick={handleCreateNewPatient}
                  onMouseEnter={() => setHighlightedPatientIndex(matchingPatients.length)}
                  type="button"
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  Create New Patient
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                Use ↑↓ arrow keys to navigate, Enter to select
              </p>
            </CardContent>
          </Card>
        )}

        {showNewPatientForm && (
          <Card>
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-base font-semibold">New Patient</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3 space-y-3">
              {/* Row 1: Title + Name */}
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <SearchableSelect
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
                      goToStep(22);
                    }}
                    options={titleOptions}
                    placeholder="Select title"
                    searchPlaceholder="Type a title..."
                    emptyText="No title found."
                    onAdvance={() => goToStep(22)}
                    focusStep={21}
                    ariaLabel="Title"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="name">Full Name *</Label>
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
                    onKeyDown={flowGuard(guardPatientField("name"))}
                    data-focus-step={22}
                    className={validationErrors.name ? "border-destructive" : ""}
                  />
                  {validationErrors.name && (
                    <p className="text-sm text-destructive">
                      {validationErrors.name}
                    </p>
                  )}
                </div>
              </div>
              {/* Row 2: Gender + Age + DOB */}
              <div className="grid gap-4 md:grid-cols-3">
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
                      goToStep(26);
                    }}
                    className="flex flex-wrap gap-4"
                  >
                    {["M", "F", "O"].map((gender) => (
                      <div key={gender} className="flex items-center space-x-2">
                        <RadioGroupItem
                          value={gender}
                          id={`gender-${gender}`}
                          data-focus-step={
                            TITLE_TO_GENDER[newPatient.title] ? undefined : 24
                          }
                          onKeyDown={handleFlowKey}
                        />
                        <Label htmlFor={`gender-${gender}`}>{gender}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                  {validationErrors.gender && (
                    <p className="text-sm text-destructive">
                      {validationErrors.gender}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">Age *</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="age"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="Age"
                      value={newPatient.age}
                      onChange={(event) => {
                        setNewPatient({
                          ...newPatient,
                          age: event.target.value.replace(/\D/g, ""),
                        });
                        if (validationErrors.age) {
                          setValidationErrors({
                            ...validationErrors,
                            age: undefined,
                          });
                        }
                      }}
                      onKeyDown={flowGuard(guardPatientField("age"))}
                      data-focus-step={26}
                      className={`flex-1 ${validationErrors.age ? "border-destructive" : ""}`}
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
                      <SelectTrigger className="w-full sm:w-[110px]" onKeyDown={handleFlowKey}>
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
                    <p className="text-sm text-destructive">
                      {validationErrors.age}
                    </p>
                  )}
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
                    onKeyDown={handleFlowKey}
                  />
                  <p className="text-xs text-muted-foreground">
                    If DOB is entered, age will be calculated automatically
                  </p>
                </div>
              </div>

              {/* Email (optional) */}
              <div className="space-y-2">
                <Label htmlFor="email">Email (optional)</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="patient@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off"
                />
              </div>

              {validationErrors.phone && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-3">
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
                  onKeyDown={handleFlowKey}
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
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-base font-semibold">Visit Details</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3 space-y-3">
              <div className="space-y-2">
                <Label>Visit Type *</Label>
                <RadioGroup
                  value={visitType}
                  onValueChange={(value) => setVisitType(value as VisitType)}
                  className="flex flex-col gap-3 sm:flex-row sm:gap-6"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem
                      value="OP"
                      id="op"
                      data-focus-step={30}
                      onKeyDown={handleFlowKey}
                    />
                    <Label htmlFor="op">OP (Outpatient)</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem
                      value="IP"
                      id="ip"
                      data-focus-step={30}
                      onKeyDown={handleFlowKey}
                    />
                    <Label htmlFor="ip">IP (Inpatient)</Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label>Consulting Doctor *</Label>
                <SearchableSelect
                  value={selectedDoctorId}
                  onValueChange={(id) => {
                    setSelectedDoctorId(id);
                    useVisitDefaults.getState().setLastClinicDoctorId(id);
                    const doc = clinicDoctors.find((d) => d.id === id);
                    if (doc?.consultationFeeInPaise != null) {
                      setConsultationFee(
                        String(Math.round(doc.consultationFeeInPaise / 100)),
                      );
                    }
                    // Doctor chosen → advance to the fee field (step 60).
                    goToStep(60);
                  }}
                  onAdvance={() => goToStep(60)}
                  focusStep={40}
                  options={clinicDoctors.map((doctor) => {
                    const fee =
                      doctor.consultationFeeInPaise != null
                        ? Math.round(doctor.consultationFeeInPaise / 100)
                        : null;
                    return {
                      value: doctor.id,
                      label: doctor.name,
                      description: [doctor.specialty, fee != null ? `₹${fee}` : null]
                        .filter(Boolean)
                        .join(" · "),
                      keywords: [doctor.name, doctor.specialty]
                        .filter(Boolean)
                        .join(" "),
                    };
                  })}
                  placeholder={
                    isLoading ? "Loading doctors…" : "Select consulting doctor"
                  }
                  searchPlaceholder="Search by doctor name or specialty"
                  emptyText="No consulting doctors found."
                  ariaLabel="Consulting doctor"
                  className="h-11"
                />
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
                    data-focus-step={45}
                    onKeyDown={handleFlowKey}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {(selectedPatient || showNewPatientForm) && selectedDoctorId && (
          <Card>
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-base font-semibold">Billing</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3 space-y-3">
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
                        data-focus-step={50}
                        onKeyDown={handleFlowKey}
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
                        data-focus-step={50}
                        onKeyDown={handleFlowKey}
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
                    data-focus-step={60}
                    onKeyDown={handleFlowKey}
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
                        const mode = value as "CASH" | "ONLINE" | "SPLIT";
                        setPaymentMode(mode);
                        // Remember CASH/ONLINE as the default; SPLIT is a
                        // per-transaction choice (its amounts seed on change).
                        if (mode !== "SPLIT") {
                          useVisitDefaults
                            .getState()
                            .setLastClinicPaymentMode(mode);
                        }
                        if (mode === "SPLIT") {
                          setSplitAmounts({
                            cash: Number(consultationFee) || 0,
                            online: 0,
                          });
                          goToStep(110);
                        }
                      }}
                      onKeyDown={(e) => {
                        // Terminal Enter for the whole payment group: works
                        // wherever focus sits among the radios. SPLIT routes to
                        // the amount inputs; CASH/ONLINE open the confirm dialog.
                        if (e.repeat) return;
                        if (e.key === "Escape") {
                          e.preventDefault();
                          goToPrev(100);
                        } else if (e.key === "Enter") {
                          e.preventDefault();
                          if (paymentMode === "SPLIT") goToStep(110);
                          else openConfirmBill();
                        }
                      }}
                      className="flex gap-6"
                      orientation="horizontal"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem
                          value="CASH"
                          id="cash"
                          data-focus-step={100}
                        />
                        <Label htmlFor="cash">Cash</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem
                          value="ONLINE"
                          id="online"
                          data-focus-step={100}
                        />
                        <Label htmlFor="online">Online</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem
                          value="SPLIT"
                          id="split"
                          data-focus-step={100}
                        />
                        <Label htmlFor="split">Split</Label>
                      </div>
                    </RadioGroup>

                    {paymentMode === "SPLIT" && (
                      <div className="flex gap-4 mt-4">
                        <div className="flex-1 space-y-2">
                          <Label>Cash ₹</Label>
                          <Input
                            id="split-cash"
                            type="number"
                            min="0"
                            placeholder="Shift+→ to Online"
                            value={splitAmounts.cash || ""}
                            onChange={(e) => {
                              const cash = Number(e.target.value);
                              setSplitAmounts({
                                cash,
                                online: Math.max(0, Number(consultationFee) - cash),
                              });
                            }}
                            onKeyDown={(e) => {
                              if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) {
                                e.preventDefault();
                                const onlineInput = document.getElementById('split-online') as HTMLInputElement;
                                if (onlineInput) {
                                  onlineInput.focus();
                                  onlineInput.select();
                                }
                                return;
                              }
                              handleFlowKey(e);
                            }}
                            data-focus-step={110}
                          />
                        </div>
                        <div className="flex-1 space-y-2">
                          <Label>Online ₹</Label>
                          <Input
                            id="split-online"
                            type="number"
                            min="0"
                            placeholder="Shift+← to Cash"
                            value={splitAmounts.online || ""}
                            onChange={(e) => {
                              const online = Number(e.target.value);
                              setSplitAmounts({
                                cash: Math.max(0, Number(consultationFee) - online),
                                online,
                              });
                            }}
                            onKeyDown={(e) => {
                              if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) {
                                e.preventDefault();
                                const cashInput = document.getElementById('split-cash') as HTMLInputElement;
                                if (cashInput) {
                                  cashInput.focus();
                                  cashInput.select();
                                }
                                return;
                              }
                              flowKeyOrConfirm(e);
                            }}
                            data-focus-step={120}
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
                        onKeyDown={flowKeyOrConfirm}
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
            </CardContent>
          </Card>
        )}

        {/* Sticky bill summary + action — appears with the bill, pins to bottom */}
        {(selectedPatient || showNewPatientForm) && selectedDoctorId && (
          <div className="sticky bottom-0 -mx-4 mt-4 border-t bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 print:hidden">
            <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-x-5 gap-y-1">
              <div className="flex items-center gap-x-5 text-sm tabular-nums">
                {isRevisitSelected ? (
                  <span className="text-muted-foreground">
                    Revisit —{" "}
                    <b className="font-semibold text-foreground">no bill</b>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Fee{" "}
                    <b className="font-semibold text-foreground">
                      ₹{consultationFee || 0}
                    </b>
                  </span>
                )}
              </div>
              <Button
                size="lg"
                className="ml-auto min-w-[200px]"
                onClick={openConfirmBill}
                disabled={isSubmitting}
              >
                {isRevisitSelected ? "Register Revisit" : "Generate Bill"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Confirm & generate */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            confirmButtonRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isRevisitSelected ? "Confirm Revisit" : "Confirm Bill"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Patient</span>
              <span className="font-medium text-right">
                {selectedPatient
                  ? `${formatPatientName(selectedPatient.name, selectedPatient.title)} · ${selectedPatient.ageDisplay || selectedPatient.age} · ${selectedPatient.gender}`
                  : `${formatPatientName(newPatient.name, newPatient.title)} · ${newPatient.age} ${newPatient.ageUnit.toLowerCase()} · ${newPatient.gender}`}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Doctor</span>
              <span className="font-medium text-right">
                {clinicDoctors.find((d) => d.id === selectedDoctorId)?.name ||
                  "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Visit type</span>
              <span className="font-medium">{visitType}</span>
            </div>
            {isRevisitSelected ? (
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground">Mode</span>
                <span className="font-semibold text-blue-700">
                  Revisit — no new bill
                </span>
              </div>
            ) : (
              <>
                <div className="flex justify-between border-t pt-2">
                  <span className="text-muted-foreground">Consultation fee</span>
                  <span className="font-semibold">₹{consultationFee}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Payment ({paymentMode.toLowerCase()})
                  </span>
                  <span className="font-medium">₹{consultationFee}</span>
                </div>
              </>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setShowConfirmDialog(false)}
              disabled={isSubmitting}
            >
              Back
            </Button>
            <Button
              ref={confirmButtonRef}
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting
                ? "Creating..."
                : isRevisitSelected
                  ? "Register Revisit"
                  : "Generate Bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default ClinicNewVisit;
