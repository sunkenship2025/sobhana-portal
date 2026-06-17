import { useState, useRef, useEffect, useCallback } from "react";
import { API_BASE } from "@/lib/api";
import { useNavigate } from "react-router-dom";
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

type DiscountMode = "NONE" | BillDiscountType;

const DiagnosticsNewVisit = () => {
  const navigate = useNavigate();
  const printRef = useRef<HTMLDivElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const testSelectorRef = useRef<HTMLDivElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
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
  const [billSearch, setBillSearch] = useState("");
  const [matchingPatients, setMatchingPatients] = useState<
    PatientSearchResult[]
  >([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [showNewPatientForm, setShowNewPatientForm] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [paymentMode, setPaymentMode] = useState<"CASH" | "ONLINE" | "SPLIT">(
    "CASH",
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

  // Search patients via API
  const handleSearch = async () => {
    if (phone.length >= 10 && token && activeBranch) {
      try {
        const res = await fetch(`${API_BASE}/patients/search?phone=${phone}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Branch-Id": activeBranch.id,
          },
        });
        if (res.ok) {
          const results = await res.json();
          setMatchingPatients(results);
          setSelectedPatient(null);
          setShowNewPatientForm(false);
        }
      } catch (error) {
        console.error("Search failed:", error);
      }
    }
  };

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
          setMatchingPatients(results);
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
    // Auto-focus the name field when "Create New Patient" is clicked
    setTimeout(() => {
      const nameInput = document.getElementById('name') as HTMLInputElement;
      nameInput?.focus();
    }, 100);
  };

  const handleSelectPatient = (result: PatientSearchResult) => {
    setSelectedPatient(result.patient);
    setShowNewPatientForm(false);
    // Auto-check WhatsApp opt-in if patient already opted in
    setWhatsappOptIn((result.patient as any).whatsappOptIn ?? true);
    // Auto-focus test search input after selecting a patient
    setTimeout(() => {
      focusTestSelector();
    }, 150);
  };

  // Helper to focus the test search input inside the ProductSelector
  const focusTestSelector = useCallback(() => {
    if (testSelectorRef.current) {
      const searchInput = testSelectorRef.current.querySelector('input[type="text"]') as HTMLInputElement;
      searchInput?.focus();
      testSelectorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

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

  const handleSubmit = async () => {
    if (!token || !activeBranch) {
      toast.error("Not authenticated");
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
        toast.error("Please fix validation errors before submitting");
        return;
      }

      if (!newPatient.name || (!newPatient.age && !newPatient.dateOfBirth)) {
        // E2-09: Accept either age or DOB
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

          const userConfirm = window.confirm(
            `⚠️ Potential Duplicate Detected\n\n` +
              `Existing Patient: ${existing.patientNumber}\n` +
              `Name: ${formatPatientName(existing.name, existing.title)}\n` +
              `Age: ${existing.ageDisplay || existing.age}, Gender: ${existing.gender}\n` +
              `Phone: ${existing.phone}\n\n` +
              `This looks like the same person. Do you want to:\n` +
              `• Click OK to USE EXISTING patient\n` +
              `• Click Cancel to CREATE NEW patient anyway`,
          );

          if (userConfirm) {
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

    if (selectedProducts.length === 0) {
      toast.error("Please select at least one test");
      return;
    }

    if (
      discountMode !== "NONE" &&
      safeDiscountNumeric > 0 &&
      discountReason.trim() === ""
    ) {
      toast.error("A reason must be provided when applying a discount");
      return;
    }

    if (discountMode === "PERCENTAGE" && safeDiscountNumeric > 100) {
      toast.error("Discount percentage cannot exceed 100%");
      return;
    }

    if (discountMode === "FLAT_AMOUNT" && safeDiscountNumeric > totalAmount) {
      toast.error("Discount cannot exceed total amount");
      return;
    }

    if (safePaidAmount > netPayable) {
      toast.error("Paid amount cannot exceed net payable");
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
                      setPaymentMode("CASH");
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
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">New Diagnostic Visit</h1>
          <p className="text-muted-foreground">
            Register a patient for lab tests and generate a bill.
          </p>
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (phone.length >= 10) {
                          handleSearch();
                          // Focus the patient list container for arrow key navigation
                          setTimeout(() => {
                            if (matchingPatients.length > 0) {
                              setHighlightedPatientIndex(0);
                              patientListRef.current?.focus();
                            } else {
                              const billInput = document.getElementById('bill') as HTMLInputElement;
                              billInput?.focus();
                            }
                          }, 300);
                        }
                      }
                    }}
                    maxLength={10}
                    autoComplete="off"
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
              <div className="space-y-2">
                <Label htmlFor="bill">Bill Number (optional)</Label>
                <Input
                  id="bill"
                  placeholder="D-XXXXX"
                  value={billSearch}
                  onChange={(e) => setBillSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      // Move focus to matching patients area or stay
                      if (matchingPatients.length > 0) {
                        const firstPatient = document.querySelector('[data-radix-collection-item]') as HTMLElement;
                        firstPatient?.focus();
                      }
                    }
                  }}
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
              {/* Keyboard-navigable patient list: Arrow Up/Down to move, Enter to select */}
              <div
                ref={patientListRef}
                tabIndex={0}
                role="listbox"
                aria-label="Matching patients"
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
                  }
                }}
              >
                <div className="space-y-2">
                  {matchingPatients.map((result, index) => (
                    <div
                      key={result.patient.id}
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
            <CardHeader>
              <CardTitle>New Patient</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Row 1: Title + Name */}
              <div className="grid gap-4 md:grid-cols-3">
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const ageInput = document.getElementById('age') as HTMLInputElement;
                        ageInput?.focus();
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
                    }}
                    className="flex flex-wrap gap-4"
                  >
                    {["M", "F", "O"].map((g) => (
                      <div key={g} className="flex items-center space-x-2">
                        <RadioGroupItem value={g} id={`gender-${g}`} />
                        <Label htmlFor={`gender-${g}`}>{g}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                  {validationErrors.gender && (
                    <p className="text-sm text-red-500">
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          // Skip to test selector since gender already has a default
                          focusTestSelector();
                        }
                      }}
                      className={`flex-1 ${validationErrors.age ? "border-red-500" : ""}`}
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
                  />
                  <p className="text-xs text-gray-500">
                    If DOB is entered, age will be calculated automatically
                  </p>
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
                    setNewPatient({
                      ...newPatient,
                      whatsappOptIn: checked === true,
                    })
                  }
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
            <CardHeader>
              <CardTitle>Select Tests</CardTitle>
            </CardHeader>
            <CardContent>
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
                onDone={() => {
                  document.getElementById('referral-doctor')?.focus();
                }}
                disabled={isSubmitting}
              />
              </div>
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
                      // Auto-focus next field after selection
                      setTimeout(() => document.getElementById('diagnostic-center')?.focus(), 150);
                    }}
                    onSkip={() => document.getElementById('diagnostic-center')?.focus()}
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
                    placeholder="Search referral doctor (Shift+Enter to skip)"
                    searchPlaceholder="Search by doctor name, phone or number"
                    emptyText="No referral doctors found."
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
                      // Auto-focus next field after selection
                      setTimeout(() => document.getElementById('discount-mode-trigger')?.focus(), 150);
                    }}
                    onSkip={() => document.getElementById('discount-mode-trigger')?.focus()}
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
                    placeholder="Search diagnostic center (Shift+Enter to skip)"
                    searchPlaceholder="Search by center name, phone or number"
                    emptyText="No diagnostic centers found."
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
                    Discount <span className="text-[10px] ml-2 font-normal">(Shift+Enter to skip)</span>
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
                    <Select
                      value={discountMode}
                      onValueChange={(value) => {
                        setDiscountMode(value as DiscountMode);
                        setDiscountValue("");
                        setDiscountReason("");
                        // Auto-focus the next relevant field based on discount mode
                        setTimeout(() => {
                          if (value === "NONE") {
                            document.getElementById('diagnostic-paid-amount')?.focus();
                          } else {
                            document.getElementById('diagnostic-discount-value')?.focus();
                          }
                        }, 150);
                      }}
                    >
                      <SelectTrigger 
                        id="discount-mode-trigger" 
                        aria-label="Discount type"
                        onKeyDown={(e) => {
                          if (e.shiftKey && e.key === 'Enter') {
                            e.preventDefault();
                            if (discountMode === "NONE") {
                              document.getElementById('diagnostic-paid-amount')?.focus();
                            } else {
                              document.getElementById('diagnostic-discount-value')?.focus();
                            }
                          }
                        }}
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          document.getElementById('diagnostic-discount-reason')?.focus();
                        }
                      }}
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
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            document.getElementById('diagnostic-paid-amount')?.focus();
                          }
                        }}
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const activeRadio = document.getElementById(paymentMode.toLowerCase());
                        if (activeRadio) {
                          activeRadio.focus();
                        } else {
                          submitButtonRef.current?.focus();
                        }
                      }
                    }}
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
                    setPaymentMode(v as any);
                    if (v === "SPLIT") {
                      setSplitAmounts({
                        cash: Number(paidAmount || netPayable),
                        online: 0,
                      });
                      setTimeout(() => {
                        const cashInput = document.getElementById('split-cash') as HTMLInputElement;
                        if (cashInput) {
                          cashInput.focus();
                          cashInput.select(); // Highlight the text
                        }
                      }, 100);
                    }
                  }}
                  className="flex gap-6"
                  orientation="horizontal"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem 
                      value="CASH" 
                      id="cash" 
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          submitButtonRef.current?.focus();
                        } else if (e.key === 'ArrowDown') {
                          const nextEl = document.getElementById('existingDiagWhatsappOptIn');
                          if (nextEl) {
                            e.preventDefault();
                            nextEl.focus();
                          }
                        }
                      }}
                    />
                    <Label htmlFor="cash">Cash</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem 
                      value="ONLINE" 
                      id="online" 
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          submitButtonRef.current?.focus();
                        } else if (e.key === 'ArrowDown') {
                          const nextEl = document.getElementById('existingDiagWhatsappOptIn');
                          if (nextEl) {
                            e.preventDefault();
                            nextEl.focus();
                          }
                        }
                      }}
                    />
                    <Label htmlFor="online">Online</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem 
                      value="SPLIT" 
                      id="split" 
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          // Needs a slight delay because the split inputs render conditionally
                          setTimeout(() => {
                            document.getElementById('split-cash')?.focus();
                          }, 100);
                        } else if (e.key === 'ArrowDown') {
                          const nextEl = document.getElementById('existingDiagWhatsappOptIn');
                          if (nextEl) {
                            e.preventDefault();
                            nextEl.focus();
                          }
                        }
                      }}
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
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const onlineInput = document.getElementById('split-online') as HTMLInputElement;
                            if (onlineInput) {
                              onlineInput.focus();
                              onlineInput.select();
                            }
                          } else if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) {
                            e.preventDefault();
                            const onlineInput = document.getElementById('split-online') as HTMLInputElement;
                            if (onlineInput) {
                              onlineInput.focus();
                              onlineInput.select();
                            }
                          }
                        }}
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
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            submitButtonRef.current?.focus();
                          } else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) {
                            e.preventDefault();
                            const cashInput = document.getElementById('split-cash') as HTMLInputElement;
                            if (cashInput) {
                              cashInput.focus();
                              cashInput.select();
                            }
                          }
                        }}
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitButtonRef.current?.focus();
                      }
                    }}
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

              <Button
                ref={submitButtonRef}
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Creating...' : 'Generate Bill & Create Visit'}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

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
