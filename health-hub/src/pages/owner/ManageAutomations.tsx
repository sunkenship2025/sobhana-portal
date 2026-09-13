/**
 * Admin → Automations.
 *
 * Its own place, not a tab inside Config Center: Config Center is things you set once,
 * this is something you operate. Templates and Offers sit behind Automations in the tab
 * order because they are resources a journey USES, not peers of it.
 */
import { lazy, Suspense, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingState } from '@/components/ui/loading-state';
import { AutomationsList } from './automations/AutomationsList';
import { CreateAutomation } from './automations/CreateAutomation';

const AutomationDetail = lazy(() =>
  import('./automations/AutomationDetail').then((m) => ({ default: m.AutomationDetail })));
const TemplatesTab = lazy(() =>
  import('./automations/TemplatesTab').then((m) => ({ default: m.TemplatesTab })));
const OffersTab = lazy(() =>
  import('./automations/OffersTab').then((m) => ({ default: m.OffersTab })));
const ActivityTab = lazy(() =>
  import('./automations/ActivityTab').then((m) => ({ default: m.ActivityTab })));

export default function ManageAutomations() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'automations';
  const openId = params.get('id');
  const [creating, setCreating] = useState(false);

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null ? p.delete(k) : p.set(k, v)));
    setParams(p);
  };

  return (
    <AppLayout context="owner">
      <div className="mx-auto max-w-7xl animate-fade-in space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Follow-ups, reminders and reports that go out on their own. Journeys decide who and
            when; templates decide how it reads; offers decide what they get.
          </p>
        </div>

        {openId ? (
          <Suspense fallback={<LoadingState />}>
            <AutomationDetail id={openId} onBack={() => go({ id: null })} />
          </Suspense>
        ) : (
          <Tabs value={tab} onValueChange={(v) => go({ tab: v })}>
            <TabsList>
              <TabsTrigger value="automations">Automations</TabsTrigger>
              <TabsTrigger value="templates">Templates</TabsTrigger>
              <TabsTrigger value="offers">Offers</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="automations" className="mt-4">
              <AutomationsList
                onOpen={(id) => go({ id })}
                onCreate={() => setCreating(true)}
              />
              <CreateAutomation
                open={creating}
                onClose={() => setCreating(false)}
                onCreated={(id) => { setCreating(false); go({ id }); }}
              />
            </TabsContent>

            <TabsContent value="templates" className="mt-4">
              <Suspense fallback={<LoadingState />}><TemplatesTab /></Suspense>
            </TabsContent>
            <TabsContent value="offers" className="mt-4">
              <Suspense fallback={<LoadingState />}><OffersTab /></Suspense>
            </TabsContent>
            <TabsContent value="activity" className="mt-4">
              <Suspense fallback={<LoadingState />}><ActivityTab /></Suspense>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
