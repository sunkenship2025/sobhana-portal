import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { API_BASE } from "@/lib/api";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore, defaultRouteForRole } from "./store/authStore";
import { useEffect } from "react";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import { BranchConfirmModal } from "./components/layout/BranchConfirmModal";
import { useBranchStore } from "./store/branchStore";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import DiagnosticsNewVisit from "./pages/diagnostics/DiagnosticsNewVisit";
import DiagnosticsPendingResults from "./pages/diagnostics/DiagnosticsPendingResults";
import DiagnosticsFinalizedReports from "./pages/diagnostics/DiagnosticsFinalizedReports";
import DiagnosticsResultEntry from "./pages/diagnostics/DiagnosticsResultEntry";
import DiagnosticsReportPreview from "./pages/diagnostics/DiagnosticsReportPreview";
import ClinicNewVisit from "./pages/clinic/ClinicNewVisit";
import ClinicVisitQueue from "./pages/clinic/ClinicVisitQueue";
import ClinicFinalizedVisits from "./pages/clinic/ClinicFinalizedVisits";
import GlobalPatientSearch from "./pages/clinic/GlobalPatientSearch";
import Patient360 from "./pages/clinic/Patient360";
import OwnerDashboardV2 from "./pages/owner/OwnerDashboardV2";
import OwnerMoneyPage from "./pages/owner/OwnerMoneyPage";
import OwnerDoctorsPage from "./pages/owner/OwnerDoctorsPage";
import OwnerOperationsPage from "./pages/owner/OwnerOperationsPage";
import OwnerAuditPage from "./pages/owner/OwnerAuditPage";
import MessagesInbox from "./pages/messages/MessagesInbox";

import AdminConfigCenter from "./pages/owner/AdminConfigCenter";
import PayoutsList from "./pages/owner/PayoutsList";
import PayoutStatement from "./pages/owner/PayoutStatement";
import OutsideLabs from "./pages/owner/OutsideLabs";
import BillPrintPage from "./pages/BillPrintPage";
import PrescriptionPrintPage from "./pages/PrescriptionPrintPage";
import ReportViewPage from "./pages/ReportViewPage";
import WaitingRoomDisplay from "./pages/display/WaitingRoomDisplay";
import TrackToken from "./pages/display/TrackToken";
import PrivacyPolicy from "./pages/legal/PrivacyPolicy";
import TermsOfService from "./pages/legal/TermsOfService";
import DataDeletion from "./pages/legal/DataDeletion";
import NotFound from "./pages/NotFound";

/**
 * Mounted globally so the post-login branch picker survives the navigation
 * from /login → /, /owner, etc. (Putting it inside Login.tsx unmounts it the
 * moment isAuthenticated flips and the route redirects away.)
 */
function GlobalBranchConfirmGate() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const awaiting = useBranchStore((s) => s.awaitingBranchConfirm);
  const setAwaiting = useBranchStore((s) => s.setAwaitingBranchConfirm);
  const open = isAuthenticated && awaiting;
  return <BranchConfirmModal open={open} onConfirm={() => setAwaiting(false)} />;
}

