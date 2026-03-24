import { Sidebar } from './Sidebar';
import { ContextBanner } from './ContextBanner';
import type { AppContext } from '@/types';
import { useBranchStore } from '@/store/branchStore';
import { getBranchCSSVars } from '@/lib/branchTheme';

interface AppLayoutProps {
  children: React.ReactNode;
  context: AppContext;
  subContext?: string;
  hideContextBanner?: boolean;
}

export function AppLayout({ children, context, subContext, hideContextBanner = false }: AppLayoutProps) {
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();
  const branchVars = getBranchCSSVars(activeBranch?.code);

  return (
    <div className="min-h-screen bg-background" style={branchVars as React.CSSProperties}>
      <Sidebar />
      <main className="min-h-screen md:ml-64">
        {!hideContextBanner && <ContextBanner />}
        <div className="px-4 py-4 sm:px-6 sm:py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
