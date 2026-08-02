import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LoadingState } from '@/components/ui/loading-state';
import { useAuthStore, UserRole } from '@/store/authStore';
import {
  FlaskConical, LayoutGrid, Package, Building2, UserCheck, Users, ShieldCheck, FileText, Tv,
} from 'lucide-react';

const ManageDepartments = lazy(() => import('./ManageDepartments'));
const ManageDisplayScreens = lazy(() => import('./ManageDisplayScreens'));
const ManageSigningDoctors = lazy(() => import('./ManageSigningDoctors'));
const ManageDoctorsAndReferrals = lazy(() => import('./ManageDoctorsAndReferrals'));
const ManageClinicalDefinitions = lazy(() => import('./ManageClinicalDefinitions'));
const ManagePanelDefinitions = lazy(() => import('./ManagePanelDefinitions'));
const ReportBuilder = lazy(() => import('./ReportBuilder'));
const ManageBillableProducts = lazy(() => import('./ManageBillableProducts'));
const ManageRoles = lazy(() => import('./ManageRoles'));

// Each tab lists the roles that may see it. Staff are scoped to Products +
// Referrals; Sales sees only Referrals; Lab Incharge sees the full clinical
// config; Roles (user management) is owner-only.
const TABS = [
  { value: 'report-builder', label: 'Report Builder', icon: FileText, roles: ['owner', 'lab_incharge'] },
  { value: 'clinical-defs', label: 'Clinical Definitions', icon: FlaskConical, roles: ['owner', 'lab_incharge'] },
  { value: 'panels', label: 'Panel Definitions', icon: LayoutGrid, roles: ['owner', 'lab_incharge'] },
  { value: 'products', label: 'Billable Products', icon: Package, roles: ['owner', 'lab_incharge', 'staff'] },
  { value: 'departments', label: 'Departments', icon: Building2, roles: ['owner', 'lab_incharge'] },
  { value: 'signing', label: 'Signers & Rules', icon: UserCheck, roles: ['owner', 'lab_incharge'] },
  { value: 'referrals', label: 'Referrals', icon: Users, roles: ['owner', 'lab_incharge', 'staff', 'sales'] },
  { value: 'signage', label: 'Waiting Room Display', icon: Tv, roles: ['owner'] },
  { value: 'roles', label: 'Roles', icon: ShieldCheck, roles: ['owner'] },
] as const satisfies readonly { value: string; label: string; icon: unknown; roles: readonly UserRole[] }[];

const Loading = () => <LoadingState />;

export default function AdminConfigCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const role = useAuthStore((s) => s.user?.role);

  // Only tabs this role may access; the first visible one is the fallback so a
  // Sales user hitting /owner/config lands on Referrals, not a hidden tab.
  const visibleTabs = TABS.filter((t) => !role || t.roles.includes(role));
  const requestedTab = searchParams.get('tab');
  const activeTab =
    requestedTab && visibleTabs.some((t) => t.value === requestedTab)
      ? requestedTab
      : visibleTabs[0]?.value ?? 'referrals';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  const canSee = (value: string) => visibleTabs.some((t) => t.value === value);

  return (
    <AppLayout context="owner">
      <div className="max-w-7xl mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">Admin Config Center</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage clinical definitions, panels, products, departments and signing doctors
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="flex-wrap h-auto gap-1 p-1">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {canSee('report-builder') && (
            <TabsContent value="report-builder">
              <Suspense fallback={<Loading />}>
                <ReportBuilder />
              </Suspense>
            </TabsContent>
          )}

          {canSee('clinical-defs') && (
            <TabsContent value="clinical-defs">
              <Suspense fallback={<Loading />}>
                <ManageClinicalDefinitions />
              </Suspense>
            </TabsContent>
          )}

          {canSee('panels') && (
            <TabsContent value="panels">
              <Suspense fallback={<Loading />}>
                <ManagePanelDefinitions />
              </Suspense>
            </TabsContent>
          )}

          {canSee('products') && (
            <TabsContent value="products">
              <Suspense fallback={<Loading />}>
                <ManageBillableProducts />
              </Suspense>
            </TabsContent>
          )}

          {canSee('departments') && (
            <TabsContent value="departments">
              <Suspense fallback={<Loading />}>
                <ManageDepartments />
              </Suspense>
            </TabsContent>
          )}

          {canSee('signing') && (
            <TabsContent value="signing">
              <Suspense fallback={<Loading />}>
                <ManageSigningDoctors />
              </Suspense>
            </TabsContent>
          )}

          {canSee('referrals') && (
            <TabsContent value="referrals">
              <Suspense fallback={<Loading />}>
                <ManageDoctorsAndReferrals />
              </Suspense>
            </TabsContent>
          )}

          {canSee('signage') && (
            <TabsContent value="signage">
              <Suspense fallback={<Loading />}>
                <ManageDisplayScreens />
              </Suspense>
            </TabsContent>
          )}

          {canSee('roles') && (
            <TabsContent value="roles">
              <Suspense fallback={<Loading />}>
                <ManageRoles />
              </Suspense>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </AppLayout>
  );
}
