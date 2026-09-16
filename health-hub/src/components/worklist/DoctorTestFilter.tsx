import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  useApiQuery,
  useBranchId,
  apiCall,
  branchRequest,
  qk,
} from "@/lib/query";
import { formatRefDoctor } from "@/lib/patientDisplay";

/** Value meaning "no filter" — shared so the pages read the same word. */
export const ANY = "all";

interface DoctorLite {
  id: string;
  name: string;
}
interface ProductLite {
  id: string;
  name: string;
  code?: string;
}

interface DoctorTestFilterProps {
  doctorId: string;
  onDoctorChange: (id: string) => void;
  productId: string;
  onProductChange: (id: string) => void;
  /** Width class for both triggers, to match each page's layout. */
  triggerClassName?: string;
}

/**
 * The "Referred by" + "Test" filters shared by the diagnostics worklists.
 * Renders as flex-row siblings (a fragment) next to DateRangeFilter/Search, and
 * reuses the type-to-search picker from the New Visit form — the doctor and
 * catalogue lists are long, so a plain dropdown would be unusable.
 *
 * Options come from the same cached master lists New Visit downloads (shared
 * query keys), not from the rows on screen: the Finalized list is paginated
 * server-side, so the visible page is never the full option set.
 */
export function DoctorTestFilter({
  doctorId,
  onDoctorChange,
  productId,
  onProductChange,
  triggerClassName = "w-full sm:w-[200px]",
}: DoctorTestFilterProps) {
  const branchId = useBranchId();

  const { data: doctors = [] } = useApiQuery<DoctorLite[]>({
    queryKey: qk.referralDoctors(),
    queryFn: () => apiCall<DoctorLite[]>("/referral-doctors"),
    staleTime: 5 * 60_000,
  });

  const { data: products = [] } = useApiQuery<ProductLite[]>({
    branchScoped: true,
    queryKey: qk.billableProducts(branchId),
    queryFn: () => branchRequest<ProductLite[]>("/billable-products", branchId!),
    staleTime: 5 * 60_000,
  });

  const doctorOptions = useMemo(
    () => [
      { value: ANY, label: "All doctors" },
      ...doctors.map((d) => ({ value: d.id, label: formatRefDoctor(d.name) })),
    ],
    [doctors],
  );

  const testOptions = useMemo(
    () => [
      { value: ANY, label: "All tests" },
      ...products.map((p) => ({
        value: p.id,
        label: p.name,
        keywords: p.code,
      })),
    ],
    [products],
  );

  return (
    <>
      <div className="space-y-2">
        <Label>Referred by</Label>
        <SearchableSelect
          value={doctorId}
          onValueChange={onDoctorChange}
          options={doctorOptions}
          placeholder="All doctors"
          searchPlaceholder="Search doctors..."
          emptyText="No doctors found."
          ariaLabel="Filter by referring doctor"
          className={triggerClassName}
        />
      </div>
      <div className="space-y-2">
        <Label>Test</Label>
        <SearchableSelect
          value={productId}
          onValueChange={onProductChange}
          options={testOptions}
          placeholder="All tests"
          searchPlaceholder="Search tests..."
          emptyText="No tests found."
          ariaLabel="Filter by test"
          className={triggerClassName}
        />
      </div>
    </>
  );
}
