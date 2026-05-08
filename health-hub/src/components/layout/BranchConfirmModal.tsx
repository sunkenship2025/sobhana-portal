import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Loader2 } from 'lucide-react';
import { useBranchStore } from '@/store/branchStore';
import { getBranchTheme } from '@/lib/branchTheme';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

interface BranchConfirmModalProps {
  open: boolean;
  onConfirm: () => void;
}

/**
 * Post-login branch confirmation dialog.
 *
 * Shows after staff/owner login. Pre-selects the last used branch from
 * persisted state so the user can usually just click Continue. Calling
 * setActiveBranch + queryClient.clear() is mandatory per branchStore.ts —
 * stale TanStack data from a different branch must be flushed.
 */
export function BranchConfirmModal({ open, onConfirm }: BranchConfirmModalProps) {
  const queryClient = useQueryClient();
  const { branches, activeBranchId, fetchBranches, setActiveBranch, isLoading } =
    useBranchStore();

  const activeBranches = branches.filter((b) => b.isActive);
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    if (open && branches.length === 0 && !isLoading) {
      fetchBranches();
    }
  }, [open, branches.length, isLoading, fetchBranches]);

  // Seed the dropdown: previously-used branch wins, otherwise first available.
  // Deps deliberately exclude `activeBranches` — it's a new array reference on
  // every render (filtered inline), which would re-fire this effect after the
  // user picks a different branch and reset the selection back to the store's
  // activeBranchId. Re-seed only when the modal opens or branches finish loading.
  useEffect(() => {
    if (!open) return;
    if (activeBranches.length === 0) return;
    const remembered = activeBranches.find((b) => b.id === activeBranchId);
    setSelectedId(remembered ? remembered.id : activeBranches[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branches.length]);

  const handleConfirm = () => {
    if (!selectedId) return;
    if (selectedId !== activeBranchId) {
      setActiveBranch(selectedId);
      queryClient.clear();
    }
    onConfirm();
  };

  const selected = activeBranches.find((b) => b.id === selectedId);
  const accent = selected ? getBranchTheme(selected.code).accent : '#1B2B58';

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-md [&>button.absolute]:hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${accent}1a`, color: accent }}
            >
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold text-[#1B2B58]">
                Confirm Branch
              </DialogTitle>
              <DialogDescription className="text-sm text-gray-500">
                Choose the branch you want to work in.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="py-2">
          {isLoading && activeBranches.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border bg-gray-50 px-3 py-3 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading branches…
            </div>
          ) : (
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger className="h-12">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {activeBranches.map((branch) => {
                  const theme = getBranchTheme(branch.code);
                  return (
                    <SelectItem key={branch.id} value={branch.id}>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: theme.accent }}
                        />
                        <span className="font-medium">{branch.name}</span>
                        {branch.address && (
                          <span className="text-xs text-muted-foreground">
                            · {branch.address}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>

        <Button
          type="button"
          onClick={handleConfirm}
          disabled={!selectedId || isLoading}
          className="w-full bg-[#D91C2B] py-3 text-sm font-bold uppercase tracking-wide text-white shadow-lg shadow-red-500/30 hover:bg-red-700 disabled:opacity-50"
        >
          Continue
        </Button>
      </DialogContent>
    </Dialog>
  );
}
