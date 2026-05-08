import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
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
import GlobalPatientSearch from "./pages/clinic/GlobalPatientSearch";
import Patient360 from "./pages/clinic/Patient360";
import DoctorDashboard from "./pages/doctor/DoctorDashboard";
import OwnerDashboard from "./pages/owner/OwnerDashboard";
import OwnerDashboardV2 from "./pages/owner/OwnerDashboardV2";
import OwnerMoneyPage from "./pages/owner/OwnerMoneyPage";
import OwnerDoctorsPage from "./pages/owner/OwnerDoctorsPage";
import OwnerOperationsPage from "./pages/owner/OwnerOperationsPage";

import AdminConfigCenter from "./pages/owner/AdminConfigCenter";
import PayoutsList from "./pages/owner/PayoutsList";
import PayoutDetail from "./pages/owner/PayoutDetail";
import BillPrintPage from "./pages/BillPrintPage";
import ReportViewPage from "./pages/ReportViewPage";
import PrivacyPolicy from "./pages/legal/PrivacyPolicy";
import TermsOfService from "./pages/legal/TermsOfService";
import DataDeletion from "./pages/legal/DataDeletion";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

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
            ? <Navigate to={user?.role === 'owner' ? '/owner' : user?.role === 'doctor' ? '/doctor' : '/'} replace />
            : <Login />
        } 
      />
      
      {/* Staff routes */}
      <Route path="/" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <Dashboard />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/new" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <DiagnosticsNewVisit />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/pending" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <DiagnosticsPendingResults />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/finalized" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <DiagnosticsFinalizedReports />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/results/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <DiagnosticsResultEntry />
        </ProtectedRoute>
      } />
      <Route path="/diagnostics/preview/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <DiagnosticsReportPreview />
        </ProtectedRoute>
      } />
      <Route path="/clinic/new" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <ClinicNewVisit />
        </ProtectedRoute>
      } />
      <Route path="/clinic/queue" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <ClinicVisitQueue />
        </ProtectedRoute>
      } />
      <Route path="/clinic/patient-search" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <GlobalPatientSearch />
        </ProtectedRoute>
      } />
      <Route path="/clinic/patient-360/:patientId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <Patient360 />
        </ProtectedRoute>
      } />
      
      {/* Doctor & Owner routes */}
      <Route path="/doctor" element={
        <ProtectedRoute allowedRoles={['doctor', 'owner']}>
          <DoctorDashboard />
        </ProtectedRoute>
      } />
      
      {/* Owner only — new decision-first dashboard at /owner; legacy preserved at /owner/legacy */}
      <Route path="/owner" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerDashboardV2 />
        </ProtectedRoute>
      } />
      <Route path="/owner/legacy" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerDashboard />
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
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerOperationsPage />
        </ProtectedRoute>
      } />
      <Route path="/ops/pending" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerOperationsPage />
        </ProtectedRoute>
      } />
      <Route path="/ops/audit" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerOperationsPage />
        </ProtectedRoute>
      } />
      <Route path="/owner/doctors" element={<Navigate to="/owner/config?tab=referrals" replace />} />
      <Route path="/owner/clinic-doctors" element={<Navigate to="/owner/config?tab=referrals" replace />} />
      <Route path="/owner/config" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <AdminConfigCenter />
        </ProtectedRoute>
      } />
      <Route path="/owner/tests" element={<Navigate to="/owner/config?tab=clinical-defs" replace />} />
      <Route path="/owner/payouts" element={
        <ProtectedRoute allowedRoles={['owner', 'staff']}>
          <PayoutsList />
        </ProtectedRoute>
      } />
      <Route path="/owner/payouts/:id" element={
        <ProtectedRoute allowedRoles={['owner', 'staff']}>
          <PayoutDetail />
        </ProtectedRoute>
      } />
      
      {/* Public routes for secure document access */}
      <Route path="/report/view" element={<ReportViewPage />} />
      
      {/* Legal / compliance pages (public) */}
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/data-deletion" element={<DataDeletion />} />
      <Route path="/bill/print/:domain/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <BillPrintPage />
        </ProtectedRoute>
      } />
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function AppShell() {
  return (
    <>
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
