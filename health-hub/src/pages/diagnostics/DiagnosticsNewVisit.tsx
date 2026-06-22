import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { API_BASE } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ProductSelector,
  type ProductForSelector,
} from "@/components/diagnostics/ProductSelector";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { toast } from "sonner";
import type {
  Patient,
  PatientSearchResult,
  PaymentType,
  DiagnosticVisitView,
  TestOrder,
  ReferralDoctor,
  DiagnosticCenter,
  BillReceiptItem,
  BillDiscountType,
} from "@/types";
import {
  Search,
  UserPlus,
  CheckCircle2,
  Printer,
  MessageCircle,
  Plus,
} from "lucide-react";
import { BillReceipt } from "@/components/print/BillReceipt";
import {
  validatePatientForm,
  computeSmartAge,
  formatAgeDisplay,
  type ValidationErrors,
} from "@/lib/validation";
import {
  areReferralPayoutsEqual,
  formatReferralPayout,
  getEffectiveDiagnosticCenterPayout,
  getEffectiveDoctorPayout,
  toReferralPayoutDraft,
  toReferralPayoutPayload,
  type ReferralPayoutDraft,
} from "@/lib/referralPayouts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { mapDiagnosticsVisitViewToReceiptData } from "@/lib/billReceiptMappers";
import { TITLE_TO_GENDER, titleOptions, formatPatientName } from "@/lib/patientDisplay";
import { useConfirm } from "@/hooks/use-confirm";
import { goToStep, goToNext, goToPrev, hasNextStep, handleFlowKey } from "@/lib/focusFlow";
import { useVisitDefaults } from "@/store/visitDefaultsStore";

type DiscountMode = "NONE" | BillDiscountType;

