import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Branch } from '@/types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

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
          const response = await fetch(`${API_BASE}/api/branches`, {
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