function AppRoutes() {
  const {
    isAuthenticated,
    user,
    token,
    isHydrating,
    checkTokenExpiration,
    hydrateFromCookie,
  } = useAuthStore();

  // On app boot, restore the in-memory token from the httpOnly cookie if the
  // persisted state says we were logged in. The token isn't stored in
  // localStorage anymore (XSS hardening), so a page refresh leaves the
  // user/isAuthenticated flags but no token; /api/auth/me re-issues it from
  // the cookie if it's still valid.
  useEffect(() => {
    if (isAuthenticated && !token && !isHydrating) {
      void hydrateFromCookie();
    }
  }, [isAuthenticated, token, isHydrating, hydrateFromCookie]);

  // Check token expiration on app load and periodically
  useEffect(() => {
    checkTokenExpiration();
    const interval = setInterval(() => {
      checkTokenExpiration();
    }, 60000);
    return () => clearInterval(interval);
  }, [checkTokenExpiration]);

  return (
    <Routes>
      <Route 
        path="/login" 
        element={
          isAuthenticated
            ? <Navigate to={defaultRouteForRole(user?.role)} replace />
            : <Login />
        } 
      />
      
      {/* Staff routes */}
      <Route path="/" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <Dashboard />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/new" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <DiagnosticsNewVisit />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/pending" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <DiagnosticsPendingResults />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/finalized" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <DiagnosticsFinalizedReports />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/results/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <DiagnosticsResultEntry />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/preview/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <DiagnosticsReportPreview />
        </ProtectedRoute>
      } />
      <Route path="/clinic/new" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <ClinicNewVisit />
        </ProtectedRoute>
      } />
      <Route path="/clinic/queue" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <ClinicVisitQueue />
        </ProtectedRoute>
      } />
      <Route path="/clinic/finalized" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <ClinicFinalizedVisits />
        </ProtectedRoute>
      } />
      <Route path="/clinic/patient-search" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <GlobalPatientSearch />
        </ProtectedRoute>
      } />
      <Route path="/clinic/patient-360/:patientId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <Patient360 />
        </ProtectedRoute>
      } />
      
      {/* Owner only — decision-first dashboard */}
      <Route path="/owner" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerDashboardV2 />
        </ProtectedRoute>
      } />
      <Route path="/money/bills" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerMoneyPage />
        </ProtectedRoute>
      } />
      <Route path="/money/cash" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerMoneyPage />
        </ProtectedRoute>
      } />
      <Route path="/money/discounts" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerMoneyPage />
        </ProtectedRoute>
      } />
      <Route path="/people/doctors" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerDoctorsPage />
        </ProtectedRoute>
      } />
      <Route path="/people/doctors/:id" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerDoctorsPage />
        </ProtectedRoute>
      } />
      <Route path="/ops/queue" element={
        <ProtectedRoute allowedRoles={['owner', 'lab_incharge']}>
          <OwnerOperationsPage />
        </ProtectedRoute>
      } />
      <Route path="/ops/pending" element={
        <ProtectedRoute allowedRoles={['owner', 'lab_incharge']}>
          <OwnerOperationsPage />
        </ProtectedRoute>
      } />
      <Route path="/ops/audit" element={
        <ProtectedRoute allowedRoles={['owner', 'lab_incharge']}>
          <OwnerAuditPage />
        </ProtectedRoute>
      } />
      <Route path="/messages" element={
        <ProtectedRoute allowedRoles={['owner', 'lab_incharge', 'staff']}>
          <MessagesInbox />
        </ProtectedRoute>
      } />
      <Route path="/owner/doctors" element={<Navigate to="/owner/config?tab=referrals" replace />} />
      <Route path="/owner/clinic-doctors" element={<Navigate to="/owner/config?tab=referrals" replace />} />
      <Route path="/owner/config" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge', 'sales']}>
          <AdminConfigCenter />
        </ProtectedRoute>
      } />
      <Route path="/owner/tests" element={<Navigate to="/owner/config?tab=clinical-defs" replace />} />
      <Route path="/owner/report-builder" element={<Navigate to="/owner/config?tab=report-builder" replace />} />
      <Route path="/owner/payouts" element={
        <ProtectedRoute allowedRoles={['owner', 'staff', 'lab_incharge', 'sales']}>
          <PayoutsList />
        </ProtectedRoute>
      } />
      <Route path="/owner/payouts/labs" element={
        <ProtectedRoute allowedRoles={['owner', 'staff', 'lab_incharge', 'sales']}>
          <OutsideLabs />
        </ProtectedRoute>
      } />
      <Route path="/owner/payouts/:id" element={
        <ProtectedRoute allowedRoles={['owner', 'staff', 'lab_incharge', 'sales']}>
          <PayoutStatement />
        </ProtectedRoute>
      } />
      
      {/* Public routes for secure document access */}
      <Route path="/report/view" element={<ReportViewPage />} />

      {/* Public fullscreen waiting-room TV — readable link e.g. /display/chintal/op (kiosk, no login) */}
      <Route path="/display/:branch/:screen" element={<WaitingRoomDisplay />} />
      {/* Public mobile companion — patient scans the ticker QR to track their token */}
      <Route path="/track/:branch/:screen" element={<TrackToken />} />
      
      {/* Legal / compliance pages (public) */}
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/data-deletion" element={<DataDeletion />} />
      <Route path="/bill/print/:domain/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <BillPrintPage />
        </ProtectedRoute>
      } />
      <Route path="/prescription/print/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner', 'lab_incharge']}>
          <PrescriptionPrintPage />
        </ProtectedRoute>
      } />
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * Cross-device cache freshness. Holds one public SSE per active branch; when any
 * reference catalog (price list, dropdowns, definitions) is edited on ANY device,
 * the server pushes {"catalog":"<name>"} and we invalidate that cached list so
 * every open tab refetches within ~1s. The query staleTime is the backstop for
 * when this stream is blocked or dropped. Reconnects on branch switch (which also
 * clears the cache). Only runs while logged in with a branch selected.
 */
function CatalogSync() {
  const token = useAuthStore((s) => s.token);
  const branchId = useBranchStore((s) => s.activeBranchId);
  useEffect(() => {
    if (!token || !branchId) return;
    const es = new EventSource(`${API_BASE}/events/${branchId}/catalog-stream`);
    es.onmessage = (e) => {
      try {
        const { catalog } = JSON.parse(e.data) as { catalog?: string };
        // Prefix match: invalidates ["billable-products", <branch>] and any
        // branchless variant of the same catalog.
        if (catalog) queryClient.invalidateQueries({ queryKey: [catalog] });
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, [token, branchId]);
  return null;
}

function AppShell() {
  return (
    <>
      <CatalogSync />
      <GlobalBranchConfirmGate />
      <AppRoutes />
    </>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
