import { useEffect } from 'react';
import { Building2, ChevronDown, Loader2 } from 'lucide-react';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function BranchSelector() {
  const { user } = useAuthStore();
  const { activeBranchId, branches, setActiveBranch, getActiveBranch, fetchBranches, isLoading } = useBranchStore();
  
  const activeBranch = getActiveBranch();
  
  // Fetch branches on mount if not already loaded
  useEffect(() => {
    if (branches.length === 0 && !isLoading) {
      fetchBranches();
    }
  }, [branches.length, isLoading, fetchBranches]);
  
  // Doctors cannot switch branches
  const canSwitchBranch = user?.role === 'staff' || user?.role === 'owner';
  
  // Show loading state
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg border">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading branches...</span>
      </div>
    );
  }
  
  // If no active branch selected yet but branches are loaded, show selection prompt
  if (!activeBranch && branches.length > 0 && canSwitchBranch) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="outline" 
            className="flex items-center gap-2 bg-background/80 backdrop-blur-sm border-orange-500"
          >
            <Building2 className="h-4 w-4" />
            <span className="font-medium">Select Branch</span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {branches
            .filter((b) => b.isActive)
            .map((branch) => (
              <DropdownMenuItem
                key={branch.id}
                onClick={() => setActiveBranch(branch.id)}
                className="flex items-center gap-2 cursor-pointer"
              >
                <Building2 className="h-4 w-4" />
                <div className="flex flex-col">
                  <span className="font-medium">{branch.name}</span>
                  {branch.address && (
                    <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                      {branch.address}
                    </span>
                  )}
                </div>
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  
  // If still no branch after loading, return null
  if (!activeBranch) return null;
  
  if (!canSwitchBranch) {
    // Show branch name only for doctors
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg border">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{activeBranch.name}</span>
      </div>
    );
  }
  
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          className="flex items-center gap-2 bg-background/80 backdrop-blur-sm"
        >
          <Building2 className="h-4 w-4" />
          <span className="font-medium">{activeBranch.name}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {branches
          .filter((b) => b.isActive)
          .map((branch) => (
            <DropdownMenuItem
              key={branch.id}
              onClick={() => setActiveBranch(branch.id)}
              className={cn(
                'flex items-center gap-2 cursor-pointer',
                branch.id === activeBranchId && 'bg-accent'
              )}
            >
              <Building2 className="h-4 w-4" />
              <div className="flex flex-col">
                <span className="font-medium">{branch.name}</span>
                {branch.address && (
                  <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                    {branch.address}
                  </span>
                )}
              </div>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
