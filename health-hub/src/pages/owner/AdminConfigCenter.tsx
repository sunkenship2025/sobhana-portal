import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const ManageTestsV2 = lazy(() => import('./ManageTestsV2'));
const ManageDepartments = lazy(() => import('./ManageDepartments'));
const ManageSigningDoctors = lazy(() => import('./ManageSigningDoctors'));
const ManageInterpretations = lazy(() => import('./ManageInterpretations'));
const ManageStock = lazy(() => import('./ManageStock'));
const ManageDiagnosticCenters = lazy(() => import('./ManageDiagnosticCenters'));

const TABS = [
  { value: 'tests', label: 'Tests & Panels' },
  { value: 'departments', label: 'Departments' },
  { value: 'signing', label: 'Signing' },
  { value: 'interpretations', label: 'Interpretations' },
  { value: 'stock', label: 'Stock' },
  { value: 'centers', label: 'Diagnostic Centers' },
] as const;

export default function AdminConfigCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'tests';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <AppLayout context="owner">
      <div className="max-w-7xl mx-auto space-y-6 animate-fade-in">
        <h1 className="text-2xl font-bold">Admin Config Center</h1>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="flex-wrap">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="tests">
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading...</div>}>
              <ManageTestsV2 />
            </Suspense>
          </TabsContent>

          <TabsContent value="departments">
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading...</div>}>
              <ManageDepartments />
            </Suspense>
          </TabsContent>

          <TabsContent value="signing">
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading...</div>}>
              <ManageSigningDoctors />
            </Suspense>
          </TabsContent>

          <TabsContent value="interpretations">
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading...</div>}>
              <ManageInterpretations />
            </Suspense>
          </TabsContent>

          <TabsContent value="stock">
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading...</div>}>
              <ManageStock />
            </Suspense>
          </TabsContent>

          <TabsContent value="centers">
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground">Loading...</div>}>
              <ManageDiagnosticCenters />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
