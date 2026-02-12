import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { useEffect } from "react";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
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
import ManageDoctors from "./pages/owner/ManageDoctors";
import ManageClinicDoctors from "./pages/owner/ManageClinicDoctors";
import ManageTests from "./pages/owner/ManageTests";
import PayoutsList from "./pages/owner/PayoutsList";
import PayoutDetail from "./pages/owner/PayoutDetail";
import BillPrintPage from "./pages/BillPrintPage";
import ReportViewPage from "./pages/ReportViewPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function AppRoutes() {
  const { isAuthenticated, checkTokenExpiration } = useAuthStore();

  // Check token expiration on app load and periodically
  useEffect(() => {
    // Check immediately on load
    checkTokenExpiration();
    
    // Check every 60 seconds
    const interval = setInterval(() => {
      checkTokenExpiration();
    }, 60000);
    
    return () => clearInterval(interval);
  }, [checkTokenExpiration]);

  return (
    <Routes>
      <Route 
        path="/login" 
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} 
      />
      
      {/* Staff & Owner routes */}
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
      
      {/* Owner only */}
      <Route path="/owner" element={
        <ProtectedRoute allowedRoles={['owner']}>
          <OwnerDashboard />
        </ProtectedRoute>
      } />
      <Route path="/owner/doctors" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <ManageDoctors />
        </ProtectedRoute>
      } />
      <Route path="/owner/clinic-doctors" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <ManageClinicDoctors />
        </ProtectedRoute>
      } />
      <Route path="/owner/tests" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <ManageTests />
        </ProtectedRoute>
      } />
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
      <Route path="/bill/print/:domain/:visitId" element={
        <ProtectedRoute allowedRoles={['staff', 'owner']}>
          <BillPrintPage />
        </ProtectedRoute>
      } />
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
