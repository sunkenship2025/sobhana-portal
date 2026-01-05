import { Sidebar } from './Sidebar';
import { ContextBanner } from './ContextBanner';
import type { AppContext } from '@/types';

interface AppLayoutProps {
  children: React.ReactNode;
  context: AppContext;
  subContext?: string;
}

export function AppLayout({ children, context, subContext }: AppLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="ml-64">
        <ContextBanner context={context} subContext={subContext} />
        <div className="p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
