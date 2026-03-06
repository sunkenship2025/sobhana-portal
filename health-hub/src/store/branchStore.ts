/**
 * Branch Store — Zustand
 *
 * Tracks the list of available branches and which one is currently active.
 * The active branch ID is sent with every API request as the `X-Branch-Id`
 * header (injected by each fetch call using `localStorage.getItem('authToken')`).
 *
 * Persisted to localStorage so branch selection survives page refresh.
 *
 * IMPORTANT: When the user switches branches, call `queryClient.clear()`
 * to flush TanStack Query's cache — otherwise stale data from the old
 * branch may be displayed.
 *
 * @example
 *   const { activeBranchId, setActiveBranch } = useBranchStore();
 *   const activeBranch = useBranchStore(state => state.getActiveBranch());
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Branch } from '@/types';
import { API_BASE } from '@/lib/api';

// ============================================
// BRANCH STORE INTERFACE
// ============================================
interface BranchState {
  branches: Branch[];
  activeBranchId: string | null;
  isLoading: boolean;
  
  // Getters
  getActiveBranch: () => Branch | undefined;
  getBranchById: (id: string) => Branch | undefined;
  getAllBranches: () => Branch[];
  
  // Setters
  setActiveBranch: (branchId: string) => void;
  setBranches: (branches: Branch[]) => void;
  
  // Actions
  fetchBranches: () => Promise<void>;
  
  // CRUD
  addBranch: (branch: Branch) => void;
  updateBranch: (id: string, updates: Partial<Branch>) => void;
}

// ============================================
// BRANCH STORE IMPLEMENTATION
// ============================================
export const useBranchStore = create<BranchState>()(
  persist(
    (set, get) => ({
      branches: [],
      activeBranchId: null,
      isLoading: false,
      
      getActiveBranch: () => {
        const { branches, activeBranchId } = get();
        return branches.find((b) => b.id === activeBranchId);
      },
      
      getBranchById: (id) => {
        const { branches } = get();
        return branches.find((b) => b.id === id);
      },
      
      getAllBranches: () => {
        const { branches } = get();
        return branches.filter((b) => b.isActive);
      },
      
      setActiveBranch: (branchId) => {
        set({ activeBranchId: branchId });
      },
      
      setBranches: (branches) => {
        set({ branches });
      },
      
      fetchBranches: async () => {
        const token = localStorage.getItem('authToken');
        if (!token) return;
        
        set({ isLoading: true });
        try {
          const response = await fetch(`${API_BASE}/branches`, {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          });
          
          if (response.ok) {
            const branches = await response.json();
            set({ branches, isLoading: false });
          } else {
            console.error('Failed to fetch branches:', response.statusText);
            set({ isLoading: false });
          }
        } catch (error) {
          console.error('Error fetching branches:', error);
          set({ isLoading: false });
        }
      },
      
      addBranch: (branch) => {
        set((state) => ({ branches: [...state.branches, branch] }));
      },
      
      updateBranch: (id, updates) => {
        set((state) => ({
          branches: state.branches.map((b) =>
            b.id === id ? { ...b, ...updates } : b
          ),
        }));
      },
    }),
    {
      name: 'branch-storage',
    }
  )
);
