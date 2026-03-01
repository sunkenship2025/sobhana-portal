import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  FlaskConical, LayoutGrid, Package, Building2, UserCheck, Users,
} from 'lucide-react';

const ManageDepartments = lazy(() => import('./ManageDepartments'));
const ManageSigningDoctors = lazy(() => import('./ManageSigningDoctors'));
const ManageDoctorsAndReferrals = lazy(() => import('./ManageDoctorsAndReferrals'));
const ManageClinicalDefinitions = lazy(() => import('./ManageClinicalDefinitions'));
const ManagePanelDefinitions = lazy(() => import('./ManagePanelDefinitions'));
const ManageBillableProducts = lazy(() => import('./ManageBillableProducts'));

const TABS = [
  { value: 'clinical-defs', label: 'Clinical Definitions', icon: FlaskConical },
  { value: 'panels', label: 'Panel Definitions', icon: LayoutGrid },
  { value: 'products', label: 'Billable Products', icon: Package },
  { value: 'departments', label: 'Departments', icon: Building2 },
  { value: 'signing', label: 'Signing Doctors', icon: UserCheck },
  { value: 'referrals', label: 'Referrals', icon: Users },
] as const;

const Loading = () => (
  <div className="py-12 text-center text-muted-foreground">Loading...</div>
);

export default function AdminConfigCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'clinical-defs';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

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
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="clinical-defs">
            <Suspense fallback={<Loading />}>
              <ManageClinicalDefinitions />
            </Suspense>
          </TabsContent>

          <TabsContent value="panels">
            <Suspense fallback={<Loading />}>
              <ManagePanelDefinitions />
            </Suspense>
          </TabsContent>

          <TabsContent value="products">
            <Suspense fallback={<Loading />}>
              <ManageBillableProducts />
            </Suspense>
          </TabsContent>

          <TabsContent value="departments">
            <Suspense fallback={<Loading />}>
              <ManageDepartments />
            </Suspense>
          </TabsContent>

          <TabsContent value="signing">
            <Suspense fallback={<Loading />}>
              <ManageSigningDoctors />
            </Suspense>
          </TabsContent>

          <TabsContent value="referrals">
            <Suspense fallback={<Loading />}>
              <ManageDoctorsAndReferrals />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
