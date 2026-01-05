import { Building2, ChevronDown } from 'lucide-react';
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
  const { activeBranchId, branches, setActiveBranch, getActiveBranch } = useBranchStore();
  
  const activeBranch = getActiveBranch();
  
  // Doctors cannot switch branches
  const canSwitchBranch = user?.role === 'staff' || user?.role === 'owner';
  
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
