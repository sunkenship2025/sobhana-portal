import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Branch } from '@/types';

// ============================================
// SAMPLE BRANCHES
// ============================================
const SAMPLE_BRANCHES: Branch[] = [
  {
    id: 'branch-1',
    name: 'Sobhana – Madhapur',
    code: 'MPR',
    address: '123 Madhapur Main Road, Hyderabad',
    phone: '040-12345678',
    isActive: true,
    createdAt: new Date(),
  },
  {
    id: 'branch-2',
    name: 'Sobhana – Kukatpally',
    code: 'KPY',
    address: '456 Kukatpally Housing Board, Hyderabad',
    phone: '040-87654321',
    isActive: true,
    createdAt: new Date(),
  },
];

// ============================================
// BRANCH STORE INTERFACE
// ============================================
interface BranchState {
  branches: Branch[];
  activeBranchId: string | null;
  
  // Getters
  getActiveBranch: () => Branch | undefined;
  getBranchById: (id: string) => Branch | undefined;
  getAllBranches: () => Branch[];
  
  // Setters
  setActiveBranch: (branchId: string) => void;
  
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
      branches: SAMPLE_BRANCHES,
      activeBranchId: 'branch-1', // Default to first branch
      
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
