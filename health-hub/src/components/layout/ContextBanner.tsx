import { useBranchStore } from '@/store/branchStore';
import { BranchSelector } from './BranchSelector';

export function ContextBanner() {
  const activeBranchId = useBranchStore((state) => state.activeBranchId);
  const branches = useBranchStore((state) => state.branches);
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  const activeBranch = getActiveBranch();
  
  return (
    <div className="context-banner flex flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold shrink-0">Branch:</span>
          <span className="min-w-0 truncate opacity-90">{activeBranch?.name || 'Not Selected'}</span>
        </div>
      </div>
      <div className="w-full sm:w-auto">
        <BranchSelector />
      </div>
    </div>
  );
}
