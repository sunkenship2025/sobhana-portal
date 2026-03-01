import { useBranchStore } from '@/store/branchStore';
import { BranchSelector } from './BranchSelector';

export function ContextBanner() {
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();
  
  return (
    <div className="context-banner flex items-center justify-between">
      <div className="flex items-center gap-4">
        <div>
          <span className="font-semibold">Branch:</span>{' '}
          <span className="opacity-90">{activeBranch?.name || 'Not Selected'}</span>
        </div>
      </div>
      <BranchSelector />
    </div>
  );
}
