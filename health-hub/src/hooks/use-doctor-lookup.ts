import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";

export interface DoctorByContact {
  clinicDoctor?: unknown;
  referralDoctor?: unknown;
}

const DOCTOR_BY_CONTACT_KEY = "doctorByContact";
// Same names the server pushes on /api/events (and the same endpoints as
// `qk.clinicDoctors` / `qk.referralDoctors`), so an edit on another device
// invalidates these too instead of leaving them stale for 5 minutes.
const CLINIC_DOCTORS_LIST_KEY = "clinic-doctors";
const REFERRAL_DOCTORS_LIST_KEY = "referral-doctors";

/**
 * Shared, cached doctor lookups for the doctor-management forms.
 *
 * Both the "is this phone already a doctor?" check and the name duplicate
 * check used to hit the network on every keystroke — the name check even
 * re-downloaded the whole clinic-doctor list each time. Routing them through
 * React Query dedupes concurrent calls and serves repeats from cache, so the
 * list is fetched once per session and phone checks reuse their result.
 *
 * Call `invalidateDoctorLookups()` after any doctor create/update/delete so the
 * cached results refresh.
 */
export function useDoctorLookup() {
  const queryClient = useQueryClient();
  const { token } = useAuthStore();

  // search-by-contact, deduped + cached by phone.
  const lookupDoctorByPhone = async (
    phone: string,
  ): Promise<DoctorByContact> => {
    if (phone.length < 10 || !token) return {};
    try {
      return await queryClient.fetchQuery<DoctorByContact>({
        queryKey: [DOCTOR_BY_CONTACT_KEY, phone],
        queryFn: async ({ signal }) => {
          const res = await fetch(
            `${API_BASE}/doctors/search-by-contact?phone=${phone}`,
            { headers: { Authorization: `Bearer ${token}` }, signal },
          );
          if (!res.ok) throw new Error("Doctor lookup failed");
          return res.json();
        },
        staleTime: 30_000,
        retry: 1,
      });
    } catch (err) {
      console.error("Error checking doctor:", err);
      return {};
    }
  };

  // Full clinic-doctor list, fetched once and cached for client-side matching.
  const getClinicDoctors = async (): Promise<unknown[]> => {
    if (!token) return [];
    try {
      return await queryClient.fetchQuery<unknown[]>({
        queryKey: [CLINIC_DOCTORS_LIST_KEY],
        queryFn: async ({ signal }) => {
          const res = await fetch(`${API_BASE}/clinic-doctors`, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
          });
          if (!res.ok) throw new Error("Failed to fetch clinic doctors");
          return res.json();
        },
        staleTime: 5 * 60_000,
        retry: 1,
      });
    } catch (err) {
      console.error("Error fetching clinic doctors:", err);
      return [];
    }
  };

  // Full referral-doctor list, fetched once and cached for client-side matching.
  const getReferralDoctors = async (): Promise<unknown[]> => {
    if (!token) return [];
    try {
      return await queryClient.fetchQuery<unknown[]>({
        queryKey: [REFERRAL_DOCTORS_LIST_KEY],
        queryFn: async ({ signal }) => {
          const res = await fetch(`${API_BASE}/referral-doctors`, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
          });
          if (!res.ok) throw new Error("Failed to fetch referral doctors");
          return res.json();
        },
        staleTime: 5 * 60_000,
        retry: 1,
      });
    } catch (err) {
      console.error("Error fetching referral doctors:", err);
      return [];
    }
  };

  // Call after any doctor create/update/delete so cached lookups refresh.
  const invalidateDoctorLookups = () => {
    queryClient.invalidateQueries({ queryKey: [DOCTOR_BY_CONTACT_KEY] });
    queryClient.invalidateQueries({ queryKey: [CLINIC_DOCTORS_LIST_KEY] });
    queryClient.invalidateQueries({ queryKey: [REFERRAL_DOCTORS_LIST_KEY] });
  };

  return {
    lookupDoctorByPhone,
    getClinicDoctors,
    getReferralDoctors,
    invalidateDoctorLookups,
  };
}
