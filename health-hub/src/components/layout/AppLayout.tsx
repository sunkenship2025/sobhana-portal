import { Sidebar } from './Sidebar';
import { ContextBanner } from './ContextBanner';
import type { AppContext } from '@/types';
import { useBranchStore } from '@/store/branchStore';
import { getBranchCSSVars } from '@/lib/branchTheme';

interface AppLayoutProps {
  children: React.ReactNode;
  context: AppContext;
  subContext?: string;
}

export function AppLayout({ children, context, subContext }: AppLayoutProps) {
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();
  const branchVars = getBranchCSSVars(activeBranch?.code);

  return (
    <div className="min-h-screen bg-background" style={branchVars as React.CSSProperties}>
      <Sidebar />
      <main className="ml-64">
        <ContextBanner />
        <div className="p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