const DiagnosticsNewVisit = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, ConfirmDialog } = useConfirm();
  const printRef = useRef<HTMLDivElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const testSelectorRef = useRef<HTMLDivElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const { token } = useAuthStore();
  const activeBranchId = useBranchStore((state) => state.activeBranchId);
  const branches = useBranchStore((state) => state.branches);
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  const activeBranch = getActiveBranch();

  // API data state
  const [products, setProducts] = useState<ProductForSelector[]>([]);
  const [referralDoctors, setReferralDoctors] = useState<ReferralDoctor[]>([]);
  const [diagnosticCenters, setDiagnosticCenters] = useState<
    DiagnosticCenter[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCenterId, setSelectedCenterId] = useState<string>("");
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(0);
  const patientListRef = useRef<HTMLDivElement>(null);

  const [phone, setPhone] = useState("");
  const [matchingPatients, setMatchingPatients] = useState<
    PatientSearchResult[]
  >([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [paymentMode, setPaymentMode] = useState<"CASH" | "ONLINE" | "SPLIT">(
    () => useVisitDefaults.getState().lastDiagPaymentMode,
  );
  const [splitAmounts, setSplitAmounts] = useState({ cash: 0, online: 0 });
  const [discountMode, setDiscountMode] = useState<DiscountMode>("NONE");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>("");
  const [referralOverrides, setReferralOverrides] = useState<
    Record<string, ReferralPayoutDraft>
  >({});
  const [diagnosticCenterOverrides, setDiagnosticCenterOverrides] = useState<
    Record<string, ReferralPayoutDraft>
  >({});
  const [successData, setSuccessData] = useState<{
    visitView: DiagnosticVisitView;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [billLogoLoaded, setBillLogoLoaded] = useState(false);
  const [whatsappOptIn, setWhatsappOptIn] = useState(true); // For existing patients

  // New patient form
  const [newPatient, setNewPatient] = useState({
    name: "",
    title: "" as string,
    age: "",
    ageUnit: "YEARS" as "DAYS" | "MONTHS" | "YEARS",
    dateOfBirth: "", // E2-09: Optional DOB field
    gender: "M" as "M" | "F" | "O",
    whatsappOptIn: true, // Default: opted in for WhatsApp notifications
  });

  // E2-10: Validation errors
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>(
    {},
  );

  // Quick-add dialogs
  const [showAddDoctorDialog, setShowAddDoctorDialog] = useState(false);
  const [showAddCenterDialog, setShowAddCenterDialog] = useState(false);
  const [showAddProductDialog, setShowAddProductDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [newDoctorName, setNewDoctorName] = useState("");
  const [newDoctorPhone, setNewDoctorPhone] = useState("");
  const [newCenterName, setNewCenterName] = useState("");
  const [newCenterPhone, setNewCenterPhone] = useState("");
  const [newProductName, setNewProductName] = useState("");
  const [newProductCode, setNewProductCode] = useState("");
  const [newProductPrice, setNewProductPrice] = useState("");
  const [newProductDescription, setNewProductDescription] = useState("");
  const [isCreatingDoctor, setIsCreatingDoctor] = useState(false);
  const [isCreatingCenter, setIsCreatingCenter] = useState(false);
  const [isCreatingProduct, setIsCreatingProduct] = useState(false);
  const [doctorExistingMatch, setDoctorExistingMatch] = useState<any>(null);
  const [doctorLinkedId, setDoctorLinkedId] = useState<string | null>(null);

  const normalizeSelectableProduct = (
    product: Partial<ProductForSelector> & {
      id: string;
      name: string;
      code: string;
      productType: string;
    },
  ) => {
    const basePrice = Number(product.basePrice ?? 0);
    const effectivePrice = Number(product.effectivePrice ?? basePrice);

    return {
      ...product,
      basePrice,
      effectivePrice,
      priceSource: product.priceSource ?? "BASE",
      description: product.description ?? null,
      panelCount: product.panelCount ?? 0,
      workflowMode: product.workflowMode ?? "REPORTABLE",
      isActive: product.isActive ?? true,
    } as ProductForSelector;
  };

  // Fetch lab tests and referral doctors from API
  useEffect(() => {
    const fetchData = async () => {
      if (!token || !activeBranch) return;

      try {
        const headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Branch-Id": activeBranch.id,
        };

        const [productsRes, doctorsRes, centersRes] = await Promise.all([
          fetch(`${API_BASE}/billable-products`, { headers }),
          fetch(`${API_BASE}/referral-doctors`, { headers }),
          fetch(`${API_BASE}/diagnostic-centers`, { headers }),
        ]);

        if (productsRes.ok) {
          const prods = await productsRes.json();
          setProducts(prods.map(normalizeSelectableProduct));
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
        console.error("Failed to fetch data:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [token, activeBranch]);

  // Auto-focus phone input on page load
  useEffect(() => {
    if (!successData) {
      // Small delay to ensure DOM is ready after any transitions
      const timer = setTimeout(() => {
        phoneInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [successData]);

  // Reset highlighted patient index when matching patients change
  useEffect(() => {
    setHighlightedPatientIndex(0);
  }, [matchingPatients]);

  // Restore focus to the right flow step when a mid-flow dialog closes, so the
  // keyboard flow resumes where it left off. Radix restores focus to the
  // trigger synchronously on close; goToStep's rAF runs after and wins.
  const prevAddProductOpen = useRef(false);
  const prevAddDoctorOpen = useRef(false);
  const prevAddCenterOpen = useRef(false);
  useEffect(() => {
    if (prevAddProductOpen.current && !showAddProductDialog) goToStep(30);
    prevAddProductOpen.current = showAddProductDialog;
  }, [showAddProductDialog]);
  useEffect(() => {
    if (prevAddDoctorOpen.current && !showAddDoctorDialog) goToStep(40);
    prevAddDoctorOpen.current = showAddDoctorDialog;
  }, [showAddDoctorDialog]);
  useEffect(() => {
    if (prevAddCenterOpen.current && !showAddCenterDialog) goToStep(50);
    prevAddCenterOpen.current = showAddCenterDialog;
  }, [showAddCenterDialog]);

  const selectedDoctor = referralDoctors.find(
    (doctor) => doctor.id === selectedDoctorId,
  );
  const selectedCenter = diagnosticCenters.find(
    (center) => center.id === selectedCenterId,
  );

  const buildOverridesForProducts = (
    productIds: string[],
    resolveSavedPayout: (productId: string) => {
      commissionType?: "PERCENTAGE" | "FIXED_AMOUNT" | null;
      commissionPercent?: number | null;
      commissionAmountInPaise?: number | null;
    },
    existing: Record<string, ReferralPayoutDraft> = {},
  ) => {
    const next: Record<string, ReferralPayoutDraft> = {};

    for (const productId of productIds) {
      next[productId] =
        existing[productId] ??
        toReferralPayoutDraft(resolveSavedPayout(productId));
    }

    return next;
  };

  // Quick-add referral doctor
  const handleCreateDoctor = async () => {
    if (!newDoctorName.trim() || !token || !activeBranch) return;

    setIsCreatingDoctor(true);
    try {
      const res = await fetch(`${API_BASE}/referral-doctors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Branch-Id": activeBranch.id,
        },
        body: JSON.stringify({
          name: newDoctorName.trim(),
          phone: newDoctorPhone.trim() || undefined,
          commissionType: "PERCENTAGE",
          commissionPercent: 10,
        }),
      });

      if (res.ok) {
        const doctor = await res.json();
        setReferralDoctors((prev) => [...prev, doctor]);
        setSelectedDoctorId(doctor.id);
        setReferralOverrides(
          buildOverridesForProducts(selectedProducts, (productId) =>
            getEffectiveDoctorPayout(doctor, productId),
          ),
        );
        setShowAddDoctorDialog(false);
        setNewDoctorName("");
        setNewDoctorPhone("");
        toast.success(`Added ${doctor.name}`);
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to create doctor");
      }
    } catch (error) {
      console.error("Create doctor failed:", error);
      toast.error("Failed to create doctor");
    } finally {
      setIsCreatingDoctor(false);
    }
  };

  // Quick-add diagnostic center
  const handleCreateCenter = async () => {
    if (!newCenterName.trim() || !token || !activeBranch) return;

    setIsCreatingCenter(true);
    try {
      const res = await fetch(`${API_BASE}/diagnostic-centers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Branch-Id": activeBranch.id,
        },
        body: JSON.stringify({
          name: newCenterName.trim(),
          phone: newCenterPhone.trim() || undefined,
          commissionType: "PERCENTAGE",
          commissionPercent: 0,
        }),
      });

      if (res.ok) {
        const center = await res.json();
        setDiagnosticCenters((prev) => [...prev, center]);
        setSelectedCenterId(center.id);
        setDiagnosticCenterOverrides(
          buildOverridesForProducts(selectedProducts, (productId) =>
            getEffectiveDiagnosticCenterPayout(center, productId),
          ),
        );
        setShowAddCenterDialog(false);
        setNewCenterName("");
        setNewCenterPhone("");
        toast.success(`Added ${center.name}`);
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to create center");
      }
    } catch (error) {
      console.error("Create center failed:", error);
      toast.error("Failed to create center");
    } finally {
      setIsCreatingCenter(false);
    }
  };

  const handleCreateProduct = async () => {
    if (
      !newProductName.trim() ||
      !newProductCode.trim() ||
      !newProductPrice ||
      !token ||
      !activeBranch
    )
      return;

    setIsCreatingProduct(true);
    try {
      const res = await fetch(
        `${API_BASE}/billable-products/quick-create-bill-only`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Branch-Id": activeBranch.id,
          },
          body: JSON.stringify({
            name: newProductName.trim(),
            code: newProductCode.trim(),
            basePrice: parseFloat(newProductPrice),
            description: newProductDescription.trim() || null,
          }),
        },
      );

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create product");
      }

      const product = normalizeSelectableProduct(await res.json());
      setProducts((prev) => [...prev, product]);
      setSelectedProducts((prev) => [...prev, product.id]);
      setReferralOverrides((prev) => {
        if (!selectedDoctor) {
          return prev;
        }

        return buildOverridesForProducts(
          [...selectedProducts, product.id],
          (productId) => getEffectiveDoctorPayout(selectedDoctor, productId),
          prev,
        );
      });
      setDiagnosticCenterOverrides((prev) => {
        if (!selectedCenter) {
          return prev;
        }

        return buildOverridesForProducts(
          [...selectedProducts, product.id],
          (productId) =>
            getEffectiveDiagnosticCenterPayout(selectedCenter, productId),
          prev,
        );
      });
      setShowAddProductDialog(false);
      setNewProductName("");
      setNewProductCode("");
      setNewProductPrice("");
      setNewProductDescription("");
      toast.success(`Added bill-only product ${product.name}`);
    } catch (error: any) {
      console.error("Create product failed:", error);
      toast.error(error.message || "Failed to create bill-only product");
    } finally {
      setIsCreatingProduct(false);
    }
  };

  const openQuickAddProductDialog = (draftName: string = "") => {
    setNewProductName(draftName.trim());
    setNewProductCode("");
    setNewProductPrice("");
    setNewProductDescription("");
    setShowAddProductDialog(true);
  };

  // Patient lookup goes through React Query's cache. Both the search fired while
  // typing (on the 10th digit) and the one on Enter call this with the same
  // queryKey, so React Query dedupes them into a single request and serves the
  // result from cache within staleTime — pressing Enter no longer waits on a
  // second round-trip. A failed request returns [] (and isn't cached as data).
  const fetchPatients = async (
    phoneValue: string,
  ): Promise<PatientSearchResult[]> => {
    if (phoneValue.length < 10 || !token || !activeBranch) return [];
    try {
      return await queryClient.fetchQuery<PatientSearchResult[]>({
        queryKey: ["patientSearch", "diagnostic", activeBranch.id, phoneValue],
        queryFn: async ({ signal }) => {
          const res = await fetch(
            `${API_BASE}/patients/search?phone=${phoneValue}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "X-Branch-Id": activeBranch.id,
              },
              signal,
            },
          );
          if (!res.ok) throw new Error("Patient search failed");
          return (await res.json()) as PatientSearchResult[];
        },
        staleTime: 10_000,
        retry: 1,
      });
    } catch (error) {
      console.error("Search failed:", error);
      return [];
    }
  };

  // Search patients via API (Search button / explicit lookup).
  const handleSearch = async (): Promise<PatientSearchResult[]> => {
    const results = await fetchPatients(phone);
    setMatchingPatients(results);
    setSelectedPatient(null);
    setShowNewPatientForm(false);
    return results;
  };

  const handlePhoneChange = async (value: string) => {
    setPhone(value);
    setMatchingPatients(value.length === 10 ? await fetchPatients(value) : []);
  };

  const handleCreateNewPatient = () => {
    setShowNewPatientForm(true);
    setSelectedPatient(null);
    // Focus the Title field once the new-patient form has committed (step 21).
    goToStep(21);
  };

  const handleSelectPatient = (result: PatientSearchResult) => {
    setSelectedPatient(result.patient);
    setShowNewPatientForm(false);
    // Auto-check WhatsApp opt-in if patient already opted in
    setWhatsappOptIn((result.patient as any).whatsappOptIn ?? true);
    // Focus the test search input once the Select Tests card has committed (step 30).
    goToStep(30);
  };

  const totalAmount = selectedProducts.reduce((sum, prodId) => {
    const product = products.find((p) => p.id === prodId);
    return sum + (product?.effectivePrice ?? 0);
  }, 0);
  const discountNumeric =
    discountValue.trim() === "" ? 0 : Number(discountValue);
  const safeDiscountNumeric = Number.isFinite(discountNumeric)
    ? Math.max(0, discountNumeric)
    : 0;
  const discountAmount =
    discountMode === "PERCENTAGE"
      ? Math.round(
          ((totalAmount * Math.min(safeDiscountNumeric, 100)) / 100) * 100,
        ) / 100
      : discountMode === "FLAT_AMOUNT"
        ? Math.min(safeDiscountNumeric, totalAmount)
        : 0;
  const netPayable = Math.max(0, totalAmount - discountAmount);
  const paidNumeric =
    paidAmount.trim() === "" ? netPayable : Number(paidAmount);
  const safePaidAmount = Number.isFinite(paidNumeric)
    ? Math.max(0, paidNumeric)
    : 0;
  const dueAmount = Math.max(0, netPayable - safePaidAmount);
  const formatMoney = (value: number) =>
    `₹${value.toLocaleString("en-IN", {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;

  // --- Keyboard-flow validation gating -------------------------------------
  // Enter advances only when the current field is valid, so the operator can't
  // silently skip past a required/invalid field and only discover it at Submit.
  // Each validator returns true when valid; when invalid it surfaces the same
  // error (inline or toast) the Submit handler would and returns false.
  const flowGuard =
    (validate: () => boolean) => (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.repeat) return; // ignore key auto-repeat
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

  // Reuse the canonical patient rules; gate only on the named field's error.
  const guardPatientField = (key: "name" | "age" | "gender") => () => {
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

  const guardDiscountValue = () => {
    if (discountMode === "PERCENTAGE" && safeDiscountNumeric > 100) {
      toast.error("Discount percentage cannot exceed 100%");
      return false;
    }
    if (discountMode === "FLAT_AMOUNT" && safeDiscountNumeric > totalAmount) {
      toast.error("Discount cannot exceed total amount");
      return false;
    }
    return true;
  };

  const guardDiscountReason = () => {
    if (
      discountMode !== "NONE" &&
      safeDiscountNumeric > 0 &&
      discountReason.trim() === ""
    ) {
      toast.error("A reason must be provided when applying a discount");
      return false;
    }
    return true;
  };

  const guardPaidAmount = () => {
    if (safePaidAmount > netPayable) {
      toast.error("Paid amount cannot exceed net payable");
      return false;
    }
    return true;
  };

  // Single source of truth for synchronous bill validation. Gates the confirm
  // dialog and is re-checked inside handleSubmit (defense in depth).
  const runBillValidation = (): boolean => {
    if (!token || !activeBranch) {
      toast.error("Not authenticated");
      return false;
    }
    if (showNewPatientForm && !selectedPatient) {
      const errors = validatePatientForm({
        name: newPatient.name,
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
    if (selectedProducts.length === 0) {
      toast.error("Please select at least one test");
      return false;
    }
    if (
      discountMode !== "NONE" &&
      safeDiscountNumeric > 0 &&
      discountReason.trim() === ""
    ) {
      toast.error("A reason must be provided when applying a discount");
      return false;
    }
    if (discountMode === "PERCENTAGE" && safeDiscountNumeric > 100) {
      toast.error("Discount percentage cannot exceed 100%");
      return false;
    }
    if (discountMode === "FLAT_AMOUNT" && safeDiscountNumeric > totalAmount) {
      toast.error("Discount cannot exceed total amount");
      return false;
    }
    if (safePaidAmount > netPayable) {
      toast.error("Paid amount cannot exceed net payable");
      return false;
    }
    return true;
  };

  // Keyboard flow's terminal action: validate, then open the confirm dialog.
  const openConfirmBill = () => {
    if (runBillValidation()) setShowConfirmDialog(true);
  };

  // Terminal-field key handler: advance to the next field if one still needs
  // input, otherwise open the confirm dialog.
  const flowKeyOrConfirm = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.repeat) return;
    const step = Number((e.currentTarget as HTMLElement).dataset.focusStep);
    if (e.key === "Escape") {
      e.preventDefault();
      goToPrev(step);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (hasNextStep(step)) goToNext(step);
    else openConfirmBill();
  };

  const handleSubmit = async () => {
    // Validation lives in runBillValidation (also gates the confirm dialog).
    if (!runBillValidation()) return;
    if (!token || !activeBranch) return;

    let patient = selectedPatient;

    // Create new patient if needed
    if (showNewPatientForm && !selectedPatient) {
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
            age: newPatient.age ? parseInt(newPatient.age) : undefined, // E2-09: Age optional if DOB provided
            ageUnit: newPatient.ageUnit, // Smart age unit
            dateOfBirth: newPatient.dateOfBirth
              ? newPatient.dateOfBirth.split("T")[0]
              : undefined, // E2-09: Send date-only (YYYY-MM-DD)
            gender: newPatient.gender,
            identifiers: [{ type: "PHONE", value: phone, isPrimary: true }],
            whatsappOptIn: newPatient.whatsappOptIn,
          }),
        });

        if (res.status === 409) {
          // E2-03: Potential duplicate detected
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
            // Use existing patient. Carry through ageDisplay/ageUnit so the
            // bill receipt renders the smart age string instead of falling
            // back to "N/A" (the receipt prefers ageDisplay over numeric age).
            patient = {
              id: existing.id,
              patientNumber: existing.patientNumber,
              name: existing.name,
              title: existing.title,
              age: existing.age,
              ageUnit: existing.ageUnit,
              ageDisplay: existing.ageDisplay,
              yearOfBirth: existing.yearOfBirth,
              dateOfBirth: existing.dateOfBirth,
              gender: existing.gender,
              identifiers: existing.identifiers || [],
              createdAt: existing.createdAt || new Date(),
            };
            toast.success(`Using existing patient ${existing.patientNumber}`);
          } else {
            // User wants to force create duplicate - retry with forceDuplicate flag
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
                age: newPatient.age ? parseInt(newPatient.age) : undefined, // E2-09: Age optional if DOB provided
                ageUnit: newPatient.ageUnit, // Smart age unit
                dateOfBirth: newPatient.dateOfBirth
                  ? newPatient.dateOfBirth.split("T")[0]
                  : undefined, // E2-09: Send date-only (YYYY-MM-DD)
                gender: newPatient.gender,
                identifiers: [{ type: "PHONE", value: phone, isPrimary: true }],
                whatsappOptIn: newPatient.whatsappOptIn,
                forceDuplicate: true, // E2-03: Explicit user confirmation
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

    setIsSubmitting(true);

    try {
      // Create diagnostic visit via API
      const res = await fetch(`${API_BASE}/visits/diagnostic`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Branch-Id": activeBranch.id,
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
                      toReferralPayoutDraft(
                        getEffectiveDoctorPayout(selectedDoctor, productId),
                      );
                    const savedPayout = getEffectiveDoctorPayout(
                      selectedDoctor,
                      productId,
                    );
                    return {
                      productId,
                      payload: toReferralPayoutPayload(draft),
                      hasChanged: !areReferralPayoutsEqual(draft, savedPayout),
                    };
                  })
                  .filter((item) => item.hasChanged)
                  .map((item) => [item.productId, item.payload]),
              )
            : undefined,
          diagnosticCenterOverrides: selectedCenterId
            ? Object.fromEntries(
                selectedProducts
                  .map((productId) => {
                    const draft =
                      diagnosticCenterOverrides[productId] ??
                      toReferralPayoutDraft(
                        getEffectiveDiagnosticCenterPayout(
                          selectedCenter,
                          productId,
                        ),
                      );
                    const savedPayout = getEffectiveDiagnosticCenterPayout(
                      selectedCenter,
                      productId,
                    );
                    return {
                      productId,
                      payload: toReferralPayoutPayload(draft),
                      hasChanged: !areReferralPayoutsEqual(draft, savedPayout),
                    };
                  })
                  .filter((item) => item.hasChanged)
                  .map((item) => [item.productId, item.payload]),
              )
            : undefined,
          productIds: selectedProducts,
          ...(paymentMode === "SPLIT"
            ? {
                payments: [
                  { type: "CASH", amount: splitAmounts.cash },
                  { type: "ONLINE", amount: splitAmounts.online },
                ],
                paymentType: "SPLIT",
              }
            : {
                payments: [{ type: paymentMode, amount: safePaidAmount }],
                paymentType: paymentMode,
              }),
          discountReason: discountMode === "NONE" ? undefined : discountReason,
          discountType: discountMode === "NONE" ? undefined : discountMode,
          discountValue:
            discountMode === "NONE" ? undefined : safeDiscountNumeric,
          paidAmount: safePaidAmount,
          sendWhatsApp: showNewPatientForm
            ? newPatient.whatsappOptIn
            : whatsappOptIn,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to create visit");
      }

      const visit = await res.json();
      const referralDoctor = selectedDoctorId ? selectedDoctor : undefined;
      const apiBillItems: BillReceiptItem[] | undefined = Array.isArray(
        visit.billItems,
      )
        ? visit.billItems.map((item: any) => ({
            id: item.id,
            name: item.name,
            price: item.price,
            referralType: item.referralType ?? item.referralCommissionType,
            referralPercent:
              item.referralPercent ?? item.referralCommissionPercent,
            referralAmountInPaise:
              item.referralAmountInPaise ??
              item.referralCommissionAmountInPaise,
          }))
        : undefined;
      const fallbackBillItems: BillReceiptItem[] = selectedProducts.map(
        (prodId, index) => {
          const product = products.find((p) => p.id === prodId)!;
          const payoutDraft =
            referralOverrides[prodId] ??
            toReferralPayoutDraft(
              getEffectiveDoctorPayout(selectedDoctor, prodId),
            );
          const payoutPayload = selectedDoctorId
            ? toReferralPayoutPayload(payoutDraft)
            : undefined;

          return {
            id: product.id || `${visit.id}-bill-item-${index}`,
            name: product.name,
            price: product.effectivePrice,
            referralType: payoutPayload?.commissionType,
            referralPercent: payoutPayload?.commissionPercent,
            referralAmountInPaise:
              payoutPayload?.commissionType === "FIXED_AMOUNT"
                ? Math.round((payoutPayload.commissionAmount ?? 0) * 100)
                : undefined,
          };
        },
      );

      // Calculate total amount in paise from selected products
      const totalAmountInPaise =
        typeof visit.totalAmount === "number"
          ? Math.round(visit.totalAmount * 100)
          : Math.round(
              selectedProducts.reduce((sum, prodId) => {
                const product = products.find((p) => p.id === prodId);
                return sum + (product?.effectivePrice ?? 0) * 100;
              }, 0),
            );

      // Use test orders from backend response if available, otherwise build from products
      const testOrders: TestOrder[] =
        visit.testOrders ??
        selectedProducts.map((prodId, index) => {
          const product = products.find((p) => p.id === prodId)!;
          const payoutDraft =
            referralOverrides[prodId] ??
            toReferralPayoutDraft(
              getEffectiveDoctorPayout(selectedDoctor, prodId),
            );
          const payoutPayload = selectedDoctorId
            ? toReferralPayoutPayload(payoutDraft)
            : undefined;
          return {
            id: `${visit.id}-to-${index}`,
            visitId: visit.id,
            productId: product.id,
            workflowMode: product.workflowMode,
            testName: product.name,
            testCode: product.code,
            priceInPaise: Math.round(product.effectivePrice * 100),
            referenceRange: { min: 0, max: 0, unit: "" },
            referralCommissionType: payoutPayload?.commissionType,
            referralCommissionPercent: payoutPayload?.commissionPercent,
            referralCommissionAmountInPaise:
              payoutPayload?.commissionType === "FIXED_AMOUNT"
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
          domain: "DIAGNOSTICS",
          totalAmountInPaise,
          paymentType: paymentMode === "SPLIT" ? "SPLIT" : paymentMode,
          paymentStatus:
            visit.paymentStatus ??
            (visit.dueAmountInPaise > 0 ? "PENDING" : "PAID"),
          discountType: visit.discountType ?? null,
          discountPercentage: visit.discountPercentage ?? null,
          discountAmountInPaise: visit.discountAmountInPaise ?? 0,
          paidAmountInPaise: visit.paidAmountInPaise ?? totalAmountInPaise,
          netAmountInPaise: visit.netAmountInPaise ?? totalAmountInPaise,
          dueAmountInPaise: visit.dueAmountInPaise ?? 0,
          hasBill: visit.hasBill ?? true,
          hasReportableOrders: visit.hasReportableOrders,
          hasBillOnlyOrders: visit.hasBillOnlyOrders,
          hasExternalUploadOrders: visit.hasExternalUploadOrders,
          hasReportInclusionOrders: visit.hasReportInclusionOrders,
          hasEntryScreenOrders: visit.hasEntryScreenOrders,
          hasFinalizedReport: visit.hasFinalizedReport,
          nextAction: visit.nextAction,
          status: visit.status,
          createdAt: new Date(visit.createdAt),
          updatedAt: new Date(visit.createdAt),
        },
        patient,
        testOrders,
        billItems: apiBillItems ?? fallbackBillItems,
        referralDoctor,
        results: [],
      };

      toast.success("Visit created successfully!");

      // Show WhatsApp notification toast
      const patientPhone =
        selectedPatient?.identifiers?.find((i: any) => i.type === "PHONE")
          ?.value || phone;
      const optedIn = showNewPatientForm
        ? newPatient.whatsappOptIn
        : whatsappOptIn;
      if (patientPhone && optedIn) {
        // Auto opt-in for existing patient if checked
        if (selectedPatient && !showNewPatientForm && whatsappOptIn) {
          try {
            await fetch(`${API_BASE}/patients/${patient!.id}`, {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ whatsappOptIn: true }),
            });
          } catch (_) {
            /* non-blocking */
          }
        }
        setTimeout(() => {
          toast("\ud83d\udcf1 Bill confirmation will be sent via WhatsApp", {
            description: `To ${patientPhone}`,
            duration: 4000,
          });
        }, 500);
      }

      setSuccessData({ visitView });
      setBillLogoLoaded(false);
      setShowConfirmDialog(false);
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
    return (
      <AppLayout context="diagnostics">
        <div className="max-w-2xl mx-auto animate-fade-in print:hidden">
          <Card className="border-success/30 bg-success/5">
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-16 w-16 text-success mx-auto" />
                <h2 className="text-2xl font-bold">
                  Visit Created Successfully!
                </h2>

                <div className="bg-card rounded-lg p-4 space-y-2 text-left">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">Bill #:</span>
                    <span className="font-mono font-bold">
                      {successData.visitView.visit.billNumber}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">
                      Payment Status:
                    </span>
                    <StatusBadge
                      status={
                        successData.visitView.visit.paymentStatus || "PENDING"
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">Final Total:</span>
                    <span className="font-semibold">
                      {formatMoney(
                        (successData.visitView.visit.netAmountInPaise ??
                          successData.visitView.visit.totalAmountInPaise) / 100,
                      )}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground">Due:</span>
                    <span
                      className={
                        successData.visitView.visit.dueAmountInPaise
                          ? "font-semibold text-amber-700"
                          : "font-semibold"
                      }
                    >
                      {formatMoney(
                        (successData.visitView.visit.dueAmountInPaise ?? 0) /
                          100,
                      )}
                    </span>
                  </div>
                  {(() => {
                    const v = successData.visitView.visit;
                    const inclusion =
                      v.hasReportInclusionOrders ??
                      (v.hasReportableOrders || v.hasExternalUploadOrders);
                    return (
                      <>
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <span className="text-muted-foreground">Visit Status:</span>
                          <span className="text-sm font-medium">
                            {inclusion
                              ? v.hasExternalUploadOrders && !v.hasReportableOrders
                                ? "Waiting for external report upload"
                                : "Waiting for results entry"
                              : "Completed at billing"}
                          </span>
                        </div>
                        {!inclusion && (
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-muted-foreground">
                              Report Flow:
                            </span>
                            <span className="text-sm font-medium">
                              No report workflow for bill-only items
                            </span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {successData.visitView.referralDoctor && (
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-muted-foreground">
                        Referred By:
                      </span>
                      <span>{successData.visitView.referralDoctor.name}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:justify-center">
                  <Button
                    className="w-full sm:w-auto"
                    variant="outline"
                    onClick={handlePrint}
                    disabled={!billLogoLoaded}
                  >
                    <Printer className="mr-2 h-4 w-4" />
                    {billLogoLoaded ? "Print Bill" : "Preparing Print..."}
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setSuccessData(null);
                      // Drop cached searches so a just-registered patient shows
                      // up if the same number is looked up again.
                      queryClient.invalidateQueries({
                        queryKey: ["patientSearch"],
                      });
                      setPhone("");
                      setMatchingPatients([]);
                      setSelectedPatient(null);
                      setSelectedProducts([]);
                      setDiscountMode("NONE");
                      setDiscountValue("");
                      setDiscountReason("");
                      setDiscountReason("");
                      setPaidAmount("");
                      setShowNewPatientForm(false);
                      setSelectedDoctorId("");
                      setReferralOverrides({});
                      setDiagnosticCenterOverrides({});
                      setSelectedCenterId("");
                      setPaymentMode(
                        useVisitDefaults.getState().lastDiagPaymentMode,
                      );
                      setSplitAmounts({ cash: 0, online: 0 });
                      setNewPatient({
                        name: "",
                        age: "",
                        ageUnit: "YEARS",
                        dateOfBirth: "",
                        gender: "M",
                        whatsappOptIn: true,
                      }); // E2-09: Reset form
                      setValidationErrors({});
                      // Re-focus phone input after reset
                      setTimeout(() => phoneInputRef.current?.focus(), 150);
                    }}
                  >
                    Create Another Visit
                  </Button>
                  {(successData.visitView.visit.hasReportInclusionOrders
                    ?? (successData.visitView.visit.hasReportableOrders
                      || successData.visitView.visit.hasExternalUploadOrders)) ? (
                    <Button
                      className="w-full sm:w-auto"
                      variant="outline"
                      onClick={() => navigate("/diagnostics/pending")}
                    >
                      View Pending Results
                    </Button>
                  ) : (
                    <Button
                      className="w-full sm:w-auto"
                      variant="outline"
                      onClick={() => navigate("/")}
                    >
                      Back to Dashboard
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Print Content */}
        <div ref={printRef} className="hidden print:block">
          <BillReceipt
            onLogoLoadedChange={setBillLogoLoaded}
            data={mapDiagnosticsVisitViewToReceiptData(
              successData.visitView,
              activeBranch?.name,
            )}
          />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="diagnostics">
      {ConfirmDialog}
      <div className="max-w-[760px] mx-auto space-y-4 pb-24 animate-fade-in">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-semibold">New Diagnostic Visit</h1>
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

        {/* Patient Lookup */}
        <Card>
          <CardHeader className="px-5 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient Lookup</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-3 space-y-3">
            <div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number *</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    ref={phoneInputRef}
                    id="phone"
                    placeholder="Enter 10-digit phone"
                    value={phone}
                    onChange={(e) =>
                      handlePhoneChange(
                        e.target.value.replace(/\D/g, "").slice(0, 10),
                      )
                    }
                    onKeyDown={async (e) => {
                      if (e.repeat || e.key !== 'Enter') return;
                      e.preventDefault();
                      if (phone.length < 10) return;
                      // Search, then branch on the FRESH result (handleSearch
                      // returns the matches) — no stale closure / setTimeout race.
                      const matches = await handleSearch();
                      if (matches.length === 1) {
                        // Exactly one match: select it and skip the list step.
                        handleSelectPatient(matches[0]);
                      } else if (matches.length > 1) {
                        // Several matches: land on the list to pick one.
                        setHighlightedPatientIndex(0);
                        goToStep(20);
                      } else {
                        // New patient: skip the (empty) list and start at Title.
                        handleCreateNewPatient();
                      }
                    }}
                    maxLength={10}
                    autoComplete="off"
                    data-focus-step={10}
                  />
                  <Button
                    className="w-full sm:w-auto"
                    onClick={handleSearch}
                    variant="secondary"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Matching Patients */}
        {(matchingPatients.length > 0 || phone.length === 10) && (
          <Card>
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Matching Patients</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3 space-y-3">
              {/* Keyboard-navigable patient list: Arrow Up/Down to move, Enter to select */}
              <div
                ref={patientListRef}
                tabIndex={0}
                role="listbox"
                aria-label="Matching patients"
                aria-activedescendant={`patient-option-${highlightedPatientIndex}`}
                data-focus-step={20}
                className="space-y-2 outline-none"
                onKeyDown={(e) => {
                  // Total items = patients + 1 (Create New Patient button)
                  const totalItems = matchingPatients.length + 1;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.stopPropagation();
                    setHighlightedPatientIndex((prev) =>
                      prev < totalItems - 1 ? prev + 1 : 0
                    );
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    e.stopPropagation();
                    setHighlightedPatientIndex((prev) =>
                      prev > 0 ? prev - 1 : totalItems - 1
                    );
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (highlightedPatientIndex < matchingPatients.length) {
                      handleSelectPatient(matchingPatients[highlightedPatientIndex]);
                    } else {
                      // Last item = Create New Patient
                      handleCreateNewPatient();
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    goToPrev(20);
                  }
                }}
                onBlur={() => setHighlightedPatientIndex(0)}
              >
                <div className="space-y-2">
                  {matchingPatients.map((result, index) => (
                    <div
                      key={result.patient.id}
                      id={`patient-option-${index}`}
                      className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedPatient?.id === result.patient.id
                          ? "border-primary bg-accent"
                          : highlightedPatientIndex === index
                            ? "border-primary/50 bg-accent/50 ring-2 ring-primary/30"
                            : "border-border hover:bg-muted"
                      }`}
                      onClick={() => handleSelectPatient(result)}
                      onMouseEnter={() => setHighlightedPatientIndex(index)}
                      role="option"
                      aria-selected={selectedPatient?.id === result.patient.id}
                      aria-posinset={index + 1}
                      aria-setsize={matchingPatients.length + 1}
                    >
                      {/* Visual radio circle — not a button, won't steal Enter */}
                      <div className={`h-4 w-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                        selectedPatient?.id === result.patient.id
                          ? "border-primary"
                          : "border-muted-foreground"
                      }`}>
                        {selectedPatient?.id === result.patient.id && (
                          <div className="h-2 w-2 rounded-full bg-primary" />
                        )}
                      </div>
                      <div className="flex-1">
                        <span className="font-medium">{formatPatientName(result.patient.name, (result.patient as any).title)}</span>
                        <span className="text-muted-foreground ml-2">
                          |{" "}
                          {result.patient.ageDisplay ||
                            `${result.patient.age} Years`}{" "}
                          | {result.patient.gender}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <Button
                  id={`patient-option-${matchingPatients.length}`}
                  role="option"
                  aria-selected={false}
                  aria-posinset={matchingPatients.length + 1}
                  aria-setsize={matchingPatients.length + 1}
                  variant="outline"
                  className={`w-full transition-colors ${
                    highlightedPatientIndex === matchingPatients.length
                      ? "ring-2 ring-primary/30 border-primary/50"
                      : ""
                  }`}
                  onClick={handleCreateNewPatient}
                  onMouseEnter={() => setHighlightedPatientIndex(matchingPatients.length)}
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

        {/* New Patient Form */}
        {showNewPatientForm && (
          <Card>
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">New Patient</CardTitle>
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
                      // Title chosen (gender auto-derived) → advance to Name.
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
                    onChange={(e) => {
                      setNewPatient({ ...newPatient, name: e.target.value });
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
                    onValueChange={(v) => {
                      setNewPatient({
                        ...newPatient,
                        gender: v as "M" | "F" | "O",
                      });
                      if (validationErrors.gender) {
                        setValidationErrors({
                          ...validationErrors,
                          gender: undefined,
                        });
                      }
                      // Advance to Age after gender selection
                      goToStep(26);
                    }}
                    className="flex flex-wrap gap-4"
                  >
                    {["M", "F", "O"].map((g) => (
                      <div key={g} className="flex items-center space-x-2">
                        <RadioGroupItem
                          value={g}
                          id={`gender-${g}`}
                          data-focus-step={
                            TITLE_TO_GENDER[newPatient.title] ? undefined : 24
                          }
                          onKeyDown={flowGuard(guardPatientField("gender"))}
                        />
                        <Label htmlFor={`gender-${g}`}>{g}</Label>
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
                      onChange={(e) => {
                        setNewPatient({ ...newPatient, age: e.target.value.replace(/\D/g, "") });
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
                      onValueChange={(v) =>
                        setNewPatient({
                          ...newPatient,
                          ageUnit: v as "DAYS" | "MONTHS" | "YEARS",
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
                    onChange={(e) => {
                      const dob = e.target.value;
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

              {/* Phone validation error */}
              {validationErrors.phone && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-3">
                  <strong>Phone:</strong> {validationErrors.phone}
                </div>
              )}

              {/* WhatsApp opt-in */}
              <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
                <Checkbox
                  id="whatsappOptIn"
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
                  htmlFor="whatsappOptIn"
                  className="flex items-center gap-2 text-sm cursor-pointer"
                >
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
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Select Tests</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3">
              <div ref={testSelectorRef}>
              <ProductSelector
                products={products}
                selectedProductIds={selectedProducts}
                onQuickAddBillOnly={openQuickAddProductDialog}
                onSelectionChange={(productIds) => {
                  setSelectedProducts(productIds);
                  setReferralOverrides((prev) => {
                    if (!selectedDoctor) {
                      return Object.fromEntries(
                        Object.entries(prev).filter(([productId]) =>
                          productIds.includes(productId),
                        ),
                      );
                    }
                    return buildOverridesForProducts(
                      productIds,
                      (productId) =>
                        getEffectiveDoctorPayout(selectedDoctor, productId),
                      prev,
                    );
                  });
                  setDiagnosticCenterOverrides((prev) => {
                    if (!selectedCenter) {
                      return Object.fromEntries(
                        Object.entries(prev).filter(([productId]) =>
                          productIds.includes(productId),
                        ),
                      );
                    }
                    return buildOverridesForProducts(
                      productIds,
                      (productId) =>
                        getEffectiveDiagnosticCenterPayout(
                          selectedCenter,
                          productId,
                        ),
                      prev,
                    );
                  });
                }}
                onDone={() => goToStep(40)}
                focusStep={30}
                disabled={isSubmitting}
              />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Billing */}
        {selectedProducts.length > 0 && (
          <Card>
            <CardHeader className="px-5 pt-4 pb-0">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billing</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-3 space-y-3">
              {/* Referral Doctor */}
              <div className="space-y-3">
                <Label>Referral Doctor (optional)</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <SearchableSelect
                    id="referral-doctor"
                    value={selectedDoctorId}
                    onValueChange={(value) => {
                      setSelectedDoctorId(value);
                      const doctor = referralDoctors.find(
                        (item) => item.id === value,
                      );
                      setReferralOverrides(
                        buildOverridesForProducts(
                          selectedProducts,
                          (productId) =>
                            getEffectiveDoctorPayout(doctor, productId),
                        ),
                      );
                      // Advance to the diagnostic center field after selection.
                      goToStep(50);
                    }}
                    onSkip={() => goToStep(50)}
                    onAdvance={() => goToStep(50)}
                    focusStep={40}
                    options={referralDoctors.map((doctor) => ({
                      value: doctor.id,
                      label: doctor.name,
                      description: [doctor.doctorNumber, doctor.phone]
                        .filter(Boolean)
                        .join(" · "),
                      keywords: [doctor.name, doctor.doctorNumber, doctor.phone]
                        .filter(Boolean)
                        .join(" "),
                    }))}
                    placeholder="Search referral doctor (Enter to skip)"
                    searchPlaceholder="Search by doctor name, phone or number"
                    emptyText="No referral doctors found."
                    ariaLabel="Referral doctor — Enter to skip, Space to open"
                    className="h-11"
                  />
                  {selectedDoctorId && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSelectedDoctorId("");
                        setReferralOverrides({});
                      }}
                    >
                      Clear
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowAddDoctorDialog(true)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                <Label>Diagnostic Referral (optional)</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <SearchableSelect
                    id="diagnostic-center"
                    value={selectedCenterId}
                    onValueChange={(value) => {
                      setSelectedCenterId(value);
                      const center = diagnosticCenters.find(
                        (item) => item.id === value,
                      );
                      setDiagnosticCenterOverrides(
                        buildOverridesForProducts(
                          selectedProducts,
                          (productId) =>
                            getEffectiveDiagnosticCenterPayout(
                              center,
                              productId,
                            ),
                        ),
                      );
                      // Advance to the discount field after selection.
                      goToStep(60);
                    }}
                    onSkip={() => goToStep(60)}
                    onAdvance={() => goToStep(60)}
                    focusStep={50}
                    options={diagnosticCenters.map((center) => ({
                      value: center.id,
                      label: center.name,
                      description: [
                        center.centerNumber,
                        center.contactPerson,
                        center.phone,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      keywords: [
                        center.name,
                        center.centerNumber,
                        center.contactPerson,
                        center.phone,
                      ]
                        .filter(Boolean)
                        .join(" "),
                    }))}
                    placeholder="Search diagnostic center (Enter to skip)"
                    searchPlaceholder="Search by center name, phone or number"
                    emptyText="No diagnostic centers found."
                    ariaLabel="Diagnostic referral center — Enter to skip, Space to open"
                    className="h-11"
                  />
                  {selectedCenterId && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSelectedCenterId("");
                        setDiagnosticCenterOverrides({});
                      }}
                    >
                      Clear
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowAddCenterDialog(true)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {selectedDoctorId && selectedProducts.length > 0 && (
                <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <Label className="text-base">
                        Doctor payout by product
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Saved defaults come from Config Center. Any changes here
                        will be applied to this bill and saved for future bills.
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
                      const savedPayout = getEffectiveDoctorPayout(
                        selectedDoctor,
                        productId,
                      );
                      const draft =
                        referralOverrides[productId] ??
                        toReferralPayoutDraft(savedPayout);
                      return (
                        <div
                          key={productId}
                          className="rounded-lg border bg-background p-4"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-start">
                            <div className="space-y-1">
                              <p className="font-medium">{product.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {product.code} · Config Center:{" "}
                                {formatReferralPayout(savedPayout ?? undefined)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Payout now:{" "}
                                {formatReferralPayout({
                                  commissionType: draft.commissionType,
                                  commissionPercent:
                                    draft.commissionType === "PERCENTAGE"
                                      ? Number(draft.commissionPercent || 0)
                                      : null,
                                  commissionAmountInPaise:
                                    draft.commissionType === "FIXED_AMOUNT"
                                      ? Math.round(
                                          Number(draft.commissionAmount || 0) *
                                            100,
                                        )
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
                                    commissionType:
                                      value as ReferralPayoutDraft["commissionType"],
                                  },
                                }));
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PERCENTAGE">
                                  Percentage
                                </SelectItem>
                                <SelectItem value="FIXED_AMOUNT">
                                  Amount
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <div className="space-y-2">
                              <Input
                                type="number"
                                min={0}
                                max={
                                  draft.commissionType === "PERCENTAGE"
                                    ? 100
                                    : undefined
                                }
                                step={
                                  draft.commissionType === "PERCENTAGE"
                                    ? "0.01"
                                    : "1"
                                }
                                placeholder={
                                  draft.commissionType === "PERCENTAGE"
                                    ? "Enter %"
                                    : "Enter amount"
                                }
                                value={
                                  draft.commissionType === "PERCENTAGE"
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
                                        draft.commissionType === "PERCENTAGE"
                                          ? next
                                          : (prev[productId] ?? draft)
                                              .commissionPercent,
                                      commissionAmount:
                                        draft.commissionType === "FIXED_AMOUNT"
                                          ? next
                                          : (prev[productId] ?? draft)
                                              .commissionAmount,
                                    },
                                  }));
                                }}
                              />
                              <p className="text-xs text-muted-foreground">
                                {draft.commissionType === "PERCENTAGE"
                                  ? "Enter the doctor share as a percentage of this product."
                                  : "Enter the exact rupee amount the doctor should get for this product."}
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
                      <Label className="text-base">
                        External center payout by product
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Saved defaults come from Config Center. Any changes here
                        will be applied to this bill and saved for future bills.
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
                      const savedPayout = getEffectiveDiagnosticCenterPayout(
                        selectedCenter,
                        productId,
                      );
                      const draft =
                        diagnosticCenterOverrides[productId] ??
                        toReferralPayoutDraft(savedPayout);
                      return (
                        <div
                          key={`center-${productId}`}
                          className="rounded-lg border bg-background p-4"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_160px] md:items-start">
                            <div className="space-y-1">
                              <p className="font-medium">{product.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {product.code} · Config Center:{" "}
                                {formatReferralPayout(savedPayout ?? undefined)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Payout now:{" "}
                                {formatReferralPayout({
                                  commissionType: draft.commissionType,
                                  commissionPercent:
                                    draft.commissionType === "PERCENTAGE"
                                      ? Number(draft.commissionPercent || 0)
                                      : null,
                                  commissionAmountInPaise:
                                    draft.commissionType === "FIXED_AMOUNT"
                                      ? Math.round(
                                          Number(draft.commissionAmount || 0) *
                                            100,
                                        )
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
                                    commissionType:
                                      value as ReferralPayoutDraft["commissionType"],
                                  },
                                }));
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PERCENTAGE">
                                  Percentage
                                </SelectItem>
                                <SelectItem value="FIXED_AMOUNT">
                                  Amount
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <div className="space-y-2">
                              <Input
                                type="number"
                                min={0}
                                max={
                                  draft.commissionType === "PERCENTAGE"
                                    ? 100
                                    : undefined
                                }
                                step={
                                  draft.commissionType === "PERCENTAGE"
                                    ? "0.01"
                                    : "1"
                                }
                                placeholder={
                                  draft.commissionType === "PERCENTAGE"
                                    ? "Enter %"
                                    : "Enter amount"
                                }
                                value={
                                  draft.commissionType === "PERCENTAGE"
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
                                        draft.commissionType === "PERCENTAGE"
                                          ? next
                                          : (prev[productId] ?? draft)
                                              .commissionPercent,
                                      commissionAmount:
                                        draft.commissionType === "FIXED_AMOUNT"
                                          ? next
                                          : (prev[productId] ?? draft)
                                              .commissionAmount,
                                    },
                                  }));
                                }}
                              />
                              <p className="text-xs text-muted-foreground">
                                {draft.commissionType === "PERCENTAGE"
                                  ? "Enter the center share as a percentage of this product."
                                  : "Enter the exact rupee amount the external center should get for this product."}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-lg border bg-background px-4 py-5">
                <div className="grid gap-4 text-[15px] md:grid-cols-[170px_minmax(0,1fr)] md:items-center">
                  <div className="font-semibold text-muted-foreground">
                    Total bill
                  </div>
                  <div className="text-2xl font-bold tracking-tight">
                    {formatMoney(totalAmount)}
                  </div>

                  <Label
                    htmlFor="diagnostic-discount-value"
                    className="font-semibold text-muted-foreground"
                  >
                    Discount <span className="text-[10px] ml-2 font-normal">(Enter to skip)</span>
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                    <Select
                      value={discountMode}
                      onValueChange={(value) => {
                        setDiscountMode(value as DiscountMode);
                        setDiscountValue("");
                        setDiscountReason("");
                        // Advance: when NONE the value field is disabled and the
                        // reason is unmounted, so goToNext lands on Received;
                        // otherwise it lands on the discount value field.
                        goToNext(60);
                      }}
                    >
                      <SelectTrigger
                        id="discount-mode-trigger"
                        aria-label="Discount type"
                        data-focus-step={60}
                        onKeyDown={handleFlowKey}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">No discount</SelectItem>
                        <SelectItem value="PERCENTAGE">Percent %</SelectItem>
                        <SelectItem value="FLAT_AMOUNT">Amount ₹</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      id="diagnostic-discount-value"
                      type="text"
                      inputMode="numeric"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      onKeyDown={flowGuard(guardDiscountValue)}
                      data-focus-step={70}
                      placeholder={
                        discountMode === "PERCENTAGE"
                          ? "Enter discount %"
                          : "Enter discount amount"
                      }
                      disabled={discountMode === "NONE"}
                    />
                  </div>
                  {discountMode !== "NONE" && (
                    <>
                      <Label
                        htmlFor="diagnostic-discount-reason"
                        className="font-semibold text-muted-foreground"
                      >
                        Reason
                      </Label>
                      <Input
                        id="diagnostic-discount-reason"
                        placeholder="Reason for discount (Required)"
                        value={discountReason}
                        onChange={(e) => setDiscountReason(e.target.value)}
                        onKeyDown={flowGuard(guardDiscountReason)}
                        data-focus-step={80}
                      />
                    </>
                  )}

                  <Label
                    htmlFor="diagnostic-paid-amount"
                    className="font-semibold text-muted-foreground"
                  >
                    Received
                  </Label>
                  <Input
                    id="diagnostic-paid-amount"
                    type="number"
                    min={0}
                    max={netPayable}
                    step="1"
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    onKeyDown={flowGuard(guardPaidAmount)}
                    placeholder={`Full amount ${formatMoney(netPayable)}`}
                  />
                </div>

                <div className="mt-5 border-t pt-4">
                  <div className="grid gap-3 text-[15px] md:grid-cols-[170px_minmax(0,1fr)] md:items-baseline">
                    <div className="font-semibold text-muted-foreground">
                      Discount applied
                    </div>
                    <div className="font-semibold">
                      -{formatMoney(discountAmount)}
                    </div>

                    <div className="font-semibold text-muted-foreground">
                      Final total
                    </div>
                    <div className="text-xl font-bold">
                      {formatMoney(netPayable)}
                    </div>

                    <div className="font-semibold text-muted-foreground">
                      Due balance
                    </div>
                    <div
                      className={
                        dueAmount > 0
                          ? "text-xl font-bold text-amber-700"
                          : "text-xl font-bold"
                      }
                    >
                      {formatMoney(dueAmount)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Payment Type *</Label>
                <RadioGroup
                  value={paymentMode}
                  onValueChange={(v) => {
                    const mode = v as "CASH" | "ONLINE" | "SPLIT";
                    setPaymentMode(mode);
                    // Remember CASH/ONLINE as the default; SPLIT is a
                    // per-transaction choice (its amounts seed on change).
                    if (mode !== "SPLIT") {
                      useVisitDefaults.getState().setLastDiagPaymentMode(mode);
                    }
                    if (mode === "SPLIT") {
                      setSplitAmounts({
                        cash: Number(paidAmount || netPayable),
                        online: 0,
                      });
                      // Focus the split-cash input once it has rendered (step 110).
                      goToStep(110);
                    }
                  }}
                  onKeyDown={(e) => {
                    // Terminal Enter for the whole payment group: works wherever
                    // focus sits among the radios. SPLIT routes to the amount
                    // inputs; CASH/ONLINE open the confirm dialog.
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
                      data-focus-step={paymentMode === "CASH" ? 100 : undefined}
                    />
                    <Label htmlFor="cash">Cash</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem
                      value="ONLINE"
                      id="online"
                      data-focus-step={paymentMode === "ONLINE" ? 100 : undefined}
                    />
                    <Label htmlFor="online">Online</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem
                      value="SPLIT"
                      id="split"
                      data-focus-step={paymentMode === "SPLIT" ? 100 : undefined}
                    />
                    <Label htmlFor="split">Split</Label>
                  </div>
                </RadioGroup>

                {paymentMode === "SPLIT" && (
                  <div className="flex gap-4 mt-4 w-full">
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
                            online: Math.max(
                              0,
                              Number(paidAmount || netPayable) - cash,
                            ),
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
                            cash: Math.max(
                              0,
                              Number(paidAmount || netPayable) - online,
                            ),
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

              {/* WhatsApp opt-in for existing patients */}
              {selectedPatient && !showNewPatientForm && (
                <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
                  <Checkbox
                    id="existingDiagWhatsappOptIn"
                    checked={whatsappOptIn}
                    onCheckedChange={(checked) =>
                      setWhatsappOptIn(checked === true)
                    }
                    onKeyDown={flowKeyOrConfirm}
                  />
                  <Label
                    htmlFor="existingDiagWhatsappOptIn"
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <MessageCircle className="h-4 w-4 text-green-600" />
                    Send bill confirmation & reports via WhatsApp
                  </Label>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Sticky bill summary + action — appears with the bill, pins to the
            bottom (the Billing card makes the page taller than the viewport). */}
        {selectedProducts.length > 0 && (
          <div className="sticky bottom-0 -mx-4 mt-4 border-t bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 print:hidden">
            <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-x-5 gap-y-1">
            <div className="flex items-center gap-x-5 text-sm tabular-nums">
              <span className="text-muted-foreground">
                Tests{" "}
                <b className="font-semibold text-foreground">
                  {selectedProducts.length}
                </b>
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">
                Total{" "}
                <b className="font-semibold text-foreground">
                  {formatMoney(netPayable)}
                </b>
              </span>
              {dueAmount > 0 && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    Due{" "}
                    <b className="font-semibold text-amber-700">
                      {formatMoney(dueAmount)}
                    </b>
                  </span>
                </>
              )}
            </div>
            <Button
              ref={submitButtonRef}
              size="lg"
              className="ml-auto min-w-[200px]"
              onClick={openConfirmBill}
              disabled={isSubmitting || selectedProducts.length === 0}
            >
              Generate Bill
            </Button>
          </div>
        </div>
        )}
      </div>

      {/* Confirm & generate bill */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => {
            // Focus "Generate Bill" (not the first DOM button) so Enter confirms.
            e.preventDefault();
            confirmButtonRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Confirm Bill</DialogTitle>
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
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tests</span>
              <span className="font-medium">{selectedProducts.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium">{formatMoney(totalAmount)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discount</span>
                <span className="font-medium">-{formatMoney(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2">
              <span className="text-muted-foreground">Net payable</span>
              <span className="font-semibold">{formatMoney(netPayable)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Paid ({paymentMode.toLowerCase()})
              </span>
              <span className="font-medium">{formatMoney(safePaidAmount)}</span>
            </div>
            {dueAmount > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Due</span>
                <span className="font-semibold text-amber-700">
                  {formatMoney(dueAmount)}
                </span>
              </div>
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
              {isSubmitting ? "Creating..." : "Generate Bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-add Bill-Only Product Dialog */}
      <Dialog
        open={showAddProductDialog}
        onOpenChange={setShowAddProductDialog}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Quick Add Bill-Only Item</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="newProductName">Name *</Label>
              <Input
                id="newProductName"
                value={newProductName}
                onChange={(e) => setNewProductName(e.target.value)}
                placeholder="Example: ECG Review / Dressing / External Charge"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newProductCode">Code *</Label>
              <Input
                id="newProductCode"
                value={newProductCode}
                onChange={(e) => setNewProductCode(e.target.value)}
                placeholder="Example: ECG"
                autoCapitalize="characters"
                style={{ textTransform: "uppercase" }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newProductPrice">Price (₹) *</Label>
              <Input
                id="newProductPrice"
                type="number"
                min="0"
                step="0.01"
                value={newProductPrice}
                onChange={(e) => setNewProductPrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newProductDescription">
                Description (optional)
              </Label>
              <Input
                id="newProductDescription"
                value={newProductDescription}
                onChange={(e) => setNewProductDescription(e.target.value)}
                placeholder="Optional note for staff"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This creates a reusable bill-only diagnostics product with a
              server-generated code and adds it to the current visit.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAddProductDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateProduct}
              disabled={
                !newProductName.trim() ||
                !newProductCode.trim() ||
                !newProductPrice ||
                isCreatingProduct
              }
            >
              {isCreatingProduct ? "Adding..." : "Add Item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-add Doctor Dialog */}
      <Dialog open={showAddDoctorDialog} onOpenChange={setShowAddDoctorDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Referral Doctor</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="newDoctorName">Name *</Label>
              <Input
                id="newDoctorName"
                value={newDoctorName}
                onChange={(e) => setNewDoctorName(e.target.value)}
                placeholder="Dr. Name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newDoctorPhone">Phone (optional)</Label>
              <Input
                id="newDoctorPhone"
                value={newDoctorPhone}
                onChange={(e) => setNewDoctorPhone(e.target.value)}
                placeholder="Phone number"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAddDoctorDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateDoctor}
              disabled={!newDoctorName.trim() || isCreatingDoctor}
            >
              {isCreatingDoctor ? "Adding..." : "Add Doctor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-add Center Dialog */}
      <Dialog open={showAddCenterDialog} onOpenChange={setShowAddCenterDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Diagnostic Center</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="newCenterName">Name *</Label>
              <Input
                id="newCenterName"
                value={newCenterName}
                onChange={(e) => setNewCenterName(e.target.value)}
                placeholder="Center name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newCenterPhone">Phone (optional)</Label>
              <Input
                id="newCenterPhone"
                value={newCenterPhone}
                onChange={(e) => setNewCenterPhone(e.target.value)}
                placeholder="Phone number"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAddCenterDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateCenter}
              disabled={!newCenterName.trim() || isCreatingCenter}
            >
              {isCreatingCenter ? "Adding..." : "Add Center"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default DiagnosticsNewVisit;
