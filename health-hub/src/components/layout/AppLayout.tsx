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
  const activeBranchId = useBranchStore((state) => state.activeBranchId);
  const branches = useBranchStore((state) => state.branches);
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  
  const activeBranch = getActiveBranch();
  const branchVars = getBranchCSSVars(activeBranch?.code);

  return (
    <div className="min-h-screen print:min-h-0 bg-background" style={branchVars as React.CSSProperties}>
      <div className="print:hidden">
        <Sidebar />
      </div>
      <main className="min-h-screen md:ml-64 print:m-0 print:min-h-0">
        {!hideContextBanner && (
          <div className="print:hidden">
            <ContextBanner />
          </div>
        )}
        <div className="px-4 py-4 sm:px-6 sm:py-6 print:p-0">
          {children}
        </div>
      </main>
    </div>
  );
}
